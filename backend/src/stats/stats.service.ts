import { Injectable } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DatabaseService } from '../database/database.service';
import { ClockService } from '../clock/clock.service';
import {
  attendance,
  bookingGuests,
  bookings,
  priceItems,
  purchaseItems,
  purchases,
  trainingDays,
  trainingSlots,
} from '../database/schema';
import { KY_ZONE } from '../schedule/training-types';

const TOP_DAYS = 5;

export type Revenue = { clubCards: number; personal: number; split: number; group: number; total: number };

const emptyRevenue = (): Revenue => ({ clubCards: 0, personal: 0, split: 0, group: 0, total: 0 });

// Revenue column: price list section, split by type for trainer services
export function revenueKey(section: string, trainingType: string | null): keyof Omit<Revenue, 'total'> {
  if (section === 'club_card') return 'clubCards';
  if (section === 'group') return 'group';
  return trainingType === 'split' ? 'split' : 'personal';
}

// Revenue: PAID purchases with this trainer, by Kyiv month paid, at the amounts copied at purchase.
// Load: people marked present on the trainer's trainings, guests included
@Injectable()
export class StatsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clock: ClockService,
  ) {}

  async forTrainer(trainerId: string) {
    return {
      revenue: await this.revenue(trainerId),
      ...(await this.load(trainerId)),
    };
  }

  private async revenue(trainerId: string) {
    // decided_at is the payment moment; created_at only for old rows without it
    const month = sql<string>`to_char(coalesce(${purchases.decidedAt}, ${purchases.createdAt}) at time zone 'Europe/Kyiv', 'YYYY-MM')`;
    const rows = await this.database.db
      .select({
        month,
        section: priceItems.section,
        trainingType: priceItems.trainingType,
        amount: sql<number>`sum(${purchaseItems.amountUah})::int`,
      })
      .from(purchaseItems)
      .innerJoin(purchases, eq(purchases.id, purchaseItems.purchaseId))
      .innerJoin(priceItems, eq(priceItems.id, purchaseItems.priceItemId))
      .where(and(eq(purchases.trainerId, trainerId), eq(purchases.status, 'PAID')))
      .groupBy(month, priceItems.section, priceItems.trainingType);

    const byMonth = new Map<string, Revenue>();
    const allTime = emptyRevenue();
    for (const r of rows) {
      const key = revenueKey(r.section, r.trainingType);
      const m = byMonth.get(r.month) ?? emptyRevenue();
      m[key] += r.amount;
      m.total += r.amount;
      byMonth.set(r.month, m);
      allTime[key] += r.amount;
      allTime.total += r.amount;
    }
    return {
      allTime,
      months: [...byMonth].sort(([a], [b]) => b.localeCompare(a)).map(([m, revenue]) => ({ month: m, ...revenue })),
    };
  }

  private async load(trainerId: string) {
    const today = this.clock.now().toISODate()!;
    // Past days only: today's trainings may not have happened yet
    const mine = and(
      eq(trainingSlots.trainerId, trainerId),
      eq(trainingSlots.status, 'ACTIVE'),
      lt(trainingDays.localDate, today),
    );
    const members = await this.database.db
      .select({ localDate: trainingDays.localDate, present: sql<number>`count(*)::int` })
      .from(attendance)
      .innerJoin(bookings, eq(bookings.id, attendance.bookingId))
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .innerJoin(trainingDays, eq(trainingDays.id, trainingSlots.trainingDayId))
      .where(and(mine, eq(bookings.status, 'ACTIVE'), eq(attendance.status, 'PRESENT')))
      .groupBy(trainingDays.localDate);
    const guests = await this.database.db
      .select({ localDate: trainingDays.localDate, present: sql<number>`count(*)::int` })
      .from(bookingGuests)
      .innerJoin(bookings, eq(bookings.id, bookingGuests.bookingId))
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .innerJoin(trainingDays, eq(trainingDays.id, trainingSlots.trainingDayId))
      .where(
        and(
          mine,
          eq(bookings.status, 'ACTIVE'),
          eq(bookingGuests.status, 'ACTIVE'),
          eq(bookingGuests.attendance, 'PRESENT'),
        ),
      )
      .groupBy(trainingDays.localDate);
    // So a day nobody came counts as 0 in the weekday average
    const days = await this.database.db
      .selectDistinct({ localDate: trainingDays.localDate })
      .from(trainingSlots)
      .innerJoin(trainingDays, eq(trainingDays.id, trainingSlots.trainingDayId))
      .where(mine);

    const present = new Map<string, number>(days.map((d) => [d.localDate, 0]));
    for (const r of [...members, ...guests]) present.set(r.localDate, (present.get(r.localDate) ?? 0) + r.present);
    return summarizeLoad(present);
  }
}

// Weekday: 1 = Monday ... 7 = Sunday
export function summarizeLoad(present: Map<string, number>) {
  const busiestDays = [...present]
    .filter(([, n]) => n > 0)
    .sort(([a, x], [b, y]) => y - x || b.localeCompare(a))
    .slice(0, TOP_DAYS)
    .map(([localDate, n]) => ({ localDate, present: n }));

  const perWeekday = new Map<number, { days: number; present: number }>();
  for (const [date, n] of present) {
    const weekday = DateTime.fromISO(date, { zone: KY_ZONE }).weekday;
    const w = perWeekday.get(weekday) ?? { days: 0, present: 0 };
    perWeekday.set(weekday, { days: w.days + 1, present: w.present + n });
  }
  const weekdays = [...perWeekday]
    .sort(([a], [b]) => a - b)
    .map(([weekday, w]) => ({ weekday, days: w.days, avgPresent: Math.round((w.present / w.days) * 10) / 10 }));

  return { busiestDays, weekdays };
}
