import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { eq, and, ne, or, inArray, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DatabaseService } from '../database/database.service';
import { trainingDays, trainingSlots, bookings, members, attendance, slotMembers } from '../database/schema';
import type { UpsertTrainingDayDto } from './dto/upsert-training-day.dto';
import type { UpdateSlotDto } from './dto/update-slot.dto';
import type { CreateAssignedSlotDto } from './dto/create-assigned-slot.dto';
import { NotificationService } from '../notifications/notification.service';
import { ClockService } from '../clock/clock.service';
import { loadTrainerSchedule } from '../trainer-schedule/trainer-schedule.store';
import { requireOwnSlot, visibleTo } from '../schedule/default-trainer';
import { groupTimeError } from '../trainer-schedule/rules';
import {
  GROUP_TYPE,
  GROUP_CAPACITY,
  KY_ZONE,
  ASSIGNED_MEMBER_LIMITS,
  isAssignedType,
  slotStartsAt,
} from '../schedule/training-types';
import { loadFreezes } from '../freezes/freeze.store';
import { frozenOn } from '../freezes/rules';
import { cancelSlotsTx, notifySlotsCancelled } from './slot-cancellation';
import { trainingDayOn } from '../schedule/training-day.store';

type Db = DatabaseService['db'];
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// A new group training of this trainer (calendar, «Розклад групових» for a day)
const groupSlotRow = (trainingDayId: string, slotTime: string, trainerId: string) => ({
  trainingDayId,
  slotTime,
  status: 'ACTIVE' as const,
  trainingType: GROUP_TYPE,
  capacity: GROUP_CAPACITY,
  bookedCount: 0,
  trainerId,
});

