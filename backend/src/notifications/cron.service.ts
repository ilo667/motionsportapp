import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { NotificationService } from './notification.service';
import { AnnouncementsService } from '../ai/announcements.service';
import { ClockService } from '../clock/clock.service';
import { EntitlementsService, inLockOrder } from '../purchases/entitlements.service';
import { trainingSlots, bookings, attendance, bookingGuests } from '../database/schema';
import { GROUP_TYPE, slotOverAt, slotStartsAt } from '../schedule/training-types';
import { bookingOpensAt } from '../trainer-schedule/rules';
import { loadTrainerSchedule } from '../trainer-schedule/trainer-schedule.store';
import { getDefaultTrainerId } from '../schedule/default-trainer';
import { trainingDayOn } from '../schedule/training-day.store';

// Jobs behind /internal/cron/*; InternalCronController checks the secret
@Injectable()
export class CronService {
  constructor(
    private readonly database: DatabaseService,
    private readonly notifications: NotificationService,
    private readonly announcementsService: AnnouncementsService,
    private readonly clock: ClockService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async bookingOpen() {
    const now = this.clock.now();
    const today = now.toISODate()!;

    const day = await trainingDayOn(this.database.db, today);

    if (!day || day.status !== 'SCHEDULED') {
      return { ok: true, skipped: 'no scheduled day today' };
    }
    // Per trainer: from their booking opening until their first group training starts. Runs every 15 min
    // (cron-job.org); the per-trainer-and-day dedupe key keeps it to one push
    const trainers = await this.groupTrainersToday(day.id);
    if (trainers.length === 0) {
      return { ok: true, skipped: 'no group trainings today' };
    }
    const firstTrainerId = await getDefaultTrainerId(this.database.db);

    const sent: string[] = [];
    for (const trainerId of [...new Set(trainers.map((t) => t.trainerId))]) {
      const { bookingOpensAt: opensAt } = await loadTrainerSchedule(this.database.db, trainerId);
      // A training before the opening time can't be booked, so it doesn't count
      const firstTime = trainers
        .filter((t) => t.trainerId === trainerId && t.slotTime > opensAt)
        .map((t) => t.slotTime)
        .sort()[0];
      if (!firstTime || now < bookingOpensAt(today, opensAt) || now >= slotStartsAt(today, firstTime)) continue;
      await this.notifications.enqueueAndProcess('BOOKING_OPEN', `booking-open:${today}:${trainerId}`, {
        localDate: today,
        trainerIds: [trainerId],
        // Members without a trainer see the first trainer's group trainings
        includeUnassigned: trainerId === firstTrainerId,
      });
      sent.push(trainerId);
    }

    return { ok: true, localDate: today, trainerIds: sent };
  }

  async generateAnnouncement() {
    const nowAnn = this.clock.now();
    const todayAnn = nowAnn.toISODate()!;

    const day = await trainingDayOn(this.database.db, todayAnn);

    if (!day || day.status !== 'SCHEDULED') {
      return { ok: true, skipped: 'no scheduled day today' };
    }
    if ((await this.groupTrainersToday(day.id)).length === 0) {
      return { ok: true, skipped: 'no group trainings today' };
    }

    await this.announcementsService.autoGenerate(todayAnn);
    return { ok: true, localDate: todayAnn };
  }

  // 22:00 Kyiv (23:00 in summer): marks unmarked bookings and guests of finished trainings PRESENT
  async autoConfirmAttendance() {
    const now = this.clock.now();
    const today = now.toISODate()!;

    const day = await trainingDayOn(this.database.db, today);

    if (!day || day.status === 'CANCELLED') {
      return { ok: true, skipped: 'no active day today' };
    }

    const slots = await this.database.db
      .select({ id: trainingSlots.id })
      .from(trainingSlots)
      .where(and(eq(trainingSlots.trainingDayId, day.id), eq(trainingSlots.status, 'ACTIVE')));

    const unmarked = await this.database.db
      .select({
        id: bookings.id,
        memberId: bookings.memberId,
        trainerId: trainingSlots.trainerId,
        slotTime: trainingSlots.slotTime,
      })
      .from(bookings)
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .leftJoin(attendance, eq(attendance.bookingId, bookings.id))
      .where(and(eq(trainingSlots.trainingDayId, day.id), eq(bookings.status, 'ACTIVE'), isNull(attendance.bookingId)));

    // Only finished trainings: the UTC cron shifts by an hour with DST and must not mark one still going on
    const unmarkedBookings = unmarked.filter((b) => now >= slotOverAt(today, b.slotTime));
    const guestsMarked = await this.markGuests(day.id, today, now);

    if (unmarkedBookings.length === 0) {
      return { ok: true, marked: 0, guestsMarked };
    }

    const markedAt = now.toJSDate();
    await this.database.db.transaction(async (tx) => {
      for (const booking of inLockOrder(unmarkedBookings)) {
        // In the trainer's name; spends like a manual mark
        await tx
          .insert(attendance)
          .values({ bookingId: booking.id, status: 'PRESENT', markedAt, markedByAdminId: booking.trainerId })
          .onConflictDoNothing();
        await this.entitlements.syncSpend(tx, booking.id);
      }
    });

    return { ok: true, marked: unmarkedBookings.length, guestsMarked, slots: slots.length };
  }

  private async markGuests(dayId: string, today: string, now: ReturnType<ClockService['now']>) {
    const guests = await this.database.db
      .select({ id: bookingGuests.id, trainerId: trainingSlots.trainerId, slotTime: trainingSlots.slotTime })
      .from(bookingGuests)
      .innerJoin(bookings, eq(bookings.id, bookingGuests.bookingId))
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .where(
        and(
          eq(trainingSlots.trainingDayId, dayId),
          eq(trainingSlots.status, 'ACTIVE'),
          eq(bookings.status, 'ACTIVE'),
          eq(bookingGuests.status, 'ACTIVE'),
          isNull(bookingGuests.attendance),
        ),
      );
    const over = guests.filter((g) => now >= slotOverAt(today, g.slotTime));
    for (const g of over) {
      await this.database.db
        .update(bookingGuests)
        .set({ attendance: 'PRESENT', markedAt: now.toJSDate(), markedByAdminId: g.trainerId })
        .where(and(eq(bookingGuests.id, g.id), isNull(bookingGuests.attendance)));
    }
    return over.length;
  }

  private async groupTrainersToday(dayId: string) {
    return this.database.db
      .select({ trainerId: trainingSlots.trainerId, slotTime: trainingSlots.slotTime })
      .from(trainingSlots)
      .where(
        and(
          eq(trainingSlots.trainingDayId, dayId),
          eq(trainingSlots.trainingType, GROUP_TYPE),
          eq(trainingSlots.status, 'ACTIVE'),
        ),
      );
  }
}
