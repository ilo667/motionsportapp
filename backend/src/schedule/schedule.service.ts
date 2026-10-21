import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { and, eq, gte, lte, inArray } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { trainingDays, trainingSlots, bookings, vacancyAlerts, announcements } from '../database/schema';
import { DemoService } from '../demo/demo.service';

const KY_ZONE = 'Europe/Kyiv';
const DEFAULT_WEEKDAYS = [1, 3, 5]; // Mon, Wed, Fri
const SLOT_TIMES = ['19:00', '20:00'];

@Injectable()
export class ScheduleService {
  constructor(
    private readonly database: DatabaseService,
    private readonly demoService: DemoService,
  ) {}

  async getNext(memberId?: string) {
    await this.materializeUpcoming(21);

    const now = await this.demoService.getNow();
    const today = now.toISODate()!;

    const upcoming = await this.database.db
      .select()
      .from(trainingDays)
      .where(and(gte(trainingDays.localDate, today), eq(trainingDays.status, 'SCHEDULED')))
      .orderBy(trainingDays.localDate)
      .limit(10);

    let targetDay = upcoming.find((day) => {
      const closeAt = DateTime.fromISO(`${day.localDate}T21:00:00`, { zone: KY_ZONE });
      return now < closeAt;
    });

    if (!targetDay) {
      await this.materializeUpcoming(42);
      const more = await this.database.db
        .select()
        .from(trainingDays)
        .where(and(gte(trainingDays.localDate, today), eq(trainingDays.status, 'SCHEDULED')))
        .orderBy(trainingDays.localDate)
        .limit(3);
      targetDay = more[0];
    }

    if (!targetDay) return null;

    const openAt = DateTime.fromISO(`${targetDay.localDate}T14:00:00`, { zone: KY_ZONE });
    const closeAt = DateTime.fromISO(`${targetDay.localDate}T21:00:00`, { zone: KY_ZONE });
    const bookingWindowOpen = now >= openAt && now < closeAt;

    const slots = await this.database.db
      .select()
      .from(trainingSlots)
      .where(eq(trainingSlots.trainingDayId, targetDay.id))
      .orderBy(trainingSlots.slotTime);

    let myBookingSlotId: string | null = null;
    const myVacancyAlertSlotIds = new Set<string>();

    let myPaymentStatus: string | null = null;

    if (memberId) {
      const [mine] = await this.database.db
        .select({ slotId: bookings.slotId, paymentStatus: bookings.paymentStatus })
        .from(bookings)
        .where(
          and(
            eq(bookings.memberId, memberId),
            eq(bookings.trainingDayId, targetDay.id),
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
      serverTime: now.toUTC().toISO(),
      announcement,
      isDemoMode: this.demoService.isDemoMode(),
    };
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