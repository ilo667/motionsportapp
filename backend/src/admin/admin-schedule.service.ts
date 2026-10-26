import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { eq, and, ne, or, inArray, gte, lt, lte, asc, desc, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DateTime } from 'luxon';
import { DatabaseService } from '../database/database.service';
import {
  trainingDays,
  trainingSlots,
  bookings,
  members,
  attendance,
  slotMembers,
  admins,
  packageSpends,
  sessions,
  purchases,
  trainerSchedules,
  adminPushSubscriptions,
  bookingGuests,
  cancelRefunds,
} from '../database/schema';
import type { UpsertTrainingDayDto } from './dto/upsert-training-day.dto';
import type { UpdateSlotDto } from './dto/update-slot.dto';
import type { UpdateAttendanceDto } from './dto/update-attendance.dto';
import type { UpdateMemberNoteDto } from './dto/update-member-note.dto';
import type { CreateAssignedSlotDto } from './dto/create-assigned-slot.dto';
import { NotificationService } from '../notifications/notification.service';
import { ClockService } from '../clock/clock.service';
import { EntitlementsService, inLockOrder } from '../purchases/entitlements.service';
import { loadTrainerSchedule } from '../trainer-schedule/trainer-schedule.store';
import { getDefaultTrainerId } from '../schedule/default-trainer';
import { bookingOpensAt, groupTimeError } from '../trainer-schedule/rules';
import { GROUP_TYPE, KY_ZONE, ASSIGNED_MEMBER_LIMITS, isAssignedType, slotStartsAt } from '../schedule/training-types';
import { loadFreezes } from '../freezes/freeze.store';
import { cancelGuests } from '../booking/group-booking';
import { frozenOn, plusDays } from '../freezes/rules';

// Member-initiated cancellations / moves shown to the trainer (with the reason they wrote)
const CANCELLATION_STATS_DAYS = 30;
const MEMBER_HISTORY_LIMIT = 20;
// Training days per history page («Показати ще» loads the next page)
const HISTORY_PAGE_DAYS = 14;

type Db = DatabaseService['db'];
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

type CancellationRow = {
  bookingId: string;
  displayName: string;
  reason: string | null;
  cancelledAt: Date | null;
  switchedToTime: string | null;
  cancelFee?: string | null;
  feeWaivedAt?: Date | null;
  refundUah?: number | null;
  refundStatus?: string | null;
};

function toCancellationView(r: CancellationRow) {
  return {
    bookingId: r.bookingId,
    displayName: r.displayName,
    reason: r.reason ?? '',
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    switchedToTime: r.switchedToTime, // null = cancelled, otherwise moved to that time
    // A late cancellation (booking/cancel-fee.ts): what it cost, half a single training back, and «Не списувати»
    fee: r.cancelFee
      ? {
          kind: r.cancelFee as 'FULL' | 'HALF',
          waived: !!r.feeWaivedAt,
          refundUah: r.refundStatus === 'CANCELLED' ? null : (r.refundUah ?? null),
          refundDone: r.refundStatus === 'DONE',
        }
      : null,
  };
}

