import { Controller, Get, Headers, ForbiddenException } from '@nestjs/common';
import * as crypto from 'crypto';
import { DateTime } from 'luxon';
import { and, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { NotificationService } from './notification.service';
import { AnnouncementsService } from '../ai/announcements.service';
import { ClockService } from '../clock/clock.service';
import { PaymentService } from '../payment/payment.service';
import { trainingDays, trainingSlots, bookings, attendance, admins } from '../database/schema';
import { GROUP_TYPE, KY_ZONE } from '../schedule/training-types';
import { getDefaultCoachId } from '../schedule/default-coach';

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
    // Only clients of coaches who have group trainings today get the push
    const coachIds = await this.groupCoachIds(day.id);
    if (coachIds.length === 0) {
      return { ok: true, skipped: 'no group trainings today' };
    }

    const openAt = DateTime.fromISO(`${today}T14:00:00`, { zone: KY_ZONE });
    const twoHoursAfterOpen = openAt.plus({ hours: 2 });

    // Only send if we're within the 2-hour window after 14:00
    if (now < openAt || now > twoHoursAfterOpen) {
      return { ok: true, skipped: 'outside opening window' };
    }

    const dedupeKey = `booking-open:${today}`;
    await this.notifications.enqueueAndProcess('BOOKING_OPEN', dedupeKey, {
      localDate: today,
      coachIds,
      // members without a coach see the first coach's group trainings
      includeUnassigned: coachIds.includes((await getDefaultCoachId(this.database.db)) ?? ''),
    });

    return { ok: true, localDate: today };
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
    if ((await this.groupCoachIds(day.id)).length === 0) {
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

    const [admin] = await this.database.db.select({ id: admins.id }).from(admins).limit(1);

    if (!admin) {
      return { ok: true, skipped: 'no admin found' };
    }

    const slots = await this.database.db
      .select({ id: trainingSlots.id })
      .from(trainingSlots)
      .where(and(eq(trainingSlots.trainingDayId, day.id), eq(trainingSlots.status, 'ACTIVE')));

    const unmarkedBookings = await this.database.db
      .select({ id: bookings.id })
      .from(bookings)
      .innerJoin(trainingSlots, eq(trainingSlots.id, bookings.slotId))
      .leftJoin(attendance, eq(attendance.bookingId, bookings.id))
      .where(and(eq(trainingSlots.trainingDayId, day.id), eq(bookings.status, 'ACTIVE'), isNull(attendance.bookingId)));

    if (unmarkedBookings.length === 0) {
      return { ok: true, marked: 0 };
    }

    const markedAt = now.toJSDate();
    await this.database.db.transaction(async (tx) => {
      for (const booking of unmarkedBookings) {
        await tx
          .insert(attendance)
          .values({ bookingId: booking.id, status: 'PRESENT', markedAt, markedByAdminId: admin.id })
          .onConflictDoNothing();
      }
    });

    return { ok: true, marked: unmarkedBookings.length, slots: slots.length };
  }

  @Get('cron/expire-payments')
  async expirePayments(@Headers('authorization') auth: string) {
    this.verifyCronSecret(auth);
    return this.paymentService.expireStale();
  }

  // Coaches with an active group training on that day
  private async groupCoachIds(dayId: string) {
    const rows = await this.database.db
      .selectDistinct({ coachId: trainingSlots.coachId })
      .from(trainingSlots)
      .where(
        and(
          eq(trainingSlots.trainingDayId, dayId),
          eq(trainingSlots.trainingType, GROUP_TYPE),
          eq(trainingSlots.status, 'ACTIVE'),
        ),
      );
    return rows.map((r) => r.coachId);
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
