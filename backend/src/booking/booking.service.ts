import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { eq, and, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { bookings, trainingSlots, trainingDays, members } from '../database/schema';
import { NotificationService } from '../notifications/notification.service';
import { DemoService } from '../demo/demo.service';
import { GROUP_TYPE, KY_ZONE, slotStartsAt } from '../schedule/training-types';

type Db = DatabaseService['db'];
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

@Injectable()
export class BookingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly notifications: NotificationService,
    private readonly demoService: DemoService,
  ) {}

  async book(memberId: string, slotId: string) {
    const [slot] = await this.database.db
      .select()
      .from(trainingSlots)
      .where(eq(trainingSlots.id, slotId))
      .limit(1);

    if (!slot) throw new NotFoundException('Slot not found');
    if (slot.status !== 'ACTIVE') throw new ConflictException('Slot is cancelled');
    // Personal trainings are booked only through payment (PaymentService.createCheckout)
    if (slot.trainingType !== GROUP_TYPE) throw new BadRequestException('This slot requires payment');

    const [day] = await this.database.db
      .select()
      .from(trainingDays)
      .where(eq(trainingDays.id, slot.trainingDayId))
      .limit(1);

    if (!day || day.status !== 'SCHEDULED') throw new ConflictException('Training day is not scheduled');

    await this.validateBookingWindow(day.localDate);

    try {
      await this.database.db.transaction(async (tx) => {
        await this.lockMember(tx, memberId);

        const [locked] = await tx
          .select()
          .from(trainingSlots)
          .where(eq(trainingSlots.id, slotId))
          .for('update')
          .limit(1);

        if (!locked || locked.status !== 'ACTIVE') throw new ConflictException('Slot is no longer available');
        if (locked.bookedCount >= locked.capacity) throw new ConflictException('Slot is full');

        if (await this.findGroupBooking(tx, memberId, locked.trainingDayId)) {
          throw new ConflictException('You already have an active booking for this day');
        }

        await tx.insert(bookings).values({
          memberId,
          trainingDayId: locked.trainingDayId,
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

    return { ok: true };
  }

  // A member can hold a group booking and several personal ones, so the slot says which one to cancel
  async cancel(memberId: string, slotId: string, reason: string, reasonAt: Date) {
    const [booking] = await this.database.db
      .select()
      .from(bookings)
      .where(and(eq(bookings.memberId, memberId), eq(bookings.slotId, slotId), eq(bookings.status, 'ACTIVE')))
      .limit(1);

    if (!booking) throw new NotFoundException('No active booking found');

    const [day] = await this.database.db
      .select()
      .from(trainingDays)
      .where(eq(trainingDays.id, booking.trainingDayId))
      .limit(1);

    const [slotBefore] = await this.database.db
      .select({
        bookedCount: trainingSlots.bookedCount,
        capacity: trainingSlots.capacity,
        slotTime: trainingSlots.slotTime,
        trainingType: trainingSlots.trainingType,
      })
      .from(trainingSlots)
      .where(eq(trainingSlots.id, booking.slotId))
      .limit(1);

    if (day && slotBefore?.trainingType === GROUP_TYPE) await this.validateBeforeClose(day.localDate);
    if (day && slotBefore && slotBefore.trainingType !== GROUP_TYPE) {
      await this.validateBeforeStart(day.localDate, slotBefore.slotTime);
    }

    // Vacancy alerts exist only for group slots (personal ones are not open to others)
    const wasAtCapacity =
      slotBefore?.trainingType === GROUP_TYPE && slotBefore.bookedCount >= slotBefore.capacity;

    await this.database.db.transaction(async (tx) => {
      await tx
        .update(bookings)
        .set({ status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: reason, cancellationReasonAt: reasonAt })
        .where(and(eq(bookings.id, booking.id), eq(bookings.status, 'ACTIVE')));

      await tx
        .update(trainingSlots)
        .set({ bookedCount: sql`GREATEST(${trainingSlots.bookedCount} - 1, 0)` })
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

    return { ok: true };
  }

  // Moves the member's group booking to the other group slot of the same day
  async switchSlot(memberId: string, newSlotId: string, reason: string, reasonAt: Date) {
    const [target] = await this.database.db
      .select({ trainingDayId: trainingSlots.trainingDayId, trainingType: trainingSlots.trainingType })
      .from(trainingSlots)
      .where(eq(trainingSlots.id, newSlotId))
      .limit(1);

    if (!target) throw new NotFoundException('Slot not found');
    if (target.trainingType !== GROUP_TYPE) throw new BadRequestException('Only group trainings can be switched');

    const current = await this.findGroupBooking(this.database.db, memberId, target.trainingDayId);

    if (!current) throw new NotFoundException('No active booking to switch from');
    if (current.slotId === newSlotId) throw new BadRequestException('Already booked on this slot');

    const [day] = await this.database.db
      .select()
      .from(trainingDays)
      .where(eq(trainingDays.id, current.trainingDayId))
      .limit(1);

    if (day) await this.validateBookingWindow(day.localDate);

    const oldSlotId = current.slotId;

    const [oldSlotBefore] = await this.database.db
      .select({ bookedCount: trainingSlots.bookedCount, capacity: trainingSlots.capacity, slotTime: trainingSlots.slotTime })
      .from(trainingSlots)
      .where(eq(trainingSlots.id, oldSlotId))
      .limit(1);

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

        if (newSlot.status !== 'ACTIVE') throw new ConflictException('Target slot is cancelled');
        if (newSlot.bookedCount >= newSlot.capacity) throw new ConflictException('Target slot is full');

        const [moved] = await tx
          .update(bookings)
          .set({ status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: reason, cancellationReasonAt: reasonAt })
          .where(and(eq(bookings.id, current.id), eq(bookings.status, 'ACTIVE')))
          .returning({ id: bookings.id });
        if (!moved) throw new ConflictException('Booking has changed, refresh and try again');

        await tx.insert(bookings).values({
          memberId,
          trainingDayId: current.trainingDayId,
          slotId: newSlotId,
          status: 'ACTIVE',
        });

        await tx
          .update(trainingSlots)
          .set({ bookedCount: sql`GREATEST(${trainingSlots.bookedCount} - 1, 0)` })
          .where(eq(trainingSlots.id, oldSlotId));

        await tx
          .update(trainingSlots)
          .set({ bookedCount: sql`${trainingSlots.bookedCount} + 1` })
          .where(eq(trainingSlots.id, newSlotId));
      });
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === '23505') {
        throw new ConflictException('You already have an active booking for this day');
      }
      throw err;
    }

    if (wasAtCapacity && day) {
      const dedupeKey = `vacancy:${oldSlotId}:${current.id}`;
      await this.notifications.enqueueAndProcess('VACANCY', dedupeKey, {
        slotId: oldSlotId,
        slotTime: oldSlotBefore!.slotTime,
        localDate: day.localDate,
        excludeMemberId: current.memberId,
      });
    }

    return { ok: true };
  }

  // Serializes one member's group bookings (book / switch), so two parallel requests can't both pass the per-day check
  private async lockMember(tx: Tx, memberId: string) {
    await tx.select({ id: members.id }).from(members).where(eq(members.id, memberId)).for('update').limit(1);
  }

  // The member's active group booking on that day (personal bookings don't count)
  private async findGroupBooking(db: Db | Tx, memberId: string, trainingDayId: string) {
    const [row] = await db
      .select({ id: bookings.id, slotId: bookings.slotId, trainingDayId: bookings.trainingDayId, memberId: bookings.memberId })
      .from(bookings)
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .where(
        and(
          eq(bookings.memberId, memberId),
          eq(bookings.trainingDayId, trainingDayId),
          eq(bookings.status, 'ACTIVE'),
          eq(trainingSlots.trainingType, GROUP_TYPE),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private async validateBeforeStart(localDate: string, slotTime: string) {
    const now = await this.demoService.getNow();
    if (now >= slotStartsAt(localDate, slotTime)) throw new BadRequestException('Training has already started');
  }

  private async validateBookingWindow(localDate: string) {
    const now = await this.demoService.getNow();
    const openAt = DateTime.fromISO(`${localDate}T14:00:00`, { zone: KY_ZONE });
    const closeAt = DateTime.fromISO(`${localDate}T21:00:00`, { zone: KY_ZONE });
    if (now < openAt) throw new BadRequestException('Booking opens at 14:00');
    if (now >= closeAt) throw new BadRequestException('Booking window has closed');
  }

  private async validateBeforeClose(localDate: string) {
    const now = await this.demoService.getNow();
    const closeAt = DateTime.fromISO(`${localDate}T21:00:00`, { zone: KY_ZONE });
    if (now >= closeAt) throw new BadRequestException('Booking window has closed');
  }
}