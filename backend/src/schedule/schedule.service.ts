import { Injectable } from '@nestjs/common';
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
} from '../database/schema';
import { ClockService } from '../clock/clock.service';
import { PaymentService } from '../payment/payment.service';
import {
  DEFAULT_WEEKDAYS,
  GROUP_SLOT_TIMES,
  GROUP_TYPE,
  KY_ZONE,
  ASSIGNED_TYPES,
  slotStartsAt,
} from './training-types';
import { getDefaultCoachId, getMemberCoachId } from './default-coach';

// An assigned training stays on the member's page until it ends (payment and cancel only until it starts)
const ASSIGNED_SHOWN_FOR_MINUTES = 60;

type DayRow = typeof trainingDays.$inferSelect;

// Group trainings appear by themselves on these weekdays, so they exist even if the coach forgets
const DEFAULT_HORIZON_DAYS = 21;

@Injectable()
export class ScheduleService {
  // Date on which this instance last created the default group slots (see ensureDefaultGroupSlots)
  private defaultSlotsEnsuredFor: string | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly clock: ClockService,
    private readonly paymentService: PaymentService,
  ) {}

  async getNext(memberId?: string) {
    await this.paymentService.expireStale();
    await this.ensureDefaultGroupSlots();

    const now = this.clock.now();
    const today = now.toISODate()!;

    const assignedSlots = memberId
      ? await this.getAssignedSlots(memberId, now)
      : [];

    // "Наступне тренування" is the next group day; days with only assigned trainings are skipped
    // Group trainings of the member's coach only (the first coach for members without one and for visitors)
    const coachId = await getMemberCoachId(this.database.db, memberId);

    const upcoming = await this.withGroupSlots(
      coachId,
      await this.database.db
        .select()
        .from(trainingDays)
        .where(
          and(
            gte(trainingDays.localDate, today),
            eq(trainingDays.status, 'SCHEDULED'),
          ),
        )
        .orderBy(trainingDays.localDate)
        .limit(10),
    );

    const targetDay = upcoming.find((day) => {
      const closeAt = DateTime.fromISO(`${day.localDate}T21:00:00`, {
        zone: KY_ZONE,
      });
      return now < closeAt;
    });

    // No group day ahead (e.g. the coach cancelled them): the member still gets their assigned trainings
    if (!targetDay) {
      return {
        localDate: null,
        status: null,
        bookingWindowOpen: false,
        bookingOpenAt: null,
        bookingCloseAt: null,
        slots: [],
        assignedSlots,
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
          eq(trainingSlots.coachId, coachId!),
        ),
      )
      .orderBy(trainingSlots.slotTime);

    let myBookingSlotId: string | null = null;
    const myVacancyAlertSlotIds = new Set<string>();

    let myPaymentStatus: string | null = null;

    if (memberId && slots.length > 0) {
      const [mine] = await this.database.db
        .select({
          slotId: bookings.slotId,
          paymentStatus: bookings.paymentStatus,
        })
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
      myPaymentStatus = mine?.paymentStatus ?? null;

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

    const announcement =
      bookingWindowOpen && ann?.publishedAt && ann.text ? ann.text : null;

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
        myPaymentStatus: s.id === myBookingSlotId ? myPaymentStatus : null,
        isMyVacancyAlert: myVacancyAlertSlotIds.has(s.id),
      })),
      assignedSlots,
      serverTime: now.toUTC().toISO(),
      announcement,
    };
  }

  // Days with group slots of this coach (any status: a cancelled group slot is still shown as "Скасовано")
  private async withGroupSlots(coachId: string | null, days: DayRow[]) {
    if (days.length === 0 || !coachId) return [];
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
          eq(trainingSlots.coachId, coachId),
        ),
      );
    const withGroup = new Set(rows.map((r) => r.dayId));
    return days.filter((d) => withGroup.has(d.id));
  }

  // Upcoming assigned trainings the coach assigned to this member, on any day
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
      .innerJoin(
        slotMembers,
        and(
          eq(slotMembers.slotId, trainingSlots.id),
          eq(slotMembers.memberId, memberId),
        ),
      )
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

    const mine = await this.database.db
      .select({
        slotId: bookings.slotId,
        paymentStatus: bookings.paymentStatus,
      })
      .from(bookings)
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

    return visible.map((r) => {
      const booking = mine.find((b) => b.slotId === r.id);
      return {
        ...r,
        isMyBooking: !!booking,
        myPaymentStatus: booking?.paymentStatus ?? null,
        // Payment and cancellation are allowed until the training starts
        started: now >= slotStartsAt(r.localDate, r.slotTime),
      };
    });
  }

  // Mon/Wed/Fri 19:00 and 20:00 group slots for the next 3 weeks, owned by the first coach. Idempotent:
  // a time already taken (by any training, even a cancelled one) is left alone, and days the coach
  // cancelled are skipped, so the coach's changes are never undone
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

    const coachId = await getDefaultCoachId(this.database.db);
    if (!coachId) return; // no coach account yet

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
      .where(
        and(
          inArray(trainingDays.localDate, dates),
          eq(trainingDays.status, 'SCHEDULED'),
        ),
      );
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
              coachId,
            })),
          ),
        )
        .onConflictDoNothing();
    }
    this.defaultSlotsEnsuredFor = today;
  }
}
