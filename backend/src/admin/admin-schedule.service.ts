import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { eq, and, or, inArray, gte, lt, lte, asc, desc, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DateTime } from 'luxon';
import { DatabaseService } from '../database/database.service';
import { trainingDays, trainingSlots, bookings, members, attendance, slotMembers, admins } from '../database/schema';
import type { UpsertTrainingDayDto } from './dto/upsert-training-day.dto';
import type { UpdateSlotDto } from './dto/update-slot.dto';
import type { UpdateAttendanceDto } from './dto/update-attendance.dto';
import type { UpdateMemberNoteDto } from './dto/update-member-note.dto';
import type { CreateAssignedSlotDto } from './dto/create-assigned-slot.dto';
import { NotificationService } from '../notifications/notification.service';
import { ClockService } from '../clock/clock.service';
import {
  GROUP_SLOT_TIMES,
  GROUP_TYPE,
  KY_ZONE,
  ASSIGNED_MEMBER_LIMITS,
  isAssignedType,
  slotStartsAt,
} from '../schedule/training-types';


// Member-initiated cancellations / moves shown to the coach (with the reason they wrote)
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
};

function toCancellationView(r: CancellationRow) {
  return {
    bookingId: r.bookingId,
    displayName: r.displayName,
    reason: r.reason ?? '',
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    switchedToTime: r.switchedToTime, // null = cancelled, otherwise moved to that time
  };
}

@Injectable()
export class AdminScheduleService {
  constructor(
    private readonly database: DatabaseService,
    private readonly notifications: NotificationService,
    private readonly clock: ClockService,
  ) {}

