import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { and, eq, gte, lte, inArray } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { trainingDays, trainingSlots, bookings, vacancyAlerts, announcements, slotMembers } from '../database/schema';
import { DemoService } from '../demo/demo.service';
import { PaymentService } from '../payment/payment.service';
import { GROUP_SLOT_TIMES, GROUP_TYPE, KY_ZONE, PERSONAL_TYPES, slotStartsAt } from './training-types';

const DEFAULT_WEEKDAYS = [1, 3, 5]; // Mon, Wed, Fri
const SLOT_TIMES = GROUP_SLOT_TIMES;
// A personal training stays on the member's page until it ends (payment and cancel only until it starts)
const PERSONAL_SHOWN_FOR_MINUTES = 60;

type DayRow = typeof trainingDays.$inferSelect;

@Injectable()
export class ScheduleService {
  constructor(
    private readonly database: DatabaseService,
    private readonly demoService: DemoService,
    private readonly paymentService: PaymentService,
  ) {}

  async getNext(memberId?: string) {
    await this.paymentService.expireStale();
    await this.materializeUpcoming(21);

    const now = await this.demoService.getNow();
    const today = now.toISODate()!;

    const personalSlots = memberId ? await this.getPersonalSlots(memberId, now) : [];

    // "Наступне тренування" is the next group day; days with only personal trainings are skipped
    const upcoming = await this.withGroupSlots(
      await this.database.db
        .select()
        .from(trainingDays)
        .where(and(gte(trainingDays.localDate, today), eq(trainingDays.status, 'SCHEDULED')))
        .orderBy(trainingDays.localDate)
        .limit(10),
    );

    let targetDay = upcoming.find((day) => {
      const closeAt = DateTime.fromISO(`${day.localDate}T21:00:00`, { zone: KY_ZONE });
      return now < closeAt;
    });

    if (!targetDay) {
      await this.materializeUpcoming(42);
      const more = await this.withGroupSlots(
        await this.database.db
          .select()
          .from(trainingDays)
          .where(and(gte(trainingDays.localDate, today), eq(trainingDays.status, 'SCHEDULED')))
          .orderBy(trainingDays.localDate)
          .limit(10),
      );
      targetDay = more[0];
    }

    if (!targetDay) return null;

    const openAt = DateTime.fromISO(`${targetDay.localDate}T14:00:00`, { zone: KY_ZONE });
    const closeAt = DateTime.fromISO(`${targetDay.localDate}T21:00:00`, { zone: KY_ZONE });
    const bookingWindowOpen = now >= openAt && now < closeAt;

    const slots = await this.database.db
      .select()
      .from(trainingSlots)
      .where(and(eq(trainingSlots.trainingDayId, targetDay.id), eq(trainingSlots.trainingType, GROUP_TYPE)))
      .orderBy(trainingSlots.slotTime);

    let myBookingSlotId: string | null = null;
    const myVacancyAlertSlotIds = new Set<string>();

    let myPaymentStatus: string | null = null;

    if (memberId && slots.length > 0) {
      const [mine] = await this.database.db
        .select({ slotId: bookings.slotId, paymentStatus: bookings.paymentStatus })
        .from(bookings)
        .where(
          and(
            eq(bookings.memberId, memberId),
            inArray(bookings.slotId, slots.map((s) => s.id)),
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
      .select({ text: announcements.text, publishedAt: announcements.publishedAt })
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
        myPaymentStatus: s.id === myBookingSlotId ? myPaymentStatus : null,
        isMyVacancyAlert: myVacancyAlertSlotIds.has(s.id),
      })),
      personalSlots,
      serverTime: now.toUTC().toISO(),
      announcement,
      isDemoMode: this.demoService.isDemoMode(),
    };
  }

  // Days that have group slots (any status: a cancelled group slot is still shown as "Скасовано")
  private async withGroupSlots(days: DayRow[]) {
    if (days.length === 0) return days;
    const rows = await this.database.db
      .selectDistinct({ dayId: trainingSlots.trainingDayId })
      .from(trainingSlots)
      .where(and(inArray(trainingSlots.trainingDayId, days.map((d) => d.id)), eq(trainingSlots.trainingType, GROUP_TYPE)));
    const withGroup = new Set(rows.map((r) => r.dayId));
    return days.filter((d) => withGroup.has(d.id));
  }

  // Upcoming personal trainings the coach assigned to this member, on any day
  private async getPersonalSlots(memberId: string, now: DateTime) {
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
          inArray(trainingSlots.trainingType, PERSONAL_TYPES),
        ),
      )
      .orderBy(trainingDays.localDate, trainingSlots.slotTime);

    const visible = rows.filter(
      (r) => now < slotStartsAt(r.localDate, r.slotTime).plus({ minutes: PERSONAL_SHOWN_FOR_MINUTES }),
    );
    if (visible.length === 0) return [];

    const mine = await this.database.db
      .select({ slotId: bookings.slotId, paymentStatus: bookings.paymentStatus })
      .from(bookings)
      .where(
        and(
          eq(bookings.memberId, memberId),
          eq(bookings.status, 'ACTIVE'),
          inArray(bookings.slotId, visible.map((r) => r.id)),
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

  async materializeUpcoming(days: number) {
    const now = await this.demoService.getNow();
    const today = now.toISODate()!;
    const endDate = now.plus({ days }).toISODate()!;

    const needed: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = now.plus({ days: i });
      if (DEFAULT_WEEKDAYS.includes(d.weekday)) needed.push(d.toISODate()!);
    }
    if (needed.length === 0) return;

    const existing = await this.database.db
      .select({ localDate: trainingDays.localDate })
      .from(trainingDays)
      .where(and(gte(trainingDays.localDate, today), lte(trainingDays.localDate, endDate)));

    const existingSet = new Set(existing.map((d) => d.localDate));
    const missing = needed.filter((d) => !existingSet.has(d));
    if (missing.length === 0) return;

    await this.database.db
      .insert(trainingDays)
      .values(missing.map((localDate) => ({ localDate, status: 'SCHEDULED', isException: false })))
      .onConflictDoNothing();

    const newDays = await this.database.db
      .select()
      .from(trainingDays)
      .where(inArray(trainingDays.localDate, missing));

    if (newDays.length === 0) return;

    const slotValues = newDays.flatMap((day) =>
      SLOT_TIMES.map((slotTime) => ({
        trainingDayId: day.id,
        slotTime,
        status: 'ACTIVE' as const,
        capacity: 8,
        bookedCount: 0,
      })),
    );

    await this.database.db.insert(trainingSlots).values(slotValues).onConflictDoNothing();
  }
}