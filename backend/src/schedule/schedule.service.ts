import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
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
} from '../database/schema';
import { ClockService } from '../clock/clock.service';
import { PaymentService } from '../payment/payment.service';
import { EntitlementsService } from '../purchases/entitlements.service';
import { GROUP_TYPE, KY_ZONE, ASSIGNED_TYPES, slotStartsAt } from './training-types';
import { getMemberTrainerId } from './default-trainer';
import { loadTrainerSchedule } from '../trainer-schedule/trainer-schedule.store';
import { bookingOpensAt, groupTimeError } from '../trainer-schedule/rules';

// An assigned training stays on the member's page until it ends (payment and cancel only until it starts)
const ASSIGNED_SHOWN_FOR_MINUTES = 60;

type DayRow = typeof trainingDays.$inferSelect;

// Group trainings appear by themselves on these weekdays, so they exist even if the trainer forgets
// Group trainings are created this many days ahead
const GROUP_HORIZON_DAYS = 21;
const GROUP_CAPACITY = 8;

@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);

  // Date on which this instance last created the group trainings of every trainer (see ensureGroupSlots)
  private groupSlotsEnsuredFor: string | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly clock: ClockService,
    private readonly paymentService: PaymentService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async getNext(memberId?: string) {
    // A failure here (LiqPay slow, a DB deadlock with a concurrent callback) must not break the schedule;
    // the next load retries
    await this.paymentService
      .expireStale()
      .catch((err: unknown) => this.logger.warn(`Expire stale payments failed: ${String(err)}`));
    await this.ensureGroupSlots();

    const now = this.clock.now();
    const today = now.toISODate()!;

    const assignedSlots = memberId ? await this.getAssignedSlots(memberId, now) : [];

    // "Наступне тренування" is the next group day; days with only assigned trainings are skipped
    // Group trainings of the member's trainer only (the first trainer for members without one and for visitors)
    const trainerId = await getMemberTrainerId(this.database.db, memberId);

    const upcoming = await this.withGroupSlots(
      trainerId,
      await this.database.db
        .select()
        .from(trainingDays)
        .where(and(gte(trainingDays.localDate, today), eq(trainingDays.status, 'SCHEDULED')))
        .orderBy(trainingDays.localDate)
        .limit(10),
    );

    // The next day with a group training of this trainer that has not started yet
    const targetDay = upcoming.find((day) => now < slotStartsAt(day.localDate, day.lastTime));

    // No group day ahead (e.g. the trainer cancelled them): the member still gets their assigned trainings
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
        serverTime: now.toUTC().toISO(),
        announcement: null,
      };
    }

    // Booking opens at the trainer's time and closes, training by training, when each one starts: the day's window
    // ends with the last one
    const { bookingOpensAt: opensAt } = await loadTrainerSchedule(this.database.db, trainerId!);
    const openAt = bookingOpensAt(targetDay.localDate, opensAt);
    const closeAt = slotStartsAt(targetDay.localDate, targetDay.lastTime);
    const bookingWindowOpen = now >= openAt && now < closeAt;

    const slots = await this.database.db
      .select()
      .from(trainingSlots)
      .where(
        and(
          eq(trainingSlots.trainingDayId, targetDay.id),
          eq(trainingSlots.trainingType, GROUP_TYPE),
          eq(trainingSlots.trainerId, trainerId!),
        ),
      )
      .orderBy(trainingSlots.slotTime);

    let myBookingSlotId: string | null = null;
    const myVacancyAlertSlotIds = new Set<string>();

    if (memberId && slots.length > 0) {
      const [mine] = await this.database.db
        .select({ slotId: bookings.slotId })
        .from(bookings)
        .where(
          and(
            eq(bookings.memberId, memberId),
            inArray(
              bookings.slotId,
              slots.map((s) => s.id),
            ),
            eq(bookings.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      myBookingSlotId = mine?.slotId ?? null;

      const slotIds = slots.map((s) => s.id);
      if (slotIds.length > 0) {
        const alerts = await this.database.db
          .select({ slotId: vacancyAlerts.slotId })
          .from(vacancyAlerts)
          .where(
            and(
              eq(vacancyAlerts.memberId, memberId),
              eq(vacancyAlerts.active, true),
              inArray(vacancyAlerts.slotId, slotIds),
            ),
          );
        alerts.forEach((a) => myVacancyAlertSlotIds.add(a.slotId));
      }
    }

    const [ann] = await this.database.db
      .select({
        text: announcements.text,
        publishedAt: announcements.publishedAt,
      })
      .from(announcements)
      .where(eq(announcements.trainingDayId, targetDay.id))
      .limit(1);

    const announcement = bookingWindowOpen && ann?.publishedAt && ann.text ? ann.text : null;

    return {
      localDate: targetDay.localDate,
      status: targetDay.status,
      bookingWindowOpen,
      bookingOpenAt: openAt.toUTC().toISO(),
      bookingCloseAt: closeAt.toUTC().toISO(),
      slots: slots.map((s) => ({
        id: s.id,
        slotTime: s.slotTime,
        status: s.status,
        trainingType: s.trainingType,
        capacity: s.capacity,
        bookedCount: s.bookedCount,
        isMyBooking: s.id === myBookingSlotId,
        isMyVacancyAlert: myVacancyAlertSlotIds.has(s.id),
        // Booking, cancelling and switching for this training are over
        started: now >= slotStartsAt(targetDay.localDate, s.slotTime),
      })),
      assignedSlots,
      // Group trainings are paid: 0 → «Записатися» offers to buy a pass
      groupPassLeft: memberId ? await this.entitlements.groupPassLeft(memberId, targetDay.localDate) : 0,
      serverTime: now.toUTC().toISO(),
      announcement,
    };
  }

  // Days with group slots of this trainer (any status: a cancelled group slot is still shown as "Скасовано"),
  // each with the time of its last group slot
  private async withGroupSlots(trainerId: string | null, days: DayRow[]) {
    if (days.length === 0 || !trainerId) return [];
    const rows = await this.database.db
      .select({ dayId: trainingSlots.trainingDayId, lastTime: sql<string>`max(${trainingSlots.slotTime})` })
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
      )
      .groupBy(trainingSlots.trainingDayId);
    return days.flatMap((d) => {
      const row = rows.find((r) => r.dayId === d.id);
      return row ? [{ ...d, lastTime: row.lastTime }] : [];
    });
  }

  // Upcoming assigned trainings the trainer assigned to this member, on any day
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

    // spentFrom: this booking was already paid from a package (the trainer marked it)
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

    // Trainings left in the member's packages of each type: the card shows «з пакета» or «Оплатити»
    const packages = await this.entitlements.packagesOf(memberId);
    const leftOf = (type: string) =>
      packages.filter((p) => p.trainingType === type).reduce((sum, p) => sum + Math.max(p.left, 0), 0);

    return visible.map((r) => ({
      ...r,
      isMyBooking: mine.some((b) => b.slotId === r.id),
      spent: mine.some((b) => b.slotId === r.id && !!b.spentFrom),
      packageLeft: leftOf(r.trainingType),
      // Cancellation is allowed until the training starts
      started: now >= slotStartsAt(r.localDate, r.slotTime),
    }));
  }

  // Group trainings of each trainer for the next 3 weeks, from their «Мій розклад» (the first trainer without one
  // keeps Mon/Wed/Fri 19:00 and 20:00). Only adds: a time already taken (by any training, even a cancelled one) is
  // left alone, a CANCELLED day is skipped, and so is a day where the trainer cancelled their own trainings (a
  // cancelled group, none active), so the trainer's changes are never undone. Without `trainerId`: every trainer,
  // once per day per instance (the schedule is polled every 5 s). `force`: a schedule was just saved
  async ensureGroupSlots(trainerId?: string, opts: { force?: boolean } = {}) {
    const now = this.clock.now();
    const today = now.toISODate()!;
    if (!trainerId && !opts.force && this.groupSlotsEnsuredFor === today) return;

    const trainerIds = trainerId
      ? [trainerId]
      : (await this.database.db.select({ id: admins.id }).from(admins)).map((a) => a.id);
    for (const id of trainerIds) await this.ensureTrainerGroupSlots(id, now);
    if (!trainerId) this.groupSlotsEnsuredFor = today;
  }

  private async ensureTrainerGroupSlots(trainerId: string, now: DateTime) {
    const schedule = await loadTrainerSchedule(this.database.db, trainerId);
    if (!schedule.autoCreate || schedule.times.length === 0) return;

    const timesOn = (weekday: number) => schedule.times.filter((t) => t.weekday === weekday).map((t) => t.slotTime);
    const dates: string[] = [];
    for (let i = 0; i < GROUP_HORIZON_DAYS; i++) {
      const d = now.plus({ days: i });
      if (timesOn(d.weekday).length > 0) dates.push(d.toISODate()!);
    }
    if (dates.length === 0) return;

    await this.database.db
      .insert(trainingDays)
      .values(dates.map((localDate) => ({ localDate, status: 'SCHEDULED' })))
      .onConflictDoNothing();

    const days = await this.database.db
      .select({ id: trainingDays.id, localDate: trainingDays.localDate })
      .from(trainingDays)
      .where(and(inArray(trainingDays.localDate, dates), eq(trainingDays.status, 'SCHEDULED')));
    if (days.length === 0) return;

    const own = await this.database.db
      .select({
        trainingDayId: trainingSlots.trainingDayId,
        status: trainingSlots.status,
        slotTime: trainingSlots.slotTime,
      })
      .from(trainingSlots)
      .where(
        and(
          inArray(
            trainingSlots.trainingDayId,
            days.map((d) => d.id),
          ),
          eq(trainingSlots.trainerId, trainerId),
          eq(trainingSlots.trainingType, GROUP_TYPE),
        ),
      );
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

    const rows = days
      .filter((day) => !cancelledByTrainer(day.id))
      .flatMap((day) =>
        timesOn(DateTime.fromISO(day.localDate, { zone: KY_ZONE }).weekday)
          // A changed time must not overlap a group training already created that day (an hour apart)
          .filter((slotTime) => !overlapsActive(day.id, slotTime))
          .map((slotTime) => ({
            trainingDayId: day.id,
            slotTime,
            status: 'ACTIVE' as const,
            trainingType: GROUP_TYPE,
            capacity: GROUP_CAPACITY,
            bookedCount: 0,
            trainerId,
          })),
      );
    if (rows.length > 0) await this.database.db.insert(trainingSlots).values(rows).onConflictDoNothing();
  }
}
