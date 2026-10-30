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

// The scheduled jobs behind /internal/cron/* (InternalCronController checks the secret and calls these)
@Injectable()
export class CronService {
  constructor(
    private readonly database: DatabaseService,
    private readonly notifications: NotificationService,
    private readonly announcementsService: AnnouncementsService,
    private readonly clock: ClockService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // «Записуйтесь»: a push to each trainer's clients once that trainer's booking opens
  async bookingOpen() {
    const now = this.clock.now();
    const today = now.toISODate()!;

    // Find today's scheduled training day
    const day = await trainingDayOn(this.database.db, today);

    if (!day || day.status !== 'SCHEDULED') {
      return { ok: true, skipped: 'no scheduled day today' };
    }
    // Each trainer's clients get the push once that trainer's booking opens («Мій розклад»), and only until
    // their first group training of the day starts. Runs every few minutes (cron-job.org); the dedupe key per
    // trainer and day keeps it to one push
    const trainers = await this.groupTrainersToday(day.id);
    if (trainers.length === 0) {
      return { ok: true, skipped: 'no group trainings today' };
    }
    const firstTrainerId = await getDefaultTrainerId(this.database.db);

    const sent: string[] = [];
    for (const trainerId of [...new Set(trainers.map((t) => t.trainerId))]) {
      const { bookingOpensAt: opensAt } = await loadTrainerSchedule(this.database.db, trainerId);
      // The first group training that can be booked: one before the opening time (added in the calendar) can't
      const firstTime = trainers
        .filter((t) => t.trainerId === trainerId && t.slotTime > opensAt)
        .map((t) => t.slotTime)
        .sort()[0];
      if (!firstTime || now < bookingOpensAt(today, opensAt) || now >= slotStartsAt(today, firstTime)) continue;
      await this.notifications.enqueueAndProcess('BOOKING_OPEN', `booking-open:${today}:${trainerId}`, {
        localDate: today,
        trainerIds: [trainerId],
        // members without a trainer see the first trainer's group trainings
        includeUnassigned: trainerId === firstTrainerId,
      });
      sent.push(trainerId);
    }

    return { ok: true, localDate: today, trainerIds: sent };
  }

  // The day's AI announcement, on days with group trainings
  async generateAnnouncement() {
    const nowAnn = this.clock.now();
    const todayAnn = nowAnn.toISODate()!;

    const day = await trainingDayOn(this.database.db, todayAnn);

    if (!day || day.status !== 'SCHEDULED') {
      return { ok: true, skipped: 'no scheduled day today' };
    }
    // The announcement is shown with group slots only
    if ((await this.groupTrainersToday(day.id)).length === 0) {
      return { ok: true, skipped: 'no group trainings today' };
    }

    await this.announcementsService.autoGenerate(todayAnn);
    return { ok: true, localDate: todayAnn };
  }

  // 22:00 (Kyiv, ± the DST hour): unmarked bookings and guests of trainings that are over get ✓
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

    // Only trainings that are over (an hour after the start): Vercel runs crons in UTC, so this job comes at a
    // different Kyiv hour in winter and summer, and must not mark a training that is still going on
    const unmarkedBookings = unmarked.filter((b) => now >= slotOverAt(today, b.slotTime));
    const guestsMarked = await this.markGuests(day.id, today, now);

    if (unmarkedBookings.length === 0) {
      return { ok: true, marked: 0, guestsMarked };
    }

    const markedAt = now.toJSDate();
    await this.database.db.transaction(async (tx) => {
      for (const booking of inLockOrder(unmarkedBookings)) {
        // Marked in the name of the training's trainer; spends from the package like a ✓ by hand
        await tx
          .insert(attendance)
          .values({ bookingId: booking.id, status: 'PRESENT', markedAt, markedByAdminId: booking.trainerId })
          .onConflictDoNothing();
        await this.entitlements.syncSpend(tx, booking.id);
      }
    });

    return { ok: true, marked: unmarkedBookings.length, guestsMarked, slots: slots.length };
  }

  // Guests on trainings that are over and still unmarked: ✓ like their hosts, in the trainer's name (nothing to spend)
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

  // Today's active group trainings: trainer and time
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