@Injectable()
export class AdminScheduleService {
  constructor(
    private readonly database: DatabaseService,
    private readonly notifications: NotificationService,
    private readonly clock: ClockService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // The trainer's next training day with their own slots
  async getSchedule(adminId: string) {
    const now = this.clock.now();
    const today = now.toISODate()!;

    const upcoming = await this.database.db
      .select()
      .from(trainingDays)
      .where(and(eq(trainingDays.status, 'SCHEDULED'), gte(trainingDays.localDate, today), this.hasSlotsOf(adminId)))
      .orderBy(trainingDays.localDate)
      .limit(30);

    // Today stays on the page until midnight (marks after the last training); then the next day with trainings
    const targetDay =
      upcoming.find((day) => now < DateTime.fromISO(day.localDate, { zone: KY_ZONE }).endOf('day')) ?? upcoming[0];

    if (!targetDay) return null;

    const slots = await this.database.db
      .select()
      .from(trainingSlots)
      .where(and(eq(trainingSlots.trainingDayId, targetDay.id), eq(trainingSlots.trainerId, adminId)))
      .orderBy(trainingSlots.slotTime);

    // Booking for the trainer's group trainings: from their opening time until the last one starts (a day with
    // no group training: until midnight)
    const { bookingOpensAt: opensAt } = await loadTrainerSchedule(this.database.db, adminId);
    const openAt = bookingOpensAt(targetDay.localDate, opensAt);
    const lastGroup = slots.filter((s) => s.trainingType === GROUP_TYPE).at(-1);
    const closeAt = lastGroup
      ? slotStartsAt(targetDay.localDate, lastGroup.slotTime)
      : DateTime.fromISO(targetDay.localDate, { zone: KY_ZONE }).endOf('day');
    const bookingWindowOpen = now >= openAt && now < closeAt;

    return {
      localDate: targetDay.localDate,
      status: targetDay.status,
      bookingWindowOpen,
      bookingOpenAt: openAt.toUTC().toISO(),
      bookingCloseAt: closeAt.toUTC().toISO(),
      serverTime: now.toUTC().toISO(),
      slots: await this.buildSlotViews(slots),
    };
  }

  // Past training days, newest first, for the trainer's history (attendance stays editable there).
  // Cursor pagination: pass the last returned localDate as `before` to get older days
  async getHistory(adminId: string, before?: string) {
    const today = this.clock.now().toISODate()!;
    const cursor = before && before < today ? before : today;

    const days = await this.database.db
      .select({ id: trainingDays.id, localDate: trainingDays.localDate, status: trainingDays.status })
      .from(trainingDays)
      .where(and(lt(trainingDays.localDate, cursor), this.hasSlotsOf(adminId)))
      .orderBy(desc(trainingDays.localDate))
      .limit(HISTORY_PAGE_DAYS + 1);

    const page = days.slice(0, HISTORY_PAGE_DAYS);
    const slots =
      page.length > 0
        ? await this.database.db
            .select()
            .from(trainingSlots)
            .where(
              and(
                inArray(
                  trainingSlots.trainingDayId,
                  page.map((d) => d.id),
                ),
                eq(trainingSlots.trainerId, adminId),
              ),
            )
            .orderBy(trainingSlots.slotTime)
        : [];
    const views = await this.buildSlotViews(slots);

    return {
      days: page.map((d) => ({
        localDate: d.localDate,
        status: d.status,
        slots: views.filter((v) => v.trainingDayId === d.id),
      })),
      nextBefore: days.length > HISTORY_PAGE_DAYS ? page[page.length - 1].localDate : null,
    };
  }

  // Days with at least one slot of this trainer. Raw, fully qualified SQL (see the drizzle note in CLAUDE.md)
  private hasSlotsOf(adminId: string) {
    return sql`exists (select 1 from training_slots ts where ts.training_day_id = "training_days"."id" and ts.trainer_id = ${adminId})`;
  }

  // The slot if it belongs to this trainer; another trainer's slot answers 404 like a missing one
  // A cancelled training costs nothing: its attendance marks go, and with them the trainings they took from
  // packages (activation stays, as with «—»). Called in the transaction that cancels the bookings, before it.
  // A member's own late cancellation stays as it was: they cancelled before the trainer did
  private async releaseMarks(tx: Tx, slotIds: string[]) {
    if (slotIds.length === 0) return;
    const ofSlots = () =>
      tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(and(inArray(bookings.slotId, slotIds), eq(bookings.status, 'ACTIVE')));
    await tx.delete(packageSpends).where(inArray(packageSpends.bookingId, ofSlots()));
    await tx.delete(attendance).where(inArray(attendance.bookingId, ofSlots()));
  }

  // Cancels these slots and every active booking on them (a system cancellation, no reason); their marks and spends
  // go back first. The caller marks the day CANCELLED when it has to, and tells the members after the transaction
  private async cancelSlotsTx(tx: Tx, slotIds: string[]) {
    if (slotIds.length === 0) return;
    await this.releaseMarks(tx, slotIds);
    const active = await tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(inArray(bookings.slotId, slotIds), eq(bookings.status, 'ACTIVE')));
    await cancelGuests(
      tx,
      active.map((b) => b.id),
      new Date(),
    );
    await tx
      .update(bookings)
      .set({ status: 'CANCELLED', cancelledAt: new Date() })
      .where(and(inArray(bookings.slotId, slotIds), eq(bookings.status, 'ACTIVE')));
    await tx
      .update(trainingSlots)
      .set({ status: 'CANCELLED', bookedCount: 0, cancelledAt: new Date() })
      .where(inArray(trainingSlots.id, slotIds));
  }

  private async ownSlot(adminId: string, slotId: string, db: Db | Tx = this.database.db, lock = false) {
    const query = db.select().from(trainingSlots).where(eq(trainingSlots.id, slotId));
    const [slot] = await (lock ? query.for('update').limit(1) : query.limit(1));
    if (!slot || slot.trainerId !== adminId) throw new NotFoundException('Slot not found');
    return slot;
  }

