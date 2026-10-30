import { Injectable } from '@nestjs/common';
import { eq, and, or, inArray, gte, lt, lte, desc, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DatabaseService } from '../database/database.service';
import {
  trainingDays,
  trainingSlots,
  bookings,
  members,
  attendance,
  slotMembers,
  packageSpends,
  bookingGuests,
} from '../database/schema';
import { ClockService } from '../clock/clock.service';
import { EntitlementsService } from '../purchases/entitlements.service';
import { loadTrainerSchedule } from '../trainer-schedule/trainer-schedule.store';
import { requireOwnSlot } from '../schedule/default-trainer';
import { bookingOpensAt } from '../trainer-schedule/rules';
import { GROUP_TYPE, KY_ZONE, isAssignedType, slotStartsAt } from '../schedule/training-types';
import { markOf, memberCancellations, toCancellationView } from './admin-views';

const HISTORY_PAGE_DAYS = 14;

// Read side of the trainer's trainings: today page, history, calendar, cancellations
@Injectable()
export class AdminScheduleService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clock: ClockService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async getSchedule(adminId: string) {
    const now = this.clock.now();
    const today = now.toISODate()!;

    const upcoming = await this.database.db
      .select()
      .from(trainingDays)
      .where(and(eq(trainingDays.status, 'SCHEDULED'), gte(trainingDays.localDate, today), this.hasSlotsOf(adminId)))
      .orderBy(trainingDays.localDate)
      .limit(30);

    // Today stays until midnight so late marks are possible
    const targetDay =
      upcoming.find((day) => now < DateTime.fromISO(day.localDate, { zone: KY_ZONE }).endOf('day')) ?? upcoming[0];

    if (!targetDay) return null;

    const slots = await this.database.db
      .select()
      .from(trainingSlots)
      .where(and(eq(trainingSlots.trainingDayId, targetDay.id), eq(trainingSlots.trainerId, adminId)))
      .orderBy(trainingSlots.slotTime);

    // Window: trainer's opening time to the last group start (no group training: midnight)
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

  // Past days, newest first. Cursor: pass the last localDate as `before`
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

  // Table names explicit: drizzle drops them in a single-table select
  private hasSlotsOf(adminId: string) {
    return sql`exists (select 1 from training_slots ts where ts.training_day_id = "training_days"."id" and ts.trainer_id = ${adminId})`;
  }

  // Today page and history: participants with marks, who moved in, who cancelled or moved away
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

    // Cancelled from these slots or moved into them
    const cancellations = await memberCancellations(
      this.database.db,
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
            attendanceStatus: markOf(p.attendanceStatus),
            switchedFromTime:
              cancellations.find((c) => c.switchedToSlotId === s.id && c.memberId === p.memberId)?.slotTime ?? null,
            guestOf: null as string | null,
          };
          // Guest row right after its member; bookingId is the guest id (PATCH /admin/guests/:id/attendance)
          const guest = guestRows.find((g) => g.bookingId === p.bookingId);
          return guest
            ? [
                member,
                {
                  bookingId: guest.id,
                  displayName: guest.name,
                  attendanceStatus: markOf(guest.attendance),
                  switchedFromTime: null,
                  guestOf: p.displayName,
                },
              ]
            : [member];
        }),
      // Moved away and back: a participant, not a cancellation
      cancellations: cancellations
        .filter(
          (c) => c.slotId === s.id && !participantRows.some((p) => p.slotId === s.id && p.memberId === c.memberId),
        )
        .map(toCancellationView),
    }));
  }

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
    // Per member: still booked, already spent, trainings left of that type
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
          // Spent counts as paid even if the package is empty now
          spent: booked.some((b) => b.slotId === r.slotId && b.memberId === id && !!b.spentFrom),
          packageLeft: summaries.get(id)?.packagesLeft.find((p) => p.trainingType === r.trainingType)?.left ?? 0,
        })),
    }));
  }

  async getSlotCancellations(adminId: string, slotId: string) {
    await requireOwnSlot(this.database.db, adminId, slotId);
    // Moved away and back: not a cancellation
    const booked = await this.database.db
      .select({ memberId: bookings.memberId })
      .from(bookings)
      .where(and(eq(bookings.slotId, slotId), eq(bookings.status, 'ACTIVE')));
    const rows = await memberCancellations(this.database.db, eq(bookings.slotId, slotId));
    return rows.filter((r) => !booked.some((b) => b.memberId === r.memberId)).map(toCancellationView);
  }
}