// Adding, changing and cancelling the trainer's trainings: group and assigned slots, their members, a whole day
@Injectable()
export class AdminSlotsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly notifications: NotificationService,
    private readonly clock: ClockService,
  ) {}

  // Group slot at any time from 06:00 to 21:00 (not in the past), at least an hour from the trainer's other active group trainings
  // that day. A cancelled slot at that time stays as it was (a new row), an active assigned one is never taken over
  async upsertGroupSlot(adminId: string, date: string, slotTime: string) {
    const timeError = groupTimeError(slotTime, []);
    if (timeError) throw new BadRequestException(timeError);
    if (slotStartsAt(date, slotTime) <= this.clock.now()) throw new BadRequestException('Training time is in the past');

    await this.database.db.transaction(async (tx) => {
      const dayId = await this.ensureDay(tx, date);
      const others = await tx
        .select({ slotTime: trainingSlots.slotTime })
        .from(trainingSlots)
        .where(
          and(
            eq(trainingSlots.trainingDayId, dayId),
            eq(trainingSlots.trainerId, adminId),
            eq(trainingSlots.trainingType, GROUP_TYPE),
            eq(trainingSlots.status, 'ACTIVE'),
            ne(trainingSlots.slotTime, slotTime),
          ),
        );
      const gapError = groupTimeError(
        slotTime,
        others.map((o) => o.slotTime),
      );
      if (gapError) throw new BadRequestException(gapError);
      const [slot] = await tx
        .insert(trainingSlots)
        .values(groupSlotRow(dayId, slotTime, adminId))
        // A new training (a cancelled one at that time stays as it was); this trainer's active group one there
        // stays as is, their own active assigned training there is not taken over
        .onConflictDoUpdate({
          target: [trainingSlots.trainingDayId, trainingSlots.slotTime, trainingSlots.trainerId],
          targetWhere: sql`status = 'ACTIVE'`,
          set: { trainingType: GROUP_TYPE },
          setWhere: eq(trainingSlots.trainingType, GROUP_TYPE),
        })
        .returning({ id: trainingSlots.id });

      if (!slot) throw new ConflictException('Time is already taken');
    });

    return { ok: true };
  }

  // Personal (1 member) or split (1–3 members) at any time; seen and booked only by those members
  async createAssignedSlot(adminId: string, date: string, dto: CreateAssignedSlotDto) {
    await this.validateSlotMembers(adminId, dto.trainingType, dto.memberIds);

    const startsAt = slotStartsAt(date, dto.slotTime);
    if (!startsAt.isValid) throw new BadRequestException('Invalid date');
    const now = this.clock.now();
    if (startsAt <= now) throw new BadRequestException('Training time is in the past');
    await this.rejectFrozen(this.database.db, dto.memberIds, date);

    const capacity = ASSIGNED_MEMBER_LIMITS[dto.trainingType].max;
    const slotId = await this.database.db.transaction(async (tx) => {
      const dayId = await this.ensureDay(tx, date);
      const [slot] = await tx
        .insert(trainingSlots)
        .values({
          trainingDayId: dayId,
          slotTime: dto.slotTime,
          status: 'ACTIVE',
          trainingType: dto.trainingType,
          capacity,
          bookedCount: dto.memberIds.length,
          trainerId: adminId,
        })
        // Always a new training: an active one of this trainer at that time has the time
        .onConflictDoNothing({
          target: [trainingSlots.trainingDayId, trainingSlots.slotTime, trainingSlots.trainerId],
          where: sql`status = 'ACTIVE'`,
        })
        .returning({ id: trainingSlots.id });

      if (!slot) throw new ConflictException('Time is already taken');

      await tx.insert(slotMembers).values(dto.memberIds.map((memberId) => ({ slotId: slot.id, memberId })));
      // Assigning is booking: the members are on the training right away. It is paid from their package
      // when the trainer marks attendance, not per training
      await tx
        .insert(bookings)
        .values(dto.memberIds.map((memberId) => ({ memberId, slotId: slot.id, status: 'ACTIVE' })));
      return slot.id;
    });

    return { ok: true, slotId };
  }

  // Change who an assigned slot is for. A newly added member is booked; a removed one loses the booking,
  // unless their attendance is already marked (it may have been spent from their package)
  async updateSlotMembers(adminId: string, slotId: string, memberIds: string[]) {
    await this.database.db.transaction(async (tx) => {
      const slot = await requireOwnSlot(tx, adminId, slotId, true);
      if (!isAssignedType(slot.trainingType)) throw new BadRequestException('Group trainings are open to everyone');
      if (slot.status !== 'ACTIVE') throw new ConflictException('Slot is cancelled');

      await this.validateSlotMembers(adminId, slot.trainingType, memberIds, tx, slotId);

      const onSlot = await tx
        .select({ memberId: slotMembers.memberId })
        .from(slotMembers)
        .where(eq(slotMembers.slotId, slotId));
      const booked = await tx
        .select({ id: bookings.id, memberId: bookings.memberId, marked: attendance.bookingId })
        .from(bookings)
        .leftJoin(attendance, eq(attendance.bookingId, bookings.id))
        .where(and(eq(bookings.slotId, slotId), eq(bookings.status, 'ACTIVE')));

      const removed = booked.filter((b) => !memberIds.includes(b.memberId));
      if (removed.some((b) => b.marked)) throw new ConflictException('Attendance already marked');
      // Only members new to the slot are booked: one who cancelled themselves stays cancelled
      const added = memberIds.filter((id) => !onSlot.some((m) => m.memberId === id));
      await this.rejectFrozen(tx, added, slot.localDate);

      await tx.delete(slotMembers).where(eq(slotMembers.slotId, slotId));
      await tx.insert(slotMembers).values(memberIds.map((memberId) => ({ slotId, memberId })));
      if (removed.length > 0) {
        // No reason: a system cancellation, never shown as the member's
        await tx
          .update(bookings)
          .set({ status: 'CANCELLED', cancelledAt: this.clock.now().toJSDate() })
          .where(
            and(
              inArray(
                bookings.id,
                removed.map((b) => b.id),
              ),
              eq(bookings.status, 'ACTIVE'),
            ),
          );
      }
      if (added.length > 0) {
        await tx.insert(bookings).values(added.map((memberId) => ({ memberId, slotId, status: 'ACTIVE' })));
      }
      await tx
        .update(trainingSlots)
        .set({ bookedCount: booked.length - removed.length + added.length })
        .where(eq(trainingSlots.id, slotId));
    });

    return { ok: true };
  }

  // Members must be the trainer's own or unassigned clients; on an existing slot, members already on it may stay
  private async validateSlotMembers(
    adminId: string,
    trainingType: string,
    memberIds: string[],
    db: Db | Tx = this.database.db,
    slotId?: string,
  ) {
    const limits = ASSIGNED_MEMBER_LIMITS[trainingType];
    if (!limits || memberIds.length < limits.min || memberIds.length > limits.max) {
      throw new BadRequestException(`${trainingType}: ${limits?.min}–${limits?.max} members`);
    }
    const alreadyOnSlot = slotId
      ? sql`exists (select 1 from slot_members sm where sm.slot_id = ${slotId} and sm.member_id = "members"."id")`
      : undefined;
    const found = await db
      .select({ id: members.id })
      .from(members)
      .where(
        and(inArray(members.id, memberIds), alreadyOnSlot ? or(visibleTo(adminId), alreadyOnSlot) : visibleTo(adminId)),
      );
    if (found.length !== new Set(memberIds).size) throw new NotFoundException('Member not found');
  }

  // A frozen member can't be put on a training on a frozen day (members already on the slot may stay)
  private async rejectFrozen(db: Db | Tx, memberIds: string[], date: string) {
    const frozen = (await loadFreezes(db, memberIds)).some((f) => frozenOn(f, date));
    if (frozen) throw new ConflictException('Member is frozen');
  }

  // Training day row for the date, (re)scheduled. Returns its id
  private async ensureDay(tx: Tx, date: string) {
    const [day] = await tx
      .insert(trainingDays)
      .values({ localDate: date, status: 'SCHEDULED', updatedAt: this.clock.now().toJSDate() })
      .onConflictDoUpdate({
        target: trainingDays.localDate,
        set: { status: 'SCHEDULED', updatedAt: this.clock.now().toJSDate() },
      })
      .returning({ id: trainingDays.id });
    return day.id;
  }

  // SCHEDULED: adds this trainer's group slots of that weekday from «Розклад групових» (times taken or past are skipped).
  // CANCELLED: cancels only this trainer's slots; the day itself is cancelled when nothing active is left on it
  async upsertTrainingDay(adminId: string, date: string, dto: UpsertTrainingDayDto) {
    if (dto.status === 'SCHEDULED') {
      await this.database.db.transaction(async (tx) => {
        const dayId = await this.ensureDay(tx, date);
        const weekday = DateTime.fromISO(date, { zone: KY_ZONE }).weekday;
        const active = await tx
          .select({ slotTime: trainingSlots.slotTime })
          .from(trainingSlots)
          .where(
            and(
              eq(trainingSlots.trainingDayId, dayId),
              eq(trainingSlots.trainerId, adminId),
              eq(trainingSlots.trainingType, GROUP_TYPE),
              eq(trainingSlots.status, 'ACTIVE'),
            ),
          );
        // Leave out a time already past (nobody could book it, as in ensureGroupSlots) and one within an hour of a
        // group training already there that day
        const now = this.clock.now();
        const times = (await loadTrainerSchedule(tx, adminId)).times.filter(
          (t) =>
            t.weekday === weekday &&
            slotStartsAt(date, t.slotTime) > now &&
            !groupTimeError(
              t.slotTime,
              active.map((a) => a.slotTime).filter((a) => a !== t.slotTime),
            ),
        );
        if (times.length === 0) return;
        await tx
          .insert(trainingSlots)
          .values(times.map(({ slotTime }) => groupSlotRow(dayId, slotTime, adminId)))
          .onConflictDoNothing();
      });
      return { ok: true };
    }

    const day = await trainingDayOn(this.database.db, date);
    if (!day) throw new NotFoundException('Training day not found');

    const mySlots = await this.database.db
      .select({ id: trainingSlots.id, slotTime: trainingSlots.slotTime })
      .from(trainingSlots)
      .where(
        and(
          eq(trainingSlots.trainingDayId, day.id),
          eq(trainingSlots.trainerId, adminId),
          eq(trainingSlots.status, 'ACTIVE'),
        ),
      );
    const mySlotIds = mySlots.map((s) => s.id);

    const cancelled = await this.database.db.transaction(async (tx) => {
      const booked = await cancelSlotsTx(tx, mySlotIds, this.clock.now().toJSDate());
      // Other trainers' trainings that day keep the day scheduled
      await tx
        .update(trainingDays)
        .set({ status: 'CANCELLED', updatedAt: this.clock.now().toJSDate() })
        .where(
          and(
            eq(trainingDays.id, day.id),
            sql`not exists (select 1 from training_slots ts where ts.training_day_id = ${day.id} and ts.status = 'ACTIVE')`,
          ),
        );
      return booked;
    });

    await notifySlotsCancelled(
      this.notifications,
      mySlots.map((s) => ({ ...s, localDate: date })),
      cancelled,
    );

    return { ok: true };
  }

  async updateSlot(adminId: string, slotId: string, dto: UpdateSlotDto) {
    const slot = await requireOwnSlot(this.database.db, adminId, slotId);

    // Only cancelling (UpdateSlotDto); a training cancelled already is left as it is
    if (dto.status === 'CANCELLED' && slot.status === 'ACTIVE') {
      const cancelled = await this.database.db.transaction((tx) =>
        cancelSlotsTx(tx, [slotId], this.clock.now().toJSDate()),
      );
      await notifySlotsCancelled(this.notifications, [slot], cancelled);
    }

    const [updated] = await this.database.db.select().from(trainingSlots).where(eq(trainingSlots.id, slotId)).limit(1);

    return updated;
  }
}
