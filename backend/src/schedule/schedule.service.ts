import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import {
  trainingDays,
  trainingSlots,
  bookings,
  vacancyAlerts,
  announcements,
  slotMembers,
  packageSpends,
} from '../database/schema';
import { ClockService } from '../clock/clock.service';
import { PaymentService } from '../payment/payment.service';
import { EntitlementsService } from '../purchases/entitlements.service';
import {
  DEFAULT_WEEKDAYS,
  GROUP_SLOT_TIMES,
  GROUP_TYPE,
  KY_ZONE,
  ASSIGNED_TYPES,
  slotStartsAt,
} from './training-types';
import { getDefaultTrainerId, getMemberTrainerId } from './default-trainer';

// An assigned training stays on the member's page until it ends (payment and cancel only until it starts)
const ASSIGNED_SHOWN_FOR_MINUTES = 60;

type DayRow = typeof trainingDays.$inferSelect;

// Group trainings appear by themselves on these weekdays, so they exist even if the trainer forgets
const DEFAULT_HORIZON_DAYS = 21;

@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);

  // Date on which this instance last created the default group slots (see ensureDefaultGroupSlots)
  private defaultSlotsEnsuredFor: string | null = null;

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
    await this.ensureDefaultGroupSlots();

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

    const targetDay = upcoming.find((day) => {
      const closeAt = DateTime.fromISO(`${day.localDate}T21:00:00`, {
        zone: KY_ZONE,
      });
      return now < closeAt;
    });

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

    const openAt = DateTime.fromISO(`${targetDay.localDate}T14:00:00`, {
      zone: KY_ZONE,
    });
    const closeAt = DateTime.fromISO(`${targetDay.localDate}T21:00:00`, {
      zone: KY_ZONE,
    });
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
      })),
      assignedSlots,
      // Group trainings are paid: 0 → «Записатися» offers to buy a pass
      groupPassLeft: memberId ? await this.entitlements.groupPassLeft(memberId, targetDay.localDate) : 0,
      serverTime: now.toUTC().toISO(),
      announcement,
    };
  }

  // Days with group slots of this trainer (any status: a cancelled group slot is still shown as "Скасовано")
  private async withGroupSlots(trainerId: string | null, days: DayRow[]) {
    if (days.length === 0 || !trainerId) return [];
    const rows = await this.database.db
      .selectDistinct({ dayId: trainingSlots.trainingDayId })
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
    const withGroup = new Set(rows.map((r) => r.dayId));
    return days.filter((d) => withGroup.has(d.id));
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

  // Mon/Wed/Fri 19:00 and 20:00 group slots for the next 3 weeks, owned by the first trainer. Idempotent:
  // a time already taken (by any training, even a cancelled one) is left alone, and days the trainer
  // cancelled are skipped, so the trainer's changes are never undone
  async ensureDefaultGroupSlots() {
    const now = this.clock.now();
    // Runs on every schedule load (polled every 5 s in the booking window): once per day per instance is enough,
    // the horizon only moves at midnight
    const today = now.toISODate()!;
    if (this.defaultSlotsEnsuredFor === today) return;

    const dates: string[] = [];
    for (let i = 0; i < DEFAULT_HORIZON_DAYS; i++) {
      const d = now.plus({ days: i });
      if (DEFAULT_WEEKDAYS.includes(d.weekday)) dates.push(d.toISODate()!);
    }
    if (dates.length === 0) return;

    const trainerId = await getDefaultTrainerId(this.database.db);
    if (!trainerId) return; // no trainer account yet

    await this.database.db
      .insert(trainingDays)
      .values(
        dates.map((localDate) => ({
          localDate,
          status: 'SCHEDULED',
        })),
      )
      .onConflictDoNothing();

    const days = await this.database.db
      .select({ id: trainingDays.id })
      .from(trainingDays)
      .where(and(inArray(trainingDays.localDate, dates), eq(trainingDays.status, 'SCHEDULED')));
    if (days.length > 0) {
      await this.database.db
        .insert(trainingSlots)
        .values(
          days.flatMap((day) =>
            GROUP_SLOT_TIMES.map((slotTime) => ({
              trainingDayId: day.id,
              slotTime,
              status: 'ACTIVE' as const,
              trainingType: GROUP_TYPE,
              capacity: 8,
              bookedCount: 0,
              trainerId,
            })),
          ),
        )
        .onConflictDoNothing();
    }
    this.defaultSlotsEnsuredFor = today;
  }
}