  // Slot cards for the today page and history: participants with attendance, who moved in
  // ("з 19:00"), and who cancelled or moved away with their reason
  private async buildSlotViews(slots: (typeof trainingSlots.$inferSelect)[]) {
    const slotIds = slots.map((s) => s.id);
    if (slotIds.length === 0) return [];

    const participantRows = await this.database.db
      .select({
        bookingId: bookings.id,
        slotId: bookings.slotId,
        memberId: bookings.memberId,
        displayName: members.displayName,
        attendanceStatus: attendance.status,
      })
      .from(bookings)
      .innerJoin(members, eq(bookings.memberId, members.id))
      .leftJoin(attendance, eq(attendance.bookingId, bookings.id))
      .where(and(inArray(bookings.slotId, slotIds), eq(bookings.status, 'ACTIVE')))
      .orderBy(bookings.createdAt);

    // Guests of these bookings, each listed right under the member who brought them
    const guestRows = participantRows.length
      ? await this.database.db
          .select({
            id: bookingGuests.id,
            bookingId: bookingGuests.bookingId,
            name: bookingGuests.name,
            attendance: bookingGuests.attendance,
          })
          .from(bookingGuests)
          .where(
            and(
              inArray(
                bookingGuests.bookingId,
                participantRows.map((p) => p.bookingId),
              ),
              eq(bookingGuests.status, 'ACTIVE'),
            ),
          )
      : [];

    // Cancelled from these slots, and moved here from another slot
    const cancellations = await this.memberCancellations(
      or(inArray(bookings.slotId, slotIds), inArray(bookings.switchedToSlotId, slotIds))!,
    );

    return slots.map((s) => ({
      id: s.id,
      trainingDayId: s.trainingDayId,
      slotTime: s.slotTime,
      status: s.status,
      trainingType: s.trainingType,
      capacity: s.capacity,
      bookedCount: s.bookedCount,
      participants: participantRows
        .filter((p) => p.slotId === s.id)
        .flatMap((p) => {
          const member = {
            bookingId: p.bookingId,
            displayName: p.displayName,
            attendanceStatus: (p.attendanceStatus ?? 'UNMARKED') as 'PRESENT' | 'ABSENT' | 'UNMARKED',
            switchedFromTime:
              cancellations.find((c) => c.switchedToSlotId === s.id && c.memberId === p.memberId)?.slotTime ?? null,
            guestOf: null as string | null,
          };
          // A guest: bookingId is the guest's own id, marked through PATCH /admin/guests/:id/attendance
          const guest = guestRows.find((g) => g.bookingId === p.bookingId);
          return guest
            ? [
                member,
                {
                  bookingId: guest.id,
                  displayName: guest.name,
                  attendanceStatus: (guest.attendance ?? 'UNMARKED') as 'PRESENT' | 'ABSENT' | 'UNMARKED',
                  switchedFromTime: null,
                  guestOf: p.displayName,
                },
              ]
            : [member];
        }),
      // Someone who moved away and came back is a participant again, not one who cancelled
      cancellations: cancellations
        .filter(
          (c) => c.slotId === s.id && !participantRows.some((p) => p.slotId === s.id && p.memberId === c.memberId),
        )
        .map(toCancellationView),
    }));
  }

  // Only this trainer's trainings (trainers work in parallel in different halls)
  async getCalendar(adminId: string, month: string) {
    const start = `${month}-01`;
    const [year, m] = month.split('-').map(Number);
    const lastDay = new Date(year, m, 0).getDate();
    const end = `${month}-${String(lastDay).padStart(2, '0')}`;

    const rows = await this.database.db
      .select({
        localDate: trainingDays.localDate,
        dayStatus: trainingDays.status,
        slotId: trainingSlots.id,
        slotTime: trainingSlots.slotTime,
        slotStatus: trainingSlots.status,
        trainingType: trainingSlots.trainingType,
        bookedCount: trainingSlots.bookedCount,
        capacity: trainingSlots.capacity,
      })
      .from(trainingDays)
      .innerJoin(trainingSlots, eq(trainingSlots.trainingDayId, trainingDays.id))
      .where(
        and(
          gte(trainingDays.localDate, start),
          lte(trainingDays.localDate, end),
          eq(trainingSlots.status, 'ACTIVE'),
          eq(trainingSlots.trainerId, adminId),
          eq(trainingDays.status, 'SCHEDULED'),
        ),
      )
      .orderBy(trainingDays.localDate, trainingSlots.slotTime);

    const assignedIds = rows.filter((r) => isAssignedType(r.trainingType)).map((r) => r.slotId);
    const assigned =
      assignedIds.length > 0
        ? await this.database.db
            .select({ slotId: slotMembers.slotId, id: members.id, displayName: members.displayName })
            .from(slotMembers)
            .innerJoin(members, eq(members.id, slotMembers.memberId))
            .where(inArray(slotMembers.slotId, assignedIds))
            .orderBy(slotMembers.createdAt)
        : [];
    // Per member: still booked, and how many trainings of that type are left in their packages
    // (the trainer cancels a training nobody paid for)
    const booked =
      assignedIds.length > 0
        ? await this.database.db
            .select({ slotId: bookings.slotId, memberId: bookings.memberId, spentFrom: packageSpends.packageId })
            .from(bookings)
            .leftJoin(packageSpends, eq(packageSpends.bookingId, bookings.id))
            .where(and(inArray(bookings.slotId, assignedIds), eq(bookings.status, 'ACTIVE')))
        : [];
    const summaries = await this.entitlements.summaries([...new Set(assigned.map((a) => a.id))]);

    return rows.map((r) => ({
      localDate: r.localDate,
      slotId: r.slotId,
      slotTime: r.slotTime,
      trainingType: r.trainingType,
      bookedCount: r.bookedCount,
      capacity: r.capacity,
      members: assigned
        .filter((a) => a.slotId === r.slotId)
        .map(({ id, displayName }) => ({
          id,
          displayName,
          booked: booked.some((b) => b.slotId === r.slotId && b.memberId === id),
          // Already paid from a package (marked): «оплачено» even if the package is empty now
          spent: booked.some((b) => b.slotId === r.slotId && b.memberId === id && !!b.spentFrom),
          packageLeft: summaries.get(id)?.packagesLeft.find((p) => p.trainingType === r.trainingType)?.left ?? 0,
        })),
    }));
  }

