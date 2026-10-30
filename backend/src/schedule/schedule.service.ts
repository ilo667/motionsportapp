import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { and, eq, gte, inArray, isNull } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import {
  trainingDays,
  trainingSlots,
  bookings,
  vacancyAlerts,
  announcements,
  slotMembers,
  packageSpends,
  admins,
  bookingGuests,
} from '../database/schema';
import { ClockService } from '../clock/clock.service';
import { PaymentService } from '../payment/payment.service';
import { EntitlementsService } from '../purchases/entitlements.service';
import { GROUP_TYPE, GROUP_CAPACITY, KY_ZONE, ASSIGNED_TYPES, slotStartsAt } from './training-types';
import { getMemberTrainerId } from './default-trainer';
import { loadTrainerSchedule } from '../trainer-schedule/trainer-schedule.store';
import { bookingOpensAt, groupTimeError } from '../trainer-schedule/rules';
import { loadFreezes } from '../freezes/freeze.store';
import { frozenOn, plusDays } from '../freezes/rules';
import { lateCancelledSlotIds } from '../booking/group-booking';
import { passUsableOn } from '../purchases/validity';

// An assigned slot stays visible until it ends; cancelling closes at the start
const ASSIGNED_SHOWN_FOR_MINUTES = 60;

type DayRow = typeof trainingDays.$inferSelect;

// cancelled = that training or the trainer's day is cancelled; taken = time occupied or a group within an hour
export type SkippedTraining = { date: string; slotTime: string; reason: 'cancelled' | 'taken' };
export type GroupSlotsResult = { added: number; skipped: SkippedTraining[] };

const GROUP_HORIZON_DAYS = 21;

