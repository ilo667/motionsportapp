import { Injectable, Logger, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import {
  bookingGuests,
  bookings,
  cancelRefunds,
  members,
  packageSpends,
  packages,
  purchaseItems,
  trainingDays,
  trainingSlots,
} from '../database/schema';
import { NotificationService } from '../notifications/notification.service';
import { VacancyAlertsService } from '../notifications/vacancy-alerts.service';
import { ClockService } from '../clock/clock.service';
import { GROUP_TYPE, slotStartsAt } from '../schedule/training-types';
import { getMemberTrainerId } from '../schedule/default-trainer';
import { EntitlementsService } from '../purchases/entitlements.service';
import { cancelGuests, findGroupBooking, groupBookingWindow } from './group-booking';
import { loadTrainerSchedule } from '../trainer-schedule/trainer-schedule.store';
import { memberFrozenOn } from '../freezes/freeze.store';
import { cancelFee, halfBack, type CancelFee } from './cancel-fee';

type Db = DatabaseService['db'];
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly notifications: NotificationService,
    private readonly clock: ClockService,
    private readonly vacancyAlerts: VacancyAlertsService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async book(memberId: string, slotId: string) {
    const [slot] = await this.database.db.select().from(trainingSlots).where(eq(trainingSlots.id, slotId)).limit(1);

    if (!slot) throw new NotFoundException('Slot not found');
    if (slot.status !== 'ACTIVE') throw new ConflictException('Slot is cancelled');
    // Assigned trainings are booked only through payment (PaymentService.createCheckout)
    if (slot.trainingType !== GROUP_TYPE) throw new BadRequestException('This slot requires payment');
    // Members book only their own trainer's group trainings
    if (slot.trainerId !== (await getMemberTrainerId(this.database.db, memberId)))
      throw new NotFoundException('Slot not found');

    const [day] = await this.database.db
      .select()
      .from(trainingDays)
      .where(eq(trainingDays.id, slot.trainingDayId))
      .limit(1);

    if (!day || day.status !== 'SCHEDULED') throw new ConflictException('Training day is not scheduled');

    await this.validateBookingWindow(day.localDate, slot.slotTime, slot.trainerId);
    if (await memberFrozenOn(this.database.db, memberId, day.localDate)) {
      throw new ConflictException('Membership frozen');
    }
    // Group trainings are paid: a pass usable that day with a training left (else «Записатися» offers to buy one)
    if ((await this.entitlements.groupPassLeft(memberId, day.localDate)) === 0) {
      throw new ConflictException('Group pass required');
    }

    try {
      await this.database.db.transaction(async (tx) => {
        await this.lockMember(tx, memberId);
        // Again under the member lock: a freeze approved at this moment cancels bookings under the same lock
        if (await memberFrozenOn(tx, memberId, day.localDate)) throw new ConflictException('Membership frozen');

        const [locked] = await tx
          .select()
          .from(trainingSlots)
          .where(eq(trainingSlots.id, slotId))
          .for('update')
          .limit(1);

        if (!locked || locked.status !== 'ACTIVE') throw new ConflictException('Slot is no longer available');
        if (locked.bookedCount >= locked.capacity) throw new ConflictException('Slot is full');

        if (await findGroupBooking(tx, memberId, locked.trainingDayId)) {
          throw new ConflictException('You already have an active booking for this day');
        }

        await tx.insert(bookings).values({
          memberId,
          slotId,
          status: 'ACTIVE',
        });

        await tx
          .update(trainingSlots)
          .set({ bookedCount: sql`${trainingSlots.bookedCount} + 1` })
          .where(eq(trainingSlots.id, slotId));
      });
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === '23505') {
        throw new ConflictException('You already have an active booking for this day');
      }
      throw err;
    }

    // Booked the slot they were waiting for: no "seat free" push about their own slot
    await this.vacancyAlerts.unsubscribe(memberId, slotId);

    return { ok: true };
  }

  // A member can hold a group booking and several assigned ones, so the slot says which one to cancel
  async cancel(memberId: string, slotId: string, reason: string) {
    const [booking] = await this.database.db
      .select()
      .from(bookings)
      .where(and(eq(bookings.memberId, memberId), eq(bookings.slotId, slotId), eq(bookings.status, 'ACTIVE')))
      .limit(1);

    if (!booking) throw new NotFoundException('No active booking found');

    // The day comes through the slot (bookings don't store it)
    const [day] = await this.database.db
      .select({ id: trainingDays.id, localDate: trainingDays.localDate, status: trainingDays.status })
      .from(trainingDays)
      .innerJoin(trainingSlots, eq(trainingSlots.trainingDayId, trainingDays.id))
      .where(eq(trainingSlots.id, booking.slotId))
      .limit(1);

    const [slotBefore] = await this.database.db
      .select({
        bookedCount: trainingSlots.bookedCount,
        capacity: trainingSlots.capacity,
        slotTime: trainingSlots.slotTime,
        trainingType: trainingSlots.trainingType,
        trainerId: trainingSlots.trainerId,
      })
      .from(trainingSlots)
      .where(eq(trainingSlots.id, booking.slotId))
      .limit(1);

    // Group or assigned: only until the training starts (a booked no-show loses the training)
    if (day && slotBefore) this.validateBeforeStart(day.localDate, slotBefore.slotTime);

    // Vacancy alerts exist only for group slots (assigned ones are not open to others)
    const wasAtCapacity = slotBefore?.trainingType === GROUP_TYPE && slotBefore.bookedCount >= slotBefore.capacity;

    await this.database.db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(bookings)
        .set({ status: 'CANCELLED', cancelledAt: now, cancellationReason: reason })
        .where(and(eq(bookings.id, booking.id), eq(bookings.status, 'ACTIVE')));
      // Late: the training is spent from what pays for it, maybe half a single training's price back
      if (day && slotBefore) {
        await this.chargeLateCancel(
          tx,
          booking.id,
          memberId,
          slotBefore.trainingType,
          day.localDate,
          slotBefore.slotTime,
        );
      }
      // Their guest goes too: two seats free
      const seats = 1 + (await cancelGuests(tx, [booking.id], now)).size;

      await tx
        .update(trainingSlots)
        .set({ bookedCount: sql`GREATEST(${trainingSlots.bookedCount} - ${seats}, 0)` })
        .where(eq(trainingSlots.id, booking.slotId));
    });

    if (wasAtCapacity && day) {
      const dedupeKey = `vacancy:${booking.slotId}:${booking.id}`;
      await this.notifications.enqueueAndProcess('VACANCY', dedupeKey, {
        slotId: booking.slotId,
        slotTime: slotBefore.slotTime,
        localDate: day.localDate,
        excludeMemberId: booking.memberId,
      });
    }

    if (day && slotBefore) {
      await this.notifyTrainer(
        booking.id,
        memberId,
        slotBefore.trainerId,
        slotBefore.slotTime,
        day.localDate,
        reason,
        null,
      );
    }

    return { ok: true };
  }

  // Moves the member's group booking to the other group slot of the same day
  async switchSlot(memberId: string, newSlotId: string, reason: string) {
    const [target] = await this.database.db
      .select({
        trainingDayId: trainingSlots.trainingDayId,
        trainingType: trainingSlots.trainingType,
        slotTime: trainingSlots.slotTime,
        trainerId: trainingSlots.trainerId,
      })
      .from(trainingSlots)
      .where(eq(trainingSlots.id, newSlotId))
      .limit(1);

    if (!target) throw new NotFoundException('Slot not found');
    if (target.trainingType !== GROUP_TYPE) throw new BadRequestException('Only group trainings can be switched');
    if (target.trainerId !== (await getMemberTrainerId(this.database.db, memberId)))
      throw new NotFoundException('Slot not found');

    const current = await findGroupBooking(this.database.db, memberId, target.trainingDayId);

    if (!current) throw new NotFoundException('No active booking to switch from');
    if (current.slotId === newSlotId) throw new BadRequestException('Already booked on this slot');

    const [day] = await this.database.db
      .select()
      .from(trainingDays)
      .where(eq(trainingDays.id, current.trainingDayId))
      .limit(1);

    const oldSlotId = current.slotId;

    const [oldSlotBefore] = await this.database.db
      .select({
        bookedCount: trainingSlots.bookedCount,
        capacity: trainingSlots.capacity,
        slotTime: trainingSlots.slotTime,
        trainerId: trainingSlots.trainerId,
      })
      .from(trainingSlots)
      .where(eq(trainingSlots.id, oldSlotId))
      .limit(1);

    // Both trainings must not have started: the one they move to (its booking window), and the one they leave
    if (day) {
      await this.validateBookingWindow(day.localDate, target.slotTime, target.trainerId);
      if (oldSlotBefore) this.validateBeforeStart(day.localDate, oldSlotBefore.slotTime);
    }

    const wasAtCapacity = oldSlotBefore && oldSlotBefore.bookedCount >= oldSlotBefore.capacity;

    const [firstId, secondId] = [oldSlotId, newSlotId].sort();

    try {
      await this.database.db.transaction(async (tx) => {
        await this.lockMember(tx, memberId);

        const [slot1] = await tx
          .select()
          .from(trainingSlots)
          .where(eq(trainingSlots.id, firstId))
          .for('update')
          .limit(1);

        const [slot2] = await tx
          .select()
          .from(trainingSlots)
          .where(eq(trainingSlots.id, secondId))
          .for('update')
          .limit(1);

        if (!slot1 || !slot2) throw new NotFoundException('Slot not found');

        const newSlot = slot1.id === newSlotId ? slot1 : slot2;
        // A guest moves along: the new training needs a seat for them too
        const [guest] = await tx
          .select({ id: bookingGuests.id })
          .from(bookingGuests)
          .where(and(eq(bookingGuests.bookingId, current.id), eq(bookingGuests.status, 'ACTIVE')))
          .limit(1);
        const seats = guest ? 2 : 1;

        if (newSlot.status !== 'ACTIVE') throw new ConflictException('Target slot is cancelled');
        if (newSlot.bookedCount + seats > newSlot.capacity) throw new ConflictException('Target slot is full');

        const [moved] = await tx
          .update(bookings)
          .set({
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancellationReason: reason,
            switchedToSlotId: newSlotId,
          })
          .where(and(eq(bookings.id, current.id), eq(bookings.status, 'ACTIVE')))
          .returning({ id: bookings.id });
        if (!moved) throw new ConflictException('Booking has changed, refresh and try again');

        const [created] = await tx
          .insert(bookings)
          .values({
            memberId,
            slotId: newSlotId,
            status: 'ACTIVE',
          })
          .returning({ id: bookings.id });
        if (guest) await tx.update(bookingGuests).set({ bookingId: created.id }).where(eq(bookingGuests.id, guest.id));

        await tx
          .update(trainingSlots)
          .set({ bookedCount: sql`GREATEST(${trainingSlots.bookedCount} - ${seats}, 0)` })
          .where(eq(trainingSlots.id, oldSlotId));

        await tx
          .update(trainingSlots)
          .set({ bookedCount: sql`${trainingSlots.bookedCount} + ${seats}` })
          .where(eq(trainingSlots.id, newSlotId));
      });
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === '23505') {
        throw new ConflictException('You already have an active booking for this day');
      }
      throw err;
    }

    // Usually they came here from a vacancy push; stop alerts for the slot they now hold
    await this.vacancyAlerts.unsubscribe(memberId, newSlotId);

    if (wasAtCapacity && day) {
      const dedupeKey = `vacancy:${oldSlotId}:${current.id}`;
      await this.notifications.enqueueAndProcess('VACANCY', dedupeKey, {
        slotId: oldSlotId,
        slotTime: oldSlotBefore.slotTime,
        localDate: day.localDate,
        excludeMemberId: current.memberId,
      });
    }

    if (day && oldSlotBefore) {
      await this.notifyTrainer(
        current.id,
        memberId,
        oldSlotBefore.trainerId,
        oldSlotBefore.slotTime,
        day.localDate,
        reason,
        target.slotTime,
      );
    }

    return { ok: true };
  }

  // What cancelling this booking now would cost, for the warning in «Скасувати» (the cancel itself decides again,
  // from what it actually spends). refundUah: half of a single training given back
  async cancelFeePreview(
    memberId: string,
    slotId: string,
  ): Promise<{ fee: CancelFee | null; single: boolean; refundUah: number | null }> {
    const [row] = await this.database.db
      .select({
        bookingId: bookings.id,
        trainingType: trainingSlots.trainingType,
        slotTime: trainingSlots.slotTime,
        localDate: trainingDays.localDate,
      })
      .from(bookings)
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .innerJoin(trainingDays, eq(trainingDays.id, trainingSlots.trainingDayId))
      .where(and(eq(bookings.memberId, memberId), eq(bookings.slotId, slotId), eq(bookings.status, 'ACTIVE')))
      .limit(1);
    if (!row) throw new NotFoundException('No active booking found');
    const payer = await this.entitlements.payerFor(this.database.db, { memberId, ...row }, row.bookingId);
    const msBefore = slotStartsAt(row.localDate, row.slotTime).toMillis() - this.clock.now().toMillis();
    const fee = cancelFee(row.trainingType, msBefore, payer?.total ?? null);
    return {
      fee,
      // A single training (burns) rather than a pass (loses one)
      single: payer?.total === 1,
      refundUah: fee === 'HALF' && payer ? halfBack(payer.amountUah) : null,
    };
  }

  // A member's own cancellation that came late (booking/cancel-fee.ts): the booking keeps its fee, the training is
  // spent like a mark (syncSpend), and for HALF a refund of half the single training waits for the trainer.
  // Decided from what was actually spent, so a race with another spend can't charge what nothing paid for
  private async chargeLateCancel(
    tx: Tx,
    bookingId: string,
    memberId: string,
    trainingType: string,
    localDate: string,
    slotTime: string,
  ) {
    const msBefore = slotStartsAt(localDate, slotTime).toMillis() - this.clock.now().toMillis();
    const payer = await this.entitlements.payerFor(tx, { memberId, trainingType, localDate }, bookingId);
    if (!cancelFee(trainingType, msBefore, payer?.total ?? null)) return;

    await tx.update(bookings).set({ cancelFee: 'FULL' }).where(eq(bookings.id, bookingId));
    await this.entitlements.syncSpend(tx, bookingId);
    const [spent] = await tx
      .select({ total: packages.total, amountUah: purchaseItems.amountUah, purchaseId: purchaseItems.purchaseId })
      .from(packageSpends)
      .innerJoin(packages, eq(packages.id, packageSpends.packageId))
      .innerJoin(purchaseItems, eq(purchaseItems.id, packages.purchaseItemId))
      .where(eq(packageSpends.bookingId, bookingId))
      .limit(1);
    const fee = cancelFee(trainingType, msBefore, spent?.total ?? null);
    if (fee !== 'FULL') await tx.update(bookings).set({ cancelFee: fee }).where(eq(bookings.id, bookingId));
    if (fee === 'HALF' && halfBack(spent.amountUah) > 0) {
      await tx.insert(cancelRefunds).values({
        bookingId,
        memberId,
        purchaseId: spent.purchaseId,
        amountUah: halfBack(spent.amountUah),
      });
    }
  }

  // «+ Гість»: a member booked on a group training brings one guest, free, a name only. The guest takes a seat;
  // added and removed only while booking is open for that training (from the trainer's opening to its start)
  async addGuest(memberId: string, slotId: string, name: string) {
    const guestName = name.trim();
    if (!guestName) throw new BadRequestException('Guest name required');
    const slot = await this.groupSlotOf(slotId);
    await this.validateBookingWindow(slot.localDate, slot.slotTime, slot.trainerId);

    await this.database.db.transaction(async (tx) => {
      await this.lockMember(tx, memberId);
      const [locked] = await tx.select().from(trainingSlots).where(eq(trainingSlots.id, slotId)).for('update').limit(1);
      if (!locked || locked.status !== 'ACTIVE') throw new ConflictException('Slot is cancelled');
      const booking = await this.activeBooking(tx, memberId, slotId);
      if (!booking) throw new NotFoundException('No active booking found');
      const [already] = await tx
        .select({ id: bookingGuests.id })
        .from(bookingGuests)
        .where(and(eq(bookingGuests.bookingId, booking.id), eq(bookingGuests.status, 'ACTIVE')))
        .limit(1);
      if (already) throw new ConflictException('Guest already added');
      if (locked.bookedCount >= locked.capacity) throw new ConflictException('Slot is full');

      await tx.insert(bookingGuests).values({ bookingId: booking.id, name: guestName });
      await tx
        .update(trainingSlots)
        .set({ bookedCount: sql`${trainingSlots.bookedCount} + 1` })
        .where(eq(trainingSlots.id, slotId));
    });
    return { ok: true };
  }

  async removeGuest(memberId: string, slotId: string) {
    const slot = await this.groupSlotOf(slotId);
    this.validateBeforeStart(slot.localDate, slot.slotTime);

    const wasFull = await this.database.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(trainingSlots).where(eq(trainingSlots.id, slotId)).for('update').limit(1);
      const booking = await this.activeBooking(tx, memberId, slotId);
      if (!locked || !booking) throw new NotFoundException('No active booking found');
      if ((await cancelGuests(tx, [booking.id], new Date())).size === 0) throw new NotFoundException('No guest');
      await tx
        .update(trainingSlots)
        .set({ bookedCount: sql`GREATEST(${trainingSlots.bookedCount} - 1, 0)` })
        .where(eq(trainingSlots.id, slotId));
      return locked.bookedCount >= locked.capacity;
    });

    // A seat freed in a full group training: «З'явилось місце» to those waiting
    if (wasFull) {
      await this.notifications.enqueueAndProcess('VACANCY', `vacancy:${slotId}:guest:${Date.now()}`, {
        slotId,
        slotTime: slot.slotTime,
        localDate: slot.localDate,
        excludeMemberId: memberId,
      });
    }
    return { ok: true };
  }

  // A group slot of the member's trainer with its date (guests come only to group trainings)
  private async groupSlotOf(slotId: string) {
    const [slot] = await this.database.db
      .select({
        slotTime: trainingSlots.slotTime,
        trainingType: trainingSlots.trainingType,
        trainerId: trainingSlots.trainerId,
        localDate: trainingDays.localDate,
      })
      .from(trainingSlots)
      .innerJoin(trainingDays, eq(trainingDays.id, trainingSlots.trainingDayId))
      .where(eq(trainingSlots.id, slotId))
      .limit(1);
    if (!slot || slot.trainingType !== GROUP_TYPE) throw new NotFoundException('Slot not found');
    return slot;
  }

  private async activeBooking(tx: Tx, memberId: string, slotId: string) {
    const [booking] = await tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.memberId, memberId), eq(bookings.slotId, slotId), eq(bookings.status, 'ACTIVE')))
      .limit(1);
    return booking ?? null;
  }

  // Push to the trainer whose training it is, with the member's reason. A failed push must not fail the member's action
  private async notifyTrainer(
    bookingId: string,
    memberId: string,
    trainerId: string,
    slotTime: string,
    localDate: string,
    reason: string,
    switchedToTime: string | null,
  ) {
    try {
      const [member] = await this.database.db
        .select({ displayName: members.displayName })
        .from(members)
        .where(eq(members.id, memberId))
        .limit(1);
      await this.notifications.enqueueAndProcess('MEMBER_CANCELLED', `member-cancelled:${bookingId}`, {
        displayName: member?.displayName ?? '',
        trainerId,
        slotTime,
        localDate,
        reason,
        switchedToTime,
      });
    } catch (err) {
      this.logger.error(`Trainer push for booking ${bookingId} failed`, err);
    }
  }

  // Serializes one member's group bookings (book / switch), so two parallel requests can't both pass the per-day check
  private async lockMember(tx: Tx, memberId: string) {
    await tx.select({ id: members.id }).from(members).where(eq(members.id, memberId)).for('update').limit(1);
  }

  // The member's active group booking on that day (assigned bookings don't count)
  private validateBeforeStart(localDate: string, slotTime: string) {
    const now = this.clock.now();
    if (now >= slotStartsAt(localDate, slotTime)) throw new BadRequestException('Training has already started');
  }

  private async validateBookingWindow(localDate: string, slotTime: string, trainerId: string) {
    const now = this.clock.now();
    const { bookingOpensAt: opensAt } = await loadTrainerSchedule(this.database.db, trainerId);
    const { openAt, closeAt } = groupBookingWindow(localDate, slotTime, opensAt);
    if (now < openAt) throw new BadRequestException('Booking is not open yet');
    if (now >= closeAt) throw new BadRequestException('Booking window has closed');
  }
}