  // Group slot at any time from 06:00 to 21:00 (not in the past), at least an hour from the trainer's other active group trainings
  // that day. Re-activates a cancelled slot at that time, but never takes over an active assigned one
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
        .values({
          trainingDayId: dayId,
          slotTime,
          status: 'ACTIVE',
          trainingType: GROUP_TYPE,
          capacity: 8,
          bookedCount: 0,
          trainerId: adminId,
        })
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
      const slot = await this.ownSlot(adminId, slotId, tx, true);
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
      const [day] = await tx
        .select({ localDate: trainingDays.localDate })
        .from(trainingDays)
        .where(eq(trainingDays.id, slot.trainingDayId))
        .limit(1);
      if (day) await this.rejectFrozen(tx, added, day.localDate);

      await tx.delete(slotMembers).where(eq(slotMembers.slotId, slotId));
      await tx.insert(slotMembers).values(memberIds.map((memberId) => ({ slotId, memberId })));
      if (removed.length > 0) {
        // No reason: a system cancellation, never shown as the member's
        await tx
          .update(bookings)
          .set({ status: 'CANCELLED', cancelledAt: new Date() })
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
        and(
          inArray(members.id, memberIds),
          alreadyOnSlot ? or(this.visibleTo(adminId), alreadyOnSlot) : this.visibleTo(adminId),
        ),
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
      .values({ localDate: date, status: 'SCHEDULED', updatedAt: new Date() })
      .onConflictDoUpdate({
        target: trainingDays.localDate,
        set: { status: 'SCHEDULED', updatedAt: new Date() },
      })
      .returning({ id: trainingDays.id });
    return day.id;
  }