@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);

  private groupSlotsEnsuredFor: string | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly clock: ClockService,
    private readonly paymentService: PaymentService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async getNext(memberId?: string) {
    // Must not break the schedule (slow LiqPay, deadlock with a callback); the next load retries
    await this.paymentService
      .expireStale()
      .catch((err: unknown) => this.logger.warn(`Expire stale payments failed: ${String(err)}`));
    await this.ensureGroupSlots();

    const now = this.clock.now();
    const today = now.toISODate()!;

    const assignedSlots = memberId ? await this.getAssignedSlots(memberId, now) : [];

    // Only the member's trainer (the first trainer for unassigned members and visitors)
    const trainerId = await getMemberTrainerId(this.database.db, memberId);
    const targetDay = await this.nextGroupDay(trainerId, now);
    const frozenUntil = memberId ? await this.frozenUntil(memberId, today, targetDay) : null;

    // No group day ahead: still return the assigned slots
    if (!targetDay) {
      return {
        localDate: null,
        status: null,
        bookingWindowOpen: false,
        bookingOpenAt: null,
        bookingCloseAt: null,
        slots: [],
        assignedSlots,
        groupPassLeft: 0,
        frozenUntil,
        serverTime: now.toUTC().toISO(),
        announcement: null,
      };
    }

    // Each slot closes at its start, so the day's window ends with the last one
    const { bookingOpensAt: opensAt } = await loadTrainerSchedule(this.database.db, trainerId!);
    const openAt = bookingOpensAt(targetDay.localDate, opensAt);
    const closeAt = slotStartsAt(targetDay.localDate, targetDay.lastTime);
    const bookingWindowOpen = now >= openAt && now < closeAt;

    const slots = await this.groupSlotViews(trainerId!, targetDay, memberId, now);
    const published = await this.publishedAnnouncement(targetDay.id);
    const announcement = bookingWindowOpen ? published : null;

    return {
      localDate: targetDay.localDate,
      status: targetDay.status,
      bookingWindowOpen,
      bookingOpenAt: openAt.toUTC().toISO(),
      bookingCloseAt: closeAt.toUTC().toISO(),
      slots,
      assignedSlots,
      // 0 = booking offers to buy a group pass
      groupPassLeft: memberId ? await this.entitlements.groupPassLeft(memberId, targetDay.localDate) : 0,
      frozenUntil,
      serverTime: now.toUTC().toISO(),
      announcement,
    };
  }

  // First day with a group slot not started yet; days with only assigned slots are skipped
  private async nextGroupDay(trainerId: string | null, now: DateTime) {
    const upcoming = await this.withGroupSlots(
      trainerId,
      await this.database.db
        .select()
        .from(trainingDays)
        .where(and(gte(trainingDays.localDate, now.toISODate()!), eq(trainingDays.status, 'SCHEDULED')))
        .orderBy(trainingDays.localDate)
        .limit(10),
    );
    return upcoming.find((day) => now < slotStartsAt(day.localDate, day.lastTime));
  }

  // Last frozen day, if frozen today or on the shown day
  private async frozenUntil(memberId: string, today: string, targetDay: { localDate: string } | undefined) {
    const freeze = (await loadFreezes(this.database.db, [memberId])).find(
      (f) => frozenOn(f, today) || (!!targetDay && frozenOn(f, targetDay.localDate)),
    );
    return freeze ? plusDays(freeze.endsOn!, -1) : null;
  }

  private async groupSlotViews(
    trainerId: string,
    day: { id: string; localDate: string },
    memberId: string | undefined,
    now: DateTime,
  ) {
    const slots = await this.database.db
      .select()
      .from(trainingSlots)
      .where(
        and(
          eq(trainingSlots.trainingDayId, day.id),
          eq(trainingSlots.trainingType, GROUP_TYPE),
          eq(trainingSlots.trainerId, trainerId),
        ),
      )
      .orderBy(trainingSlots.slotTime);

    const mine = memberId
      ? await this.memberOnSlots(
          memberId,
          slots.map((s) => s.id),
        )
      : null;

    return slots.map((s) => ({
      id: s.id,
      slotTime: s.slotTime,
      status: s.status,
      trainingType: s.trainingType,
      capacity: s.capacity,
      bookedCount: s.bookedCount,
      isMyBooking: s.id === mine?.bookedSlotId,
      isMyVacancyAlert: !!mine?.alertSlotIds.has(s.id),
      myGuest: s.id === mine?.bookedSlotId ? mine.guest : null,
      // Cancelled late with a fee: can't be booked again
      lateCancelled: !!mine?.lateCancelled.has(s.id),
      // Booking, cancelling and switching are closed
      started: now >= slotStartsAt(day.localDate, s.slotTime),
    }));
  }

  private async publishedAnnouncement(dayId: string) {
    const [ann] = await this.database.db
      .select({
        text: announcements.text,
        publishedAt: announcements.publishedAt,
      })
      .from(announcements)
      .where(eq(announcements.trainingDayId, dayId))
      .limit(1);
    return ann?.publishedAt && ann.text ? ann.text : null;
  }

  // The member's booking (at most one group booking a day), guest, late cancellations and vacancy alerts
  private async memberOnSlots(memberId: string, slotIds: string[]) {
    const none = { bookedSlotId: null, guest: null, lateCancelled: new Set<string>(), alertSlotIds: new Set<string>() };
    if (slotIds.length === 0) return none;
    const db = this.database.db;
    const [booking] = await db
      .select({ id: bookings.id, slotId: bookings.slotId })
      .from(bookings)
      .where(and(eq(bookings.memberId, memberId), inArray(bookings.slotId, slotIds), eq(bookings.status, 'ACTIVE')))
      .limit(1);
    const [guest] = booking
      ? await db
          .select({ name: bookingGuests.name })
          .from(bookingGuests)
          .where(and(eq(bookingGuests.bookingId, booking.id), eq(bookingGuests.status, 'ACTIVE')))
          .limit(1)
      : [];
    const lateCancelled = await lateCancelledSlotIds(db, memberId, slotIds);
    const alerts = await db
      .select({ slotId: vacancyAlerts.slotId })
      .from(vacancyAlerts)
      .where(
        and(
          eq(vacancyAlerts.memberId, memberId),
          eq(vacancyAlerts.active, true),
          inArray(vacancyAlerts.slotId, slotIds),
        ),
      );
    return {
      bookedSlotId: booking?.slotId ?? null,
      guest: guest ?? null,
      lateCancelled,
      alertSlotIds: new Set(alerts.map((a) => a.slotId)),
    };
  }

  // Days with this trainer's group slots (any status, cancelled ones are shown), each with its last ACTIVE time,
  // so a cancelled last slot doesn't keep the day "next". All cancelled: the last one, so it shows until then
  private async withGroupSlots(trainerId: string | null, days: DayRow[]) {
    if (days.length === 0 || !trainerId) return [];
    const rows = await this.database.db
      .select({ dayId: trainingSlots.trainingDayId, slotTime: trainingSlots.slotTime, status: trainingSlots.status })
      .from(trainingSlots)
      .where(
        and(
          inArray(
            trainingSlots.trainingDayId,
            days.map((d) => d.id),
          ),
          eq(trainingSlots.trainingType, GROUP_TYPE),
          eq(trainingSlots.trainerId, trainerId),
        ),
      );
    const latest = (times: string[]) => [...times].sort().at(-1);
    return days.flatMap((d) => {
      const own = rows.filter((r) => r.dayId === d.id);
      const lastTime =
        latest(own.filter((r) => r.status === 'ACTIVE').map((r) => r.slotTime)) ?? latest(own.map((r) => r.slotTime));
      return lastTime ? [{ ...d, lastTime }] : [];
    });
  }

  private async getAssignedSlots(memberId: string, now: DateTime) {
    const rows = await this.database.db
      .select({
        id: trainingSlots.id,
        localDate: trainingDays.localDate,
        slotTime: trainingSlots.slotTime,
        trainingType: trainingSlots.trainingType,
        capacity: trainingSlots.capacity,
        bookedCount: trainingSlots.bookedCount,
      })
      .from(trainingSlots)
      .innerJoin(trainingDays, eq(trainingDays.id, trainingSlots.trainingDayId))
      .innerJoin(slotMembers, and(eq(slotMembers.slotId, trainingSlots.id), eq(slotMembers.memberId, memberId)))
      .where(
        and(
          gte(trainingDays.localDate, now.toISODate()!),
          eq(trainingDays.status, 'SCHEDULED'),
          eq(trainingSlots.status, 'ACTIVE'),
          inArray(trainingSlots.trainingType, ASSIGNED_TYPES),
        ),
      )
      .orderBy(trainingDays.localDate, trainingSlots.slotTime);

    const visible = rows.filter(
      (r) =>
        now <
        slotStartsAt(r.localDate, r.slotTime).plus({
          minutes: ASSIGNED_SHOWN_FOR_MINUTES,
        }),
    );
    if (visible.length === 0) return [];

    // spentFrom set = already marked and paid from a package
    const mine = await this.database.db
      .select({ slotId: bookings.slotId, spentFrom: packageSpends.packageId })
      .from(bookings)
      .leftJoin(packageSpends, eq(packageSpends.bookingId, bookings.id))
      .where(
        and(
          eq(bookings.memberId, memberId),
          eq(bookings.status, 'ACTIVE'),
          inArray(
            bookings.slotId,
            visible.map((r) => r.id),
          ),
        ),
      );

    // Same rule as the spend: only packages of that type usable on the training's date
    const packages = await this.entitlements.packagesOf(memberId);
    const leftFor = (type: string, date: string) =>
      packages
        .filter((p) => p.trainingType === type && passUsableOn(p, date))
        .reduce((sum, p) => sum + Math.max(p.left, 0), 0);

    return visible.map((r) => ({
      ...r,
      isMyBooking: mine.some((b) => b.slotId === r.id),
      spent: mine.some((b) => b.slotId === r.id && !!b.spentFrom),
      packageLeft: leftFor(r.trainingType, r.localDate),
      started: now >= slotStartsAt(r.localDate, r.slotTime),
    }));
  }

  // Creates each trainer's weekly group slots 3 weeks ahead. Only adds, never undoes a trainer's change:
  // - a taken time (any slot, even cancelled), a CANCELLED day, a day the trainer cancelled are skipped
  // - without trainerId: every trainer, once per day per instance (the schedule is polled every 5 s)
  // - force: a schedule was just saved
  async ensureGroupSlots(trainerId?: string, opts: { force?: boolean } = {}): Promise<GroupSlotsResult> {
    const now = this.clock.now();
    const today = now.toISODate()!;
    const total: GroupSlotsResult = { added: 0, skipped: [] };
    if (!trainerId && !opts.force && this.groupSlotsEnsuredFor === today) return total;

    const trainerIds = trainerId
      ? [trainerId]
      : (await this.database.db.select({ id: admins.id }).from(admins).where(isNull(admins.disabledAt))).map(
          (a) => a.id,
        );
    for (const id of trainerIds) {
      const one = await this.ensureTrainerGroupSlots(id, now);
      total.added += one.added;
      total.skipped.push(...one.skipped);
    }
    if (!trainerId) this.groupSlotsEnsuredFor = today;
    return total;
  }

  private async ensureTrainerGroupSlots(trainerId: string, now: DateTime): Promise<GroupSlotsResult> {
    const none: GroupSlotsResult = { added: 0, skipped: [] };
    const schedule = await loadTrainerSchedule(this.database.db, trainerId);
    if (!schedule.autoCreate || schedule.times.length === 0) return none;

    const timesOn = (weekday: number) => schedule.times.filter((t) => t.weekday === weekday).map((t) => t.slotTime);
    const dates: string[] = [];
    for (let i = 0; i < GROUP_HORIZON_DAYS; i++) {
      const d = now.plus({ days: i });
      if (timesOn(d.weekday).length > 0) dates.push(d.toISODate()!);
    }
    if (dates.length === 0) return none;
    // Today's past times are skipped: nobody could book them
    const aheadOn = (date: string) =>
      timesOn(DateTime.fromISO(date, { zone: KY_ZONE }).weekday).filter((t) => slotStartsAt(date, t) > now);

    const dayIdOf = await this.scheduledDays(dates);
    const own = await this.ownGroupSlots(trainerId, [...dayIdOf.values()]);
    const { toInsert, skipped } = planGroupSlots(dates, aheadOn, dayIdOf, own);

    const created = await this.insertGroupSlots(trainerId, toInsert);
    // Not created = conflict with another active slot of theirs (an assigned one) at that time
    for (const row of toInsert) {
      if (created.some((c) => c.trainingDayId === row.trainingDayId && c.slotTime === row.slotTime)) continue;
      skipped.push({ date: row.date, slotTime: row.slotTime, reason: 'taken' });
    }
    skipped.sort((a, b) => a.date.localeCompare(b.date) || a.slotTime.localeCompare(b.slotTime));
    return { added: created.length, skipped };
  }

  // date -> SCHEDULED day id; creates missing days, a CANCELLED day stays cancelled
  private async scheduledDays(dates: string[]) {
    await this.database.db
      .insert(trainingDays)
      .values(dates.map((localDate) => ({ localDate, status: 'SCHEDULED' })))
      .onConflictDoNothing();

    const days = await this.database.db
      .select({ id: trainingDays.id, localDate: trainingDays.localDate })
      .from(trainingDays)
      .where(and(inArray(trainingDays.localDate, dates), eq(trainingDays.status, 'SCHEDULED')));
    return new Map(days.map((d) => [d.localDate, d.id]));
  }

  // Cancelled ones included
  private async ownGroupSlots(trainerId: string, dayIds: string[]): Promise<OwnGroupSlot[]> {
    if (dayIds.length === 0) return [];
    return this.database.db
      .select({
        trainingDayId: trainingSlots.trainingDayId,
        status: trainingSlots.status,
        slotTime: trainingSlots.slotTime,
      })
      .from(trainingSlots)
      .where(
        and(
          inArray(trainingSlots.trainingDayId, dayIds),
          eq(trainingSlots.trainerId, trainerId),
          eq(trainingSlots.trainingType, GROUP_TYPE),
        ),
      );
  }

  // Returns only the rows created; a time taken meanwhile is left out
  private async insertGroupSlots(trainerId: string, toInsert: PlannedGroupSlot[]) {
    if (toInsert.length === 0) return [];
    return this.database.db
      .insert(trainingSlots)
      .values(
        toInsert.map(({ trainingDayId, slotTime }) => ({
          trainingDayId,
          slotTime,
          status: 'ACTIVE' as const,
          trainingType: GROUP_TYPE,
          capacity: GROUP_CAPACITY,
          bookedCount: 0,
          trainerId,
        })),
      )
      .onConflictDoNothing()
      .returning({ trainingDayId: trainingSlots.trainingDayId, slotTime: trainingSlots.slotTime });
  }
}

