import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { eq, and, or, inArray, gte, lte, asc, desc, isNotNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DateTime } from 'luxon';
import { DatabaseService } from '../database/database.service';
import { trainingDays, trainingSlots, bookings, members, attendance, slotMembers } from '../database/schema';
import type { UpsertTrainingDayDto } from './dto/upsert-training-day.dto';
import type { UpdateSlotDto } from './dto/update-slot.dto';
import type { UpdateAttendanceDto } from './dto/update-attendance.dto';
import type { UpdateMemberNoteDto } from './dto/update-member-note.dto';
import type { CreateAssignedSlotDto } from './dto/create-assigned-slot.dto';
import { NotificationService } from '../notifications/notification.service';
import { DemoService } from '../demo/demo.service';
import {
  GROUP_SLOT_TIMES,
  GROUP_TYPE,
  KY_ZONE,
  ASSIGNED_MEMBER_LIMITS,
  isAssignedType,
  slotStartsAt,
} from '../schedule/training-types';

const SLOT_TIMES = GROUP_SLOT_TIMES;
const DEFAULT_WEEKDAYS = [1, 3, 5]; // Mon, Wed, Fri

// Member-initiated cancellations / moves shown to the coach (with the reason they wrote)
const CANCELLATION_STATS_DAYS = 30;
const MEMBER_HISTORY_LIMIT = 20;

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
    private readonly demoService: DemoService,
  ) {}

  async getSchedule() {
    const now = await this.demoService.getNow();
    const today = now.toISODate()!;

    const upcoming = await this.database.db
      .select()
      .from(trainingDays)
      .where(eq(trainingDays.status, 'SCHEDULED'))
      .orderBy(trainingDays.localDate)
      .limit(30);

    const future = upcoming.filter((d) => d.localDate >= today);
    let targetDay = future.find((day) => {
      const closeAt = DateTime.fromISO(`${day.localDate}T21:00:00`, { zone: KY_ZONE });
      return now < closeAt;
    }) ?? future[0];

    if (!targetDay) return null;

    const openAt = DateTime.fromISO(`${targetDay.localDate}T14:00:00`, { zone: KY_ZONE });
    const closeAt = DateTime.fromISO(`${targetDay.localDate}T21:00:00`, { zone: KY_ZONE });
    const bookingWindowOpen = now >= openAt && now < closeAt;

    const slots = await this.database.db
      .select()
      .from(trainingSlots)
      .where(eq(trainingSlots.trainingDayId, targetDay.id))
      .orderBy(trainingSlots.slotTime);

    const slotIds = slots.map((s) => s.id);

    const participantRows =
      slotIds.length > 0
        ? await this.database.db
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
            .orderBy(bookings.createdAt)
        : [];

    // Cancelled from these slots, and moved here from another slot (for "перейшла з 19:00")
    const cancellations =
      slotIds.length > 0
        ? await this.memberCancellations(
            or(inArray(bookings.slotId, slotIds), inArray(bookings.switchedToSlotId, slotIds))!,
          )
        : [];

    return {
      localDate: targetDay.localDate,
      status: targetDay.status,
      bookingWindowOpen,
      bookingOpenAt: openAt.toUTC().toISO(),
      bookingCloseAt: closeAt.toUTC().toISO(),
      serverTime: now.toUTC().toISO(),
      isDemoMode: this.demoService.isDemoMode(),
      slots: slots.map((s) => {
        const participants = participantRows
          .filter((p) => p.slotId === s.id)
          .map((p) => ({
            bookingId: p.bookingId,
            displayName: p.displayName,
            attendanceStatus: (p.attendanceStatus ?? 'UNMARKED') as 'PRESENT' | 'ABSENT' | 'UNMARKED',
            switchedFromTime:
              cancellations.find((c) => c.switchedToSlotId === s.id && c.memberId === p.memberId)?.slotTime ?? null,
          }));
        return {
          id: s.id,
          slotTime: s.slotTime,
          status: s.status,
          trainingType: s.trainingType,
          capacity: s.capacity,
          bookedCount: s.bookedCount,
          participants,
          cancellations: cancellations.filter((c) => c.slotId === s.id).map(toCancellationView),
        };
      }),
    };
  }

  async getCalendar(month: string) {
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
    // Per-member payment state: the coach needs who paid, not a count
    const booked =
      assignedIds.length > 0
        ? await this.database.db
            .select({ slotId: bookings.slotId, memberId: bookings.memberId, paymentStatus: bookings.paymentStatus })
            .from(bookings)
            .where(and(inArray(bookings.slotId, assignedIds), eq(bookings.status, 'ACTIVE')))
        : [];

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
          // 'PAID' | 'PENDING' (on LiqPay, seat held) | null (has not started paying)
          paymentStatus:
            booked.find((b) => b.slotId === r.slotId && b.memberId === id)?.paymentStatus ?? null,
        })),
    }));
  }

  // Group slot at 19:00 / 20:00. Re-activates a cancelled slot at that time, but never takes over an active assigned one
  async upsertGroupSlot(date: string, slotTime: string) {
    if (!SLOT_TIMES.includes(slotTime)) throw new BadRequestException('Group trainings are at 19:00 and 20:00');

    await this.database.db.transaction(async (tx) => {
      const dayId = await this.ensureDay(tx, date);
      const [slot] = await tx
        .insert(trainingSlots)
        .values({ trainingDayId: dayId, slotTime, status: 'ACTIVE', trainingType: GROUP_TYPE, capacity: 8, bookedCount: 0 })
        .onConflictDoUpdate({
          target: [trainingSlots.trainingDayId, trainingSlots.slotTime],
          set: { trainingType: GROUP_TYPE, status: 'ACTIVE', capacity: 8, cancelledAt: null },
          setWhere: or(eq(trainingSlots.status, 'CANCELLED'), eq(trainingSlots.trainingType, GROUP_TYPE)),
        })
        .returning({ id: trainingSlots.id });

      if (!slot) throw new ConflictException('Time is taken by an assigned training');
      // A re-used cancelled assigned slot must not stay visible only to its old members
      await tx.delete(slotMembers).where(eq(slotMembers.slotId, slot.id));
    });

    return { ok: true };
  }

  // Personal (1 member) or split (1–3 members) at any time; seen and booked only by those members
  async createAssignedSlot(date: string, dto: CreateAssignedSlotDto) {
    await this.validateSlotMembers(dto.trainingType, dto.memberIds);

    const startsAt = slotStartsAt(date, dto.slotTime);
    if (!startsAt.isValid) throw new BadRequestException('Invalid date');
    const now = await this.demoService.getNow();
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
        })
        .onConflictDoUpdate({
          target: [trainingSlots.trainingDayId, trainingSlots.slotTime],
          set: { trainingType: dto.trainingType, status: 'ACTIVE', capacity, bookedCount: 0, cancelledAt: null },
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
  async updateSlotMembers(slotId: string, memberIds: string[]) {
    await this.database.db.transaction(async (tx) => {
      const [slot] = await tx
        .select()
        .from(trainingSlots)
        .where(eq(trainingSlots.id, slotId))
        .for('update')
        .limit(1);

      if (!slot) throw new NotFoundException('Slot not found');
      if (!isAssignedType(slot.trainingType)) throw new BadRequestException('Group trainings are open to everyone');
      if (slot.status !== 'ACTIVE') throw new ConflictException('Slot is cancelled');

      await this.validateSlotMembers(slot.trainingType, memberIds, tx);

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

  private async validateSlotMembers(trainingType: string, memberIds: string[], db: Db | Tx = this.database.db) {
    const limits = ASSIGNED_MEMBER_LIMITS[trainingType];
    if (!limits || memberIds.length < limits.min || memberIds.length > limits.max) {
      throw new BadRequestException(`${trainingType}: ${limits?.min}–${limits?.max} members`);
    }
    const found = await db.select({ id: members.id }).from(members).where(inArray(members.id, memberIds));
    if (found.length !== new Set(memberIds).size) throw new NotFoundException('Member not found');
  }

  // Training day row for the date, (re)scheduled. Returns its id
  private async ensureDay(tx: Tx, date: string) {
    const isException = !DEFAULT_WEEKDAYS.includes(DateTime.fromISO(date, { zone: KY_ZONE }).weekday);
    const [day] = await tx
      .insert(trainingDays)
      .values({ localDate: date, status: 'SCHEDULED', isException, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: trainingDays.localDate,
        set: { status: 'SCHEDULED', updatedAt: new Date() },
      })
      .returning({ id: trainingDays.id });
    return day.id;
  }

  async upsertTrainingDay(date: string, dto: UpsertTrainingDayDto) {
    await this.database.db
      .insert(trainingDays)
      .values({
        localDate: date,
        status: dto.status,
        trainingType: dto.trainingType ?? 'групові',
        isException: dto.isException ?? false,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: trainingDays.localDate,
        set: {
          status: dto.status,
          trainingType: dto.trainingType ?? 'групові',
          isException: dto.isException ?? false,
          updatedAt: new Date(),
        },
      });

    const [day] = await this.database.db
      .select()
      .from(trainingDays)
      .where(eq(trainingDays.localDate, date))
      .limit(1);

    if (!day) throw new NotFoundException('Training day not found after upsert');

    if (dto.status === 'SCHEDULED') {
      const slotValues = SLOT_TIMES.map((slotTime) => ({
        trainingDayId: day.id,
        slotTime,
        status: 'ACTIVE' as const,
        capacity: 8,
        bookedCount: 0,
      }));
      await this.database.db.insert(trainingSlots).values(slotValues).onConflictDoNothing();
    }

    if (dto.status === 'CANCELLED') {
      const daySlots = await this.database.db
        .select({ id: trainingSlots.id, slotTime: trainingSlots.slotTime })
        .from(trainingSlots)
        .where(eq(trainingSlots.trainingDayId, day.id));

      if (daySlots.length > 0) {
        const daySlotIds = daySlots.map((s) => s.id);

        const affectedBookings = await this.database.db
          .select({ memberId: bookings.memberId, slotId: bookings.slotId })
          .from(bookings)
          .where(and(inArray(bookings.slotId, daySlotIds), eq(bookings.status, 'ACTIVE')));

        await this.database.db.transaction(async (tx) => {
          await tx
            .update(bookings)
            .set({ status: 'CANCELLED', cancelledAt: new Date() })
            .where(and(inArray(bookings.slotId, daySlotIds), eq(bookings.status, 'ACTIVE')));

          await tx
            .update(trainingSlots)
            .set({ status: 'CANCELLED', bookedCount: 0, cancelledAt: new Date() })
            .where(inArray(trainingSlots.id, daySlotIds));
        });

        for (const slot of daySlots) {
          const memberIds = affectedBookings
            .filter((b) => b.slotId === slot.id)
            .map((b) => b.memberId);
          if (memberIds.length > 0) {
            await this.notifications.enqueueAndProcess('SLOT_CANCELLED', `slot-cancelled:${slot.id}:${date}`, {
              memberIds,
              slotTime: slot.slotTime,
              localDate: date,
            });
          }
        }
      }
    }

    const slots = await this.database.db
      .select()
      .from(trainingSlots)
      .where(eq(trainingSlots.trainingDayId, day.id))
      .orderBy(trainingSlots.slotTime);

    return { ...day, slots };
  }

  async updateSlot(slotId: string, dto: UpdateSlotDto) {
    const [slot] = await this.database.db
      .select()
      .from(trainingSlots)
      .where(eq(trainingSlots.id, slotId))
      .limit(1);

    if (!slot) throw new NotFoundException('Slot not found');

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
    const [booking] = await this.database.db
      .select()
      .from(bookings)
      .where(eq(bookings.id, bookingId))
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

  // Coach's client list. trainerNote is admin-only — keep it out of member-facing queries
  async getMembers() {
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
        createdAt: members.createdAt,
        recentCancellations: cancelledCount,
      })
      .from(members)
      .orderBy(asc(members.displayName));
  }

  // Calendar modal: who cancelled or moved away from this slot and why
  async getSlotCancellations(slotId: string) {
    return (await this.memberCancellations(eq(bookings.slotId, slotId))).map(toCancellationView);
  }

  // Clients page: one member's latest cancellations and moves
  async getMemberCancellations(memberId: string) {
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

  async updateMemberNote(memberId: string, dto: UpdateMemberNoteDto) {
    const note = dto.note.trim();
    const [updated] = await this.database.db
      .update(members)
      .set({ trainerNote: note || null })
      .where(eq(members.id, memberId))
      .returning({ id: members.id, trainerNote: members.trainerNote });

    if (!updated) throw new NotFoundException('Member not found');
    return updated;
  }
}