  // The coach's next training day with their own slots
  async getSchedule(adminId: string) {
    const now = this.clock.now();
    const today = now.toISODate()!;

    const upcoming = await this.database.db
      .select()
      .from(trainingDays)
      .where(and(eq(trainingDays.status, 'SCHEDULED'), gte(trainingDays.localDate, today), this.hasSlotsOf(adminId)))
      .orderBy(trainingDays.localDate)
      .limit(30);

    const targetDay = upcoming.find((day) => {
      const closeAt = DateTime.fromISO(`${day.localDate}T21:00:00`, { zone: KY_ZONE });
      return now < closeAt;
    }) ?? upcoming[0];

    if (!targetDay) return null;

    const openAt = DateTime.fromISO(`${targetDay.localDate}T14:00:00`, { zone: KY_ZONE });
    const closeAt = DateTime.fromISO(`${targetDay.localDate}T21:00:00`, { zone: KY_ZONE });
    const bookingWindowOpen = now >= openAt && now < closeAt;

    const slots = await this.database.db
      .select()
      .from(trainingSlots)
      .where(and(eq(trainingSlots.trainingDayId, targetDay.id), eq(trainingSlots.coachId, adminId)))
      .orderBy(trainingSlots.slotTime);

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

  // Past training days, newest first, for the coach's history (attendance stays editable there).
  // Cursor pagination: pass the last returned localDate as `before` to get older days
  async getHistory(adminId: string, before?: string) {
    const today = this.clock.now().toISODate()!;
    const cursor = before && before < today ? before : today;

    const days = await this.database.db
      .select({ id: trainingDays.id, localDate: trainingDays.localDate, status: trainingDays.status })
      .from(trainingDays)
      .where(
        and(
          lt(trainingDays.localDate, cursor),
          this.hasSlotsOf(adminId),
        ),
      )
      .orderBy(desc(trainingDays.localDate))
      .limit(HISTORY_PAGE_DAYS + 1);

    const page = days.slice(0, HISTORY_PAGE_DAYS);
    const slots =
      page.length > 0
        ? await this.database.db
            .select()
            .from(trainingSlots)
            .where(and(inArray(trainingSlots.trainingDayId, page.map((d) => d.id)), eq(trainingSlots.coachId, adminId)))
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

  // Days with at least one slot of this coach. Raw, fully qualified SQL (see the drizzle note in CLAUDE.md)
  private hasSlotsOf(adminId: string) {
    return sql`exists (select 1 from training_slots ts where ts.training_day_id = "training_days"."id" and ts.coach_id = ${adminId})`;
  }

  // The slot if it belongs to this coach; another coach's slot answers 404 like a missing one
  private async ownSlot(adminId: string, slotId: string, db: Db | Tx = this.database.db, lock = false) {
    const query = db.select().from(trainingSlots).where(eq(trainingSlots.id, slotId));
    const [slot] = await (lock ? query.for('update').limit(1) : query.limit(1));
    if (!slot || slot.coachId !== adminId) throw new NotFoundException('Slot not found');
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
        .map((p) => ({
          bookingId: p.bookingId,
          displayName: p.displayName,
          attendanceStatus: (p.attendanceStatus ?? 'UNMARKED') as 'PRESENT' | 'ABSENT' | 'UNMARKED',
          switchedFromTime:
            cancellations.find((c) => c.switchedToSlotId === s.id && c.memberId === p.memberId)?.slotTime ?? null,
        })),
      cancellations: cancellations.filter((c) => c.slotId === s.id).map(toCancellationView),
    }));
  }

  // Own slots in full. Other coaches' slots come only as busy times (one gym): no type, counts or names
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
        coachId: trainingSlots.coachId,
      })
      .from(trainingDays)
      .innerJoin(trainingSlots, eq(trainingSlots.trainingDayId, trainingDays.id))
      .where(
        and(
          gte(trainingDays.localDate, start),
          lte(trainingDays.localDate, end),
          eq(trainingSlots.status, 'ACTIVE'),
          eq(trainingDays.status, 'SCHEDULED'),
        ),
      )
      .orderBy(trainingDays.localDate, trainingSlots.slotTime);

    const assignedIds = rows
      .filter((r) => r.coachId === adminId && isAssignedType(r.trainingType))
      .map((r) => r.slotId);
    const assigned =
      assignedIds.length > 0
        ? await this.database.db
            .select({ slotId: slotMembers.slotId, id: members.id, displayName: members.displayName })
            .from(slotMembers)
            .innerJoin(members, eq(members.id, slotMembers.memberId))
            .where(inArray(slotMembers.slotId, assignedIds))
            .orderBy(slotMembers.createdAt)
        : [];
    // Per-member payment state: the coach needs who paid, not a count
    const booked =
      assignedIds.length > 0
        ? await this.database.db
            .select({ slotId: bookings.slotId, memberId: bookings.memberId, paymentStatus: bookings.paymentStatus })
            .from(bookings)
            .where(and(inArray(bookings.slotId, assignedIds), eq(bookings.status, 'ACTIVE')))
        : [];

    return rows.map((r) =>
      r.coachId !== adminId
        ? { localDate: r.localDate, slotId: r.slotId, slotTime: r.slotTime, isMine: false as const }
        : {
      isMine: true as const,
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
          // 'PAID' | 'PENDING' (on LiqPay, seat held) | null (has not started paying)
          paymentStatus:
            booked.find((b) => b.slotId === r.slotId && b.memberId === id)?.paymentStatus ?? null,
        })),
    });
  }

  // Group slot at 19:00 / 20:00. Re-activates a cancelled slot at that time, but never takes over an active assigned one
  async upsertGroupSlot(adminId: string, date: string, slotTime: string) {
    if (!GROUP_SLOT_TIMES.includes(slotTime)) throw new BadRequestException('Group trainings are at 19:00 and 20:00');

    await this.database.db.transaction(async (tx) => {
      const dayId = await this.ensureDay(tx, date);
      const [slot] = await tx
        .insert(trainingSlots)
        .values({
          trainingDayId: dayId,
          slotTime,
          status: 'ACTIVE',
          trainingType: GROUP_TYPE,
          capacity: 8,
          bookedCount: 0,
          coachId: adminId,
        })
        .onConflictDoUpdate({
          target: [trainingSlots.trainingDayId, trainingSlots.slotTime],
          set: { trainingType: GROUP_TYPE, status: 'ACTIVE', capacity: 8, cancelledAt: null, coachId: adminId },
          // a cancelled slot is free to take; an active one only if it is already this coach's group slot
          setWhere: or(
            eq(trainingSlots.status, 'CANCELLED'),
            and(eq(trainingSlots.trainingType, GROUP_TYPE), eq(trainingSlots.coachId, adminId)),
          ),
        })
        .returning({ id: trainingSlots.id });

      if (!slot) throw new ConflictException('Time is already taken');
      // A re-used cancelled assigned slot must not stay visible only to its old members
      await tx.delete(slotMembers).where(eq(slotMembers.slotId, slot.id));
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
          bookedCount: 0,
          coachId: adminId,
        })
        .onConflictDoUpdate({
          target: [trainingSlots.trainingDayId, trainingSlots.slotTime],
          set: { trainingType: dto.trainingType, status: 'ACTIVE', capacity, bookedCount: 0, cancelledAt: null, coachId: adminId },
          // Only a cancelled slot may be re-used (its bookings are all cancelled)
          setWhere: eq(trainingSlots.status, 'CANCELLED'),
        })
        .returning({ id: trainingSlots.id });

      if (!slot) throw new ConflictException('Time is already taken');

      await tx.delete(slotMembers).where(eq(slotMembers.slotId, slot.id));
      await tx.insert(slotMembers).values(dto.memberIds.map((memberId) => ({ slotId: slot.id, memberId })));
      return slot.id;
    });

    return { ok: true, slotId };
  }

  // Change who an assigned slot is for. Members who already booked it cannot be removed
  async updateSlotMembers(adminId: string, slotId: string, memberIds: string[]) {
    await this.database.db.transaction(async (tx) => {
      const slot = await this.ownSlot(adminId, slotId, tx, true);
      if (!isAssignedType(slot.trainingType)) throw new BadRequestException('Group trainings are open to everyone');
      if (slot.status !== 'ACTIVE') throw new ConflictException('Slot is cancelled');

      await this.validateSlotMembers(adminId, slot.trainingType, memberIds, tx, slotId);

      const booked = await tx
        .select({ memberId: bookings.memberId })
        .from(bookings)
        .where(and(eq(bookings.slotId, slotId), eq(bookings.status, 'ACTIVE')));
      if (booked.some((b) => !memberIds.includes(b.memberId))) {
        throw new ConflictException('Member already booked this training');
      }

      await tx.delete(slotMembers).where(eq(slotMembers.slotId, slotId));
      await tx.insert(slotMembers).values(memberIds.map((memberId) => ({ slotId, memberId })));
    });

    return { ok: true };
  }

  // Members must be the coach's own or unassigned clients; on an existing slot, members already on it may stay
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
      .where(and(inArray(members.id, memberIds), alreadyOnSlot ? or(this.visibleTo(adminId), alreadyOnSlot) : this.visibleTo(adminId)));
    if (found.length !== new Set(memberIds).size) throw new NotFoundException('Member not found');
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

  // SCHEDULED: adds this coach's group slots (19:00 / 20:00, times taken by others are skipped).
  // CANCELLED: cancels only this coach's slots; the day itself is cancelled when nothing active is left on it
  async upsertTrainingDay(adminId: string, date: string, dto: UpsertTrainingDayDto) {
    if (dto.status === 'SCHEDULED') {
      await this.database.db.transaction(async (tx) => {
        const dayId = await this.ensureDay(tx, date);
        await tx
          .insert(trainingSlots)
          .values(GROUP_SLOT_TIMES.map((slotTime) => ({
            trainingDayId: dayId,
            slotTime,
            status: 'ACTIVE' as const,
            capacity: 8,
            bookedCount: 0,
            coachId: adminId,
          })))
          .onConflictDoNothing();
      });
      return { ok: true };
    }

    const [day] = await this.database.db
      .select()
      .from(trainingDays)
      .where(eq(trainingDays.localDate, date))
      .limit(1);
    if (!day) throw new NotFoundException('Training day not found');

    const mySlots = await this.database.db
      .select({ id: trainingSlots.id, slotTime: trainingSlots.slotTime })
      .from(trainingSlots)
      .where(
        and(
          eq(trainingSlots.trainingDayId, day.id),
          eq(trainingSlots.coachId, adminId),
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
      if (mySlotIds.length > 0) {
        await tx
          .update(bookings)
          .set({ status: 'CANCELLED', cancelledAt: new Date() })
          .where(and(inArray(bookings.slotId, mySlotIds), eq(bookings.status, 'ACTIVE')));
        await tx
          .update(trainingSlots)
          .set({ status: 'CANCELLED', bookedCount: 0, cancelledAt: new Date() })
          .where(inArray(trainingSlots.id, mySlotIds));
      }
      // Other coaches' trainings that day keep the day scheduled
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

      await this.database.db.transaction(async (tx) => {
        await tx
          .update(bookings)
          .set({ status: 'CANCELLED', cancelledAt: new Date() })
          .where(and(eq(bookings.slotId, slotId), eq(bookings.status, 'ACTIVE')));

        await tx
          .update(trainingSlots)
          .set({ status: 'CANCELLED', bookedCount: 0, cancelledAt: new Date() })
          .where(eq(trainingSlots.id, slotId));
      });

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

    const [updated] = await this.database.db
      .select()
      .from(trainingSlots)
      .where(eq(trainingSlots.id, slotId))
      .limit(1);

    return updated;
  }

  async markAllAttendance(slotId: string, adminId: string) {
    await this.ownSlot(adminId, slotId);
    const activeBookings = await this.database.db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.slotId, slotId), eq(bookings.status, 'ACTIVE')));

    if (activeBookings.length === 0) return { marked: 0 };

    const now = new Date();
    await this.database.db.transaction(async (tx) => {
      for (const booking of activeBookings) {
        await tx
          .insert(attendance)
          .values({ bookingId: booking.id, status: 'PRESENT', markedAt: now, markedByAdminId: adminId })
          .onConflictDoUpdate({
            target: attendance.bookingId,
            set: { status: 'PRESENT', markedAt: now, markedByAdminId: adminId },
          });
      }
    });

    return { marked: activeBookings.length };
  }

  async updateBookingAttendance(bookingId: string, dto: UpdateAttendanceDto, adminId: string) {
    // Only bookings on this coach's own trainings
    const [booking] = await this.database.db
      .select({ id: bookings.id })
      .from(bookings)
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .where(and(eq(bookings.id, bookingId), eq(trainingSlots.coachId, adminId)))
      .limit(1);

    if (!booking) throw new NotFoundException('Booking not found');

    const now = new Date();
    if (dto.status === 'UNMARKED') {
      await this.database.db.delete(attendance).where(eq(attendance.bookingId, bookingId));
    } else {
      await this.database.db
        .insert(attendance)
        .values({ bookingId, status: dto.status, markedAt: now, markedByAdminId: adminId })
        .onConflictDoUpdate({
          target: attendance.bookingId,
          set: { status: dto.status, markedAt: now, markedByAdminId: adminId },
        });
    }

    return { ok: true };
  }

  // A coach works with their own clients plus unassigned ones (to claim them); other coaches' clients are hidden
  private visibleTo(adminId: string) {
    return or(eq(members.coachId, adminId), isNull(members.coachId))!;
  }

  // Coach's client list. trainerNote is admin-only — keep it out of member-facing queries
  async getMembers(adminId: string) {
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
    return this.database.db
      .select({
        id: members.id,
        memberCode: members.memberCode,
        displayName: members.displayName,
        trainerNote: members.trainerNote,
        coachId: members.coachId,
        createdAt: members.createdAt,
        recentCancellations: cancelledCount,
      })
      .from(members)
      .where(this.visibleTo(adminId))
      .orderBy(asc(members.displayName));
  }

  // For the reassign picker. Usernames only, never password hashes
  async getCoaches() {
    return this.database.db
      .select({ id: admins.id, username: admins.username })
      .from(admins)
      .orderBy(asc(admins.username));
  }

  // Hand a client to a coach (or claim an unassigned one). Only the current coach can do it
  async assignCoach(adminId: string, memberId: string, coachId: string) {
    const [coach] = await this.database.db.select({ id: admins.id }).from(admins).where(eq(admins.id, coachId)).limit(1);
    if (!coach) throw new NotFoundException('Coach not found');

    const [updated] = await this.database.db
      .update(members)
      .set({ coachId })
      .where(and(eq(members.id, memberId), this.visibleTo(adminId)))
      .returning({ id: members.id, coachId: members.coachId });
    if (!updated) throw new NotFoundException('Member not found');
    return updated;
  }

  // Calendar modal: who cancelled or moved away from this slot and why
  async getSlotCancellations(adminId: string, slotId: string) {
    await this.ownSlot(adminId, slotId);
    return (await this.memberCancellations(eq(bookings.slotId, slotId))).map(toCancellationView);
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
  // (expired payment, coach cancelled the slot) have no reason and are left out
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
      })
      .from(bookings)
      .innerJoin(members, eq(members.id, bookings.memberId))
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .innerJoin(trainingDays, eq(trainingDays.id, bookings.trainingDayId))
      .leftJoin(target, eq(target.id, bookings.switchedToSlotId))
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