type OwnGroupSlot = { trainingDayId: string; status: string; slotTime: string };
type PlannedGroupSlot = { trainingDayId: string; slotTime: string; date: string };

// Pure: sorts each upcoming schedule time into already there, skipped (with a reason) or to insert.
// `own` = the trainer's group slots on those days, cancelled ones included
export function planGroupSlots(
  dates: string[],
  aheadOn: (date: string) => string[],
  dayIdOf: Map<string, string>,
  own: OwnGroupSlot[],
): { toInsert: PlannedGroupSlot[]; skipped: SkippedTraining[] } {
  // A cancelled group and none active: the trainer cancelled the day, don't bring it back
  const cancelledByTrainer = (dayId: string) => {
    const slots = own.filter((s) => s.trainingDayId === dayId);
    return slots.some((s) => s.status === 'CANCELLED') && !slots.some((s) => s.status === 'ACTIVE');
  };
  const overlapsActive = (dayId: string, slotTime: string) =>
    !!groupTimeError(
      slotTime,
      own
        .filter((o) => o.trainingDayId === dayId && o.status === 'ACTIVE' && o.slotTime !== slotTime)
        .map((o) => o.slotTime),
    );
  const ownAt = (dayId: string, slotTime: string) =>
    own.filter((o) => o.trainingDayId === dayId && o.slotTime === slotTime);

  const toInsert: PlannedGroupSlot[] = [];
  const skipped: SkippedTraining[] = [];
  for (const date of dates) {
    const dayId = dayIdOf.get(date);
    for (const slotTime of aheadOn(date)) {
      if (!dayId || cancelledByTrainer(dayId)) {
        skipped.push({ date, slotTime, reason: 'cancelled' });
        continue;
      }
      if (ownAt(dayId, slotTime).some((o) => o.status === 'ACTIVE')) continue;
      // Cancelled at that time: don't bring it back
      if (ownAt(dayId, slotTime).length > 0) {
        skipped.push({ date, slotTime, reason: 'cancelled' });
        continue;
      }
      // Group slots must stay an hour apart from those already created
      if (overlapsActive(dayId, slotTime)) skipped.push({ date, slotTime, reason: 'taken' });
      else toInsert.push({ trainingDayId: dayId, slotTime, date });
    }
  }
  return { toInsert, skipped };
}