  // SCHEDULED: adds this trainer's group slots of that weekday from «Мій розклад» (times taken are skipped).
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
        // Leave out a time within an hour of a group training already there that day
        const times = (await loadTrainerSchedule(tx, adminId)).times.filter(
          (t) =>
            t.weekday === weekday &&
            !groupTimeError(
              t.slotTime,
              active.map((a) => a.slotTime).filter((a) => a !== t.slotTime),
            ),
        );
        if (times.length === 0) return;
        await tx
          .insert(trainingSlots)
          .values(
            times.map(({ slotTime }) => ({
              trainingDayId: dayId,
              slotTime,
              status: 'ACTIVE' as const,
              trainingType: GROUP_TYPE,
              capacity: 8,
              bookedCount: 0,
              trainerId: adminId,
            })),
          )
          .onConflictDoNothing();
      });
      return { ok: true };
    }

    const [day] = await this.database.db.select().from(trainingDays).where(eq(trainingDays.localDate, date)).limit(1);
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

    const affectedBookings =
      mySlotIds.length > 0
        ? await this.database.db
            .select({ memberId: bookings.memberId, slotId: bookings.slotId })
            .from(bookings)
            .where(and(inArray(bookings.slotId, mySlotIds), eq(bookings.status, 'ACTIVE')))
        : [];

    await this.database.db.transaction(async (tx) => {
      await this.cancelSlotsTx(tx, mySlotIds);
      // Other trainers' trainings that day keep the day scheduled
      await tx
        .update(trainingDays)
        .set({ status: 'CANCELLED', updatedAt: new Date() })
        .where(
          and(
            eq(trainingDays.id, day.id),
            sql`not exists (select 1 from training_slots ts where ts.training_day_id = ${day.id} and ts.status = 'ACTIVE')`,
          ),
        );
    });

    for (const slot of mySlots) {
      const memberIds = affectedBookings.filter((b) => b.slotId === slot.id).map((b) => b.memberId);
      if (memberIds.length > 0) {
        await this.notifications.enqueueAndProcess('SLOT_CANCELLED', `slot-cancelled:${slot.id}:${date}`, {
          memberIds,
          slotTime: slot.slotTime,
          localDate: date,
        });
      }
    }

    return { ok: true };
  }

  async updateSlot(adminId: string, slotId: string, dto: UpdateSlotDto) {
    const slot = await this.ownSlot(adminId, slotId);

    if (dto.status === 'CANCELLED' && slot.status === 'ACTIVE') {
      const affectedBookings = await this.database.db
        .select({ memberId: bookings.memberId })
        .from(bookings)
        .where(and(eq(bookings.slotId, slotId), eq(bookings.status, 'ACTIVE')));

      await this.database.db.transaction((tx) => this.cancelSlotsTx(tx, [slotId]));

      const memberIds = affectedBookings.map((b) => b.memberId);
      if (memberIds.length > 0) {
        const [day] = await this.database.db
          .select({ localDate: trainingDays.localDate })
          .from(trainingDays)
          .where(eq(trainingDays.id, slot.trainingDayId))
          .limit(1);
        if (day) {
          await this.notifications.enqueueAndProcess('SLOT_CANCELLED', `slot-cancelled:${slotId}:${day.localDate}`, {
            memberIds,
            slotTime: slot.slotTime,
            localDate: day.localDate,
          });
        }
      }
    } else {
      await this.database.db
        .update(trainingSlots)
        .set({ status: dto.status, ...(dto.status === 'ACTIVE' ? { cancelledAt: null } : {}) })
        .where(eq(trainingSlots.id, slotId));
    }

    const [updated] = await this.database.db.select().from(trainingSlots).where(eq(trainingSlots.id, slotId)).limit(1);

    return updated;
  }

  async markAllAttendance(slotId: string, adminId: string) {
    await this.ownSlot(adminId, slotId);
    const activeBookings = await this.database.db
      .select({ id: bookings.id, memberId: bookings.memberId })
      .from(bookings)
      .where(and(eq(bookings.slotId, slotId), eq(bookings.status, 'ACTIVE')));

    if (activeBookings.length === 0) return { marked: 0 };

    const now = new Date();
    await this.database.db.transaction(async (tx) => {
      for (const booking of inLockOrder(activeBookings)) {
        await tx
          .insert(attendance)
          .values({ bookingId: booking.id, status: 'PRESENT', markedAt: now, markedByAdminId: adminId })
          .onConflictDoUpdate({
            target: attendance.bookingId,
            set: { status: 'PRESENT', markedAt: now, markedByAdminId: adminId },
          });
        await this.entitlements.syncSpend(tx, booking.id);
      }
      // Their guests too (nothing to spend)
      await tx
        .update(bookingGuests)
        .set({ attendance: 'PRESENT', markedAt: now, markedByAdminId: adminId })
        .where(
          and(
            inArray(
              bookingGuests.bookingId,
              activeBookings.map((b) => b.id),
            ),
            eq(bookingGuests.status, 'ACTIVE'),
          ),
        );
    });

    return { marked: activeBookings.length };
  }

  // «Не списувати»: the training a late cancellation took goes back, and the half refund (if any) is dropped.
  // Only on this trainer's trainings, and only while the money hasn't been returned. Compare-and-set
  async waiveCancelFee(bookingId: string, adminId: string) {
    const [booking] = await this.database.db
      .select({ id: bookings.id, refundStatus: cancelRefunds.status })
      .from(bookings)
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .leftJoin(cancelRefunds, eq(cancelRefunds.bookingId, bookings.id))
      .where(and(eq(bookings.id, bookingId), eq(trainingSlots.trainerId, adminId)))
      .limit(1);
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.refundStatus === 'DONE') throw new ConflictException('Money already returned');

    await this.database.db.transaction(async (tx) => {
      const [done] = await tx
        .update(bookings)
        .set({ feeWaivedAt: new Date(), feeWaivedBy: adminId })
        .where(
          and(
            eq(bookings.id, bookingId),
            eq(bookings.status, 'CANCELLED'),
            isNotNull(bookings.cancelFee),
            isNull(bookings.feeWaivedAt),
          ),
        )
        .returning({ id: bookings.id });
      if (!done) throw new ConflictException('Nothing to waive');
      const [refund] = await tx
        .update(cancelRefunds)
        .set({ status: 'CANCELLED' })
        .where(and(eq(cancelRefunds.bookingId, bookingId), eq(cancelRefunds.status, 'DUE')))
        .returning({ id: cancelRefunds.id });
      // Returned meanwhile (another trainer's tap): keep the fee, nothing changes
      if (!refund && booking.refundStatus === 'DUE') throw new ConflictException('Money already returned');
      await this.entitlements.syncSpend(tx, bookingId);
    });
    return { ok: true };
  }

  async updateBookingAttendance(bookingId: string, dto: UpdateAttendanceDto, adminId: string) {
    // Only bookings on this trainer's own trainings
    const [booking] = await this.database.db
      .select({ id: bookings.id })
      .from(bookings)
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .where(and(eq(bookings.id, bookingId), eq(trainingSlots.trainerId, adminId)))
      .limit(1);

    if (!booking) throw new NotFoundException('Booking not found');

    const now = new Date();
    // The mark and the package move together: ✓ / ✗ spends a training, «—» gives it back
    await this.database.db.transaction(async (tx) => {
      if (dto.status === 'UNMARKED') {
        await tx.delete(attendance).where(eq(attendance.bookingId, bookingId));
      } else {
        await tx
          .insert(attendance)
          .values({ bookingId, status: dto.status, markedAt: now, markedByAdminId: adminId })
          .onConflictDoUpdate({
            target: attendance.bookingId,
            set: { status: dto.status, markedAt: now, markedByAdminId: adminId },
          });
      }
      await this.entitlements.syncSpend(tx, bookingId);
    });

    return { ok: true };
  }

  // A guest's mark: for the trainer's count only, nothing is spent. Only guests on this trainer's trainings
  async updateGuestAttendance(guestId: string, dto: UpdateAttendanceDto, adminId: string) {
    const [guest] = await this.database.db
      .select({ id: bookingGuests.id })
      .from(bookingGuests)
      .innerJoin(bookings, eq(bookings.id, bookingGuests.bookingId))
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .where(and(eq(bookingGuests.id, guestId), eq(trainingSlots.trainerId, adminId)))
      .limit(1);
    if (!guest) throw new NotFoundException('Guest not found');
    const marked = dto.status !== 'UNMARKED';
    await this.database.db
      .update(bookingGuests)
      .set({
        attendance: marked ? dto.status : null,
        markedAt: marked ? new Date() : null,
        markedByAdminId: marked ? adminId : null,
      })
      .where(eq(bookingGuests.id, guestId));
    return { ok: true };
  }

  // A trainer works with their own clients plus unassigned ones (to claim them); other trainers' clients are hidden
  private visibleTo(adminId: string) {
    return or(eq(members.trainerId, adminId), isNull(members.trainerId))!;
  }

  // Trainer's client list. trainerNote is admin-only — keep it out of member-facing queries
  async getMembers(adminId: string, onlyId?: string) {
    const since = new Date(Date.now() - CANCELLATION_STATS_DAYS * 24 * 60 * 60 * 1000);
    // Cancellations only (a move to another slot isn't a missed training)
    // Raw, fully qualified SQL: in a single-table select drizzle drops table names, and an unqualified
    // "id" inside the subquery would bind to bookings.id
    const cancelledCount = sql<number>`(
      SELECT count(*)::int FROM bookings b
      WHERE b.member_id = "members"."id"
        AND b.status = 'CANCELLED'
        AND b.cancellation_reason IS NOT NULL
        AND b.switched_to_slot_id IS NULL
        AND b.cancelled_at >= ${since}
    )`;
    const rows = await this.database.db
      .select({
        id: members.id,
        memberCode: members.memberCode,
        displayName: members.displayName,
        trainerNote: members.trainerNote,
        trainerId: members.trainerId,
        createdAt: members.createdAt,
        recentCancellations: cancelledCount,
      })
      .from(members)
      .where(onlyId ? and(this.visibleTo(adminId), eq(members.id, onlyId)) : this.visibleTo(adminId))
      .orderBy(asc(members.displayName));

    // «карта до DD.MM», «Перс. 5 · Спліт 2» under each client
    const summaries = await this.entitlements.summaries(rows.map((r) => r.id));
    // «❄ до DD.MM» (last frozen day) under a frozen client
    const today = this.clock.now().toISODate()!;
    const freezes = await loadFreezes(
      this.database.db,
      rows.map((r) => r.id),
    );
    return rows.map((r) => {
      const f = freezes.find((x) => x.memberId === r.id && frozenOn(x, today));
      return {
        ...r,
        clubCard: null,
        packagesLeft: [],
        ...summaries.get(r.id),
        frozenUntil: f ? plusDays(f.endsOn!, -1) : null,
      };
    });
  }

  // For the reassign picker. Usernames only, never password hashes
  // All trainers (reassigning a client, the «Тренери» page): who invited whom, null = added by seed:admin
  // Disabled trainers stay in the list (with who disabled them); the pickers leave them out
  async getTrainers() {
    const inviter = alias(admins, 'inviter');
    const disabler = alias(admins, 'disabler');
    return this.database.db
      .select({
        id: admins.id,
        username: admins.username,
        createdAt: admins.createdAt,
        invitedBy: inviter.username,
        disabledAt: admins.disabledAt,
        disabledBy: disabler.username,
      })
      .from(admins)
      .leftJoin(inviter, eq(inviter.id, admins.invitedByAdminId))
      .leftJoin(disabler, eq(disabler.id, admins.disabledByAdminId))
      .orderBy(asc(admins.username));
  }

  // Hand a client to a trainer (or claim an unassigned one). Only the current trainer can do it; a disabled
  // trainer answers 404 like a missing one
  async assignTrainer(adminId: string, memberId: string, trainerId: string) {
    const [trainer] = await this.database.db
      .select({ id: admins.id })
      .from(admins)
      .where(and(eq(admins.id, trainerId), isNull(admins.disabledAt)))
      .limit(1);
    if (!trainer) throw new NotFoundException('Trainer not found');

    // Checked again in the update itself: the trainer may be disabled in between
    const [updated] = await this.database.db
      .update(members)
      .set({ trainerId })
      .where(
        and(
          eq(members.id, memberId),
          this.visibleTo(adminId),
          sql`exists (select 1 from admins a where a.id = ${trainerId} and a.disabled_at is null)`,
        ),
      )
      .returning({ id: members.id, trainerId: members.trainerId });
    if (!updated) throw new NotFoundException('Member not found');
    return updated;
  }

  // «Вимкнути» on «Тренери»: any trainer disables another one (not themselves, not the first trainer, whose group
  // trainings clients without a trainer see). In one transaction: the trainer can't sign in any more (sessions
  // revoked), their clients and the cash purchases waiting for them move to the chosen trainer, their trainings
  // not over yet (an hour after the start, as the 22:00 cron counts) are cancelled — the days stay, so other
  // trainers' schedules still fill them — and their automatic group trainings are switched off
  async disableTrainer(adminId: string, trainerId: string, transferToId: string) {
    if (trainerId === adminId) throw new BadRequestException('Cannot disable yourself');
    if (trainerId === (await getDefaultTrainerId(this.database.db)))
      throw new BadRequestException('Cannot disable the first trainer');
    if (transferToId === trainerId) throw new BadRequestException('Cannot transfer to the same trainer');

    const enabled = (id: string) =>
      this.database.db
        .select({ id: admins.id })
        .from(admins)
        .where(and(eq(admins.id, id), isNull(admins.disabledAt)))
        .limit(1);
    const [target] = await enabled(transferToId);
    if (!target) throw new NotFoundException('Trainer not found');
    const [trainer] = await this.database.db
      .select({ id: admins.id })
      .from(admins)
      .where(eq(admins.id, trainerId))
      .limit(1);
    if (!trainer) throw new NotFoundException('Trainer not found');

    const now = this.clock.now();
    const schedule = await loadTrainerSchedule(this.database.db, trainerId);

    const { movedClients, toCancel, affected } = await this.database.db.transaction(async (tx) => {
      const at = now.toJSDate();
      // Both trainers' rows locked in id order (two disables at once wait for each other, no deadlock), then the
      // chosen one checked again: it may have been disabled since the check above
      const locked = await tx
        .select({ id: admins.id, disabledAt: admins.disabledAt })
        .from(admins)
        .where(inArray(admins.id, [trainerId, transferToId]))
        .orderBy(asc(admins.id))
        .for('update');
      if (!locked.some((a) => a.id === transferToId && !a.disabledAt)) throw new NotFoundException('Trainer not found');
      const [disabled] = await tx
        .update(admins)
        .set({ disabledAt: at, disabledByAdminId: adminId })
        .where(and(eq(admins.id, trainerId), isNull(admins.disabledAt)))
        .returning({ id: admins.id });
      if (!disabled) throw new ConflictException('Trainer already disabled');

      await tx
        .update(sessions)
        .set({ revokedAt: at })
        .where(
          and(eq(sessions.principalType, 'admin'), eq(sessions.principalId, trainerId), isNull(sessions.revokedAt)),
        );
      const moved = await tx
        .update(members)
        .set({ trainerId: transferToId })
        .where(eq(members.trainerId, trainerId))
        .returning({ id: members.id });
      // Only the member's trainer confirms cash: the new one takes over the requests waiting in the hall
      await tx
        .update(purchases)
        .set({ trainerId: transferToId })
        .where(and(eq(purchases.trainerId, trainerId), eq(purchases.status, 'PENDING'), eq(purchases.method, 'CASH')));
      // Their phones get no trainer pushes any more
      await tx
        .update(adminPushSubscriptions)
        .set({ disabledAt: at })
        .where(and(eq(adminPushSubscriptions.adminId, trainerId), isNull(adminPushSubscriptions.disabledAt)));
      const settings = { bookingOpensAt: schedule.bookingOpensAt, autoCreate: false, updatedAt: at };
      await tx
        .insert(trainerSchedules)
        .values({ trainerId, ...settings })
        .onConflictDoUpdate({ target: trainerSchedules.trainerId, set: settings });

      // Read here, after the above: a training auto-added a moment ago is cancelled too, and the slot rows are
      // locked, so a member booking at this moment waits and then finds the training cancelled (or was booked
      // already and is among those told)
      const fromToday = await tx
        .select({ id: trainingSlots.id, localDate: trainingDays.localDate, slotTime: trainingSlots.slotTime })
        .from(trainingSlots)
        .innerJoin(trainingDays, eq(trainingDays.id, trainingSlots.trainingDayId))
        .where(
          and(
            eq(trainingSlots.trainerId, trainerId),
            eq(trainingSlots.status, 'ACTIVE'),
            gte(trainingDays.localDate, now.toISODate()!),
          ),
        )
        .for('update', { of: trainingSlots });
      const slots = fromToday.filter((s) => slotStartsAt(s.localDate, s.slotTime).plus({ hours: 1 }) > now);
      const ids = slots.map((s) => s.id);
      const booked =
        ids.length > 0
          ? await tx
              .select({ memberId: bookings.memberId, slotId: bookings.slotId })
              .from(bookings)
              .where(and(inArray(bookings.slotId, ids), eq(bookings.status, 'ACTIVE')))
          : [];
      await this.cancelSlotsTx(tx, ids);
      return { movedClients: moved.length, toCancel: slots, affected: booked };
    });

    for (const slot of toCancel) {
      const memberIds = affected.filter((b) => b.slotId === slot.id).map((b) => b.memberId);
      if (memberIds.length > 0) {
        await this.notifications.enqueueAndProcess('SLOT_CANCELLED', `slot-cancelled:${slot.id}:${slot.localDate}`, {
          memberIds,
          slotTime: slot.slotTime,
          localDate: slot.localDate,
        });
      }
    }

    return { movedClients, cancelledTrainings: toCancel.length };
  }

  // Calendar modal: who cancelled or moved away from this slot and why
  async getSlotCancellations(adminId: string, slotId: string) {
    await this.ownSlot(adminId, slotId);
    // Members booked on it again (moved away and came back) are not shown as having cancelled
    const booked = await this.database.db
      .select({ memberId: bookings.memberId })
      .from(bookings)
      .where(and(eq(bookings.slotId, slotId), eq(bookings.status, 'ACTIVE')));
    const rows = await this.memberCancellations(eq(bookings.slotId, slotId));
    return rows.filter((r) => !booked.some((b) => b.memberId === r.memberId)).map(toCancellationView);
  }

  // Client page: the same row as in the list
  async getMember(adminId: string, memberId: string) {
    const [member] = await this.getMembers(adminId, memberId);
    if (!member) throw new NotFoundException('Member not found');
    return member;
  }

  // Client page: trainings the member was booked on up to today, with the trainer's mark (newest first)
  async getMemberVisits(adminId: string, memberId: string) {
    const [member] = await this.database.db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.id, memberId), this.visibleTo(adminId)))
      .limit(1);
    if (!member) throw new NotFoundException('Member not found');

    const rows = await this.database.db
      .select({
        bookingId: bookings.id,
        localDate: trainingDays.localDate,
        slotTime: trainingSlots.slotTime,
        trainingType: trainingSlots.trainingType,
        status: attendance.status,
      })
      .from(bookings)
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .innerJoin(trainingDays, eq(trainingDays.id, trainingSlots.trainingDayId))
      .leftJoin(attendance, eq(attendance.bookingId, bookings.id))
      .where(
        and(
          eq(bookings.memberId, memberId),
          eq(bookings.status, 'ACTIVE'),
          eq(trainingSlots.status, 'ACTIVE'),
          lte(trainingDays.localDate, sql`(now() at time zone 'Europe/Kyiv')::date`),
        ),
      )
      .orderBy(desc(trainingDays.localDate), desc(trainingSlots.slotTime))
      .limit(MEMBER_HISTORY_LIMIT);
    return rows.map(({ status, ...r }) => ({
      ...r,
      attendance: (status ?? 'UNMARKED') as 'PRESENT' | 'ABSENT' | 'UNMARKED',
    }));
  }

  // Clients page: one member's latest cancellations and moves
  async getMemberCancellations(adminId: string, memberId: string) {
    const [member] = await this.database.db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.id, memberId), this.visibleTo(adminId)))
      .limit(1);
    if (!member) throw new NotFoundException('Member not found');

    const rows = await this.memberCancellations(eq(bookings.memberId, memberId), MEMBER_HISTORY_LIMIT);
    return rows.map((r) => ({ ...toCancellationView(r), localDate: r.localDate, slotTime: r.slotTime }));
  }

  // Bookings the member cancelled or moved themselves (they always write a reason). System cancellations
  // (expired payment, trainer cancelled the slot) have no reason and are left out
  private async memberCancellations(filter: SQL, limit?: number) {
    const target = alias(trainingSlots, 'target_slot');
    const query = this.database.db
      .select({
        bookingId: bookings.id,
        slotId: bookings.slotId,
        memberId: bookings.memberId,
        displayName: members.displayName,
        reason: bookings.cancellationReason,
        cancelledAt: bookings.cancelledAt,
        slotTime: trainingSlots.slotTime,
        localDate: trainingDays.localDate,
        switchedToSlotId: bookings.switchedToSlotId,
        switchedToTime: target.slotTime,
        cancelFee: bookings.cancelFee,
        feeWaivedAt: bookings.feeWaivedAt,
        refundUah: cancelRefunds.amountUah,
        refundStatus: cancelRefunds.status,
      })
      .from(bookings)
      .innerJoin(members, eq(members.id, bookings.memberId))
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .innerJoin(trainingDays, eq(trainingDays.id, trainingSlots.trainingDayId))
      .leftJoin(target, eq(target.id, bookings.switchedToSlotId))
      .leftJoin(cancelRefunds, eq(cancelRefunds.bookingId, bookings.id))
      .where(and(eq(bookings.status, 'CANCELLED'), isNotNull(bookings.cancellationReason), filter))
      .orderBy(desc(bookings.cancelledAt));
    return limit ? query.limit(limit) : query;
  }

  async updateMemberNote(adminId: string, memberId: string, dto: UpdateMemberNoteDto) {
    const note = dto.note.trim();
    const [updated] = await this.database.db
      .update(members)
      .set({ trainerNote: note || null })
      .where(and(eq(members.id, memberId), this.visibleTo(adminId)))
      .returning({ id: members.id, trainerNote: members.trainerNote });

    if (!updated) throw new NotFoundException('Member not found');
    return updated;
  }
}
