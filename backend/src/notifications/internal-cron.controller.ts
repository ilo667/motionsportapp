import { Controller, Get, Headers, ForbiddenException } from '@nestjs/common';
import * as crypto from 'crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { NotificationService } from './notification.service';
import { AnnouncementsService } from '../ai/announcements.service';
import { ClockService } from '../clock/clock.service';
import { PaymentService } from '../payment/payment.service';
import { EntitlementsService, inLockOrder } from '../purchases/entitlements.service';
import { trainingDays, trainingSlots, bookings, attendance } from '../database/schema';
import { GROUP_TYPE, slotStartsAt } from '../schedule/training-types';
import { bookingOpensAt } from '../trainer-schedule/rules';
import { loadTrainerSchedule } from '../trainer-schedule/trainer-schedule.store';
import { getDefaultTrainerId } from '../schedule/default-trainer';

// Vercel Cron invokes paths with GET and sends `Authorization: Bearer $CRON_SECRET`.
// Manual run: curl -H "Authorization: Bearer $CRON_SECRET" https://<backend>/internal/cron/<job>
@Controller('internal')
export class InternalCronController {
  constructor(
    private readonly database: DatabaseService,
    private readonly notifications: NotificationService,
    private readonly announcementsService: AnnouncementsService,
    private readonly clock: ClockService,
    private readonly paymentService: PaymentService,
    private readonly entitlements: EntitlementsService,
  ) {}

  @Get('cron/booking-open')
  async bookingOpen(@Headers('authorization') auth: string) {
    this.verifyCronSecret(auth);

    const now = this.clock.now();
    const today = now.toISODate()!;

    // Find today's scheduled training day
    const [day] = await this.database.db.select().from(trainingDays).where(eq(trainingDays.localDate, today)).limit(1);

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
    for (const { trainerId, firstTime } of trainers) {
      const { bookingOpensAt: opensAt } = await loadTrainerSchedule(this.database.db, trainerId);
      if (now < bookingOpensAt(today, opensAt) || now >= slotStartsAt(today, firstTime)) continue;
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

  @Get('cron/generate-announcement')
  async generateAnnouncement(@Headers('authorization') auth: string) {
    this.verifyCronSecret(auth);
    const nowAnn = this.clock.now();
    const todayAnn = nowAnn.toISODate()!;

    const [day] = await this.database.db
      .select()
      .from(trainingDays)
      .where(eq(trainingDays.localDate, todayAnn))
      .limit(1);

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

  @Get('cron/auto-confirm-attendance')
  async autoConfirmAttendance(@Headers('authorization') auth: string) {
    this.verifyCronSecret(auth);

    const now = this.clock.now();
    const today = now.toISODate()!;

    const [day] = await this.database.db.select().from(trainingDays).where(eq(trainingDays.localDate, today)).limit(1);

    if (!day || day.status === 'CANCELLED') {
      return { ok: true, skipped: 'no active day today' };
    }

    const slots = await this.database.db
      .select({ id: trainingSlots.id })
      .from(trainingSlots)
      .where(and(eq(trainingSlots.trainingDayId, day.id), eq(trainingSlots.status, 'ACTIVE')));

    const unmarkedBookings = await this.database.db
      .select({ id: bookings.id, memberId: bookings.memberId, trainerId: trainingSlots.trainerId })
      .from(bookings)
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .leftJoin(attendance, eq(attendance.bookingId, bookings.id))
      .where(and(eq(trainingSlots.trainingDayId, day.id), eq(bookings.status, 'ACTIVE'), isNull(attendance.bookingId)));

    if (unmarkedBookings.length === 0) {
      return { ok: true, marked: 0 };
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

    return { ok: true, marked: unmarkedBookings.length, slots: slots.length };
  }

  @Get('cron/expire-payments')
  async expirePayments(@Headers('authorization') auth: string) {
    this.verifyCronSecret(auth);
    return this.paymentService.expireStale();
  }

  // Trainers with an active group training on that day
  // Trainers with an active group training today, each with the time of their first one
  private async groupTrainersToday(dayId: string) {
    return this.database.db
      .select({ trainerId: trainingSlots.trainerId, firstTime: sql<string>`min(${trainingSlots.slotTime})` })
      .from(trainingSlots)
      .where(
        and(
          eq(trainingSlots.trainingDayId, dayId),
          eq(trainingSlots.trainingType, GROUP_TYPE),
          eq(trainingSlots.status, 'ACTIVE'),
        ),
      )
      .groupBy(trainingSlots.trainerId);
  }

  private verifyCronSecret(auth: string | undefined) {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      // Locally there is no Vercel Cron, allow manual runs; in production a missing secret means misconfiguration
      if (process.env.NODE_ENV === 'production') throw new ForbiddenException('CRON_SECRET is not configured');
      return;
    }
    const expected = Buffer.from(`Bearer ${cronSecret}`);
    const actual = Buffer.from(auth ?? '');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      throw new ForbiddenException();
    }
  }
}
