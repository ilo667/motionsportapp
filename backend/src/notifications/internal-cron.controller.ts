import {
  Controller,
  Post,
  Headers,
  ForbiddenException,
  HttpCode,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { and, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { NotificationService } from './notification.service';
import { AnnouncementsService } from '../ai/announcements.service';
import { DemoService } from '../demo/demo.service';
import { trainingDays, trainingSlots, bookings, attendance, admins } from '../database/schema';

const KY_ZONE = 'Europe/Kyiv';

@Controller('internal')
export class InternalCronController {
  constructor(
    private readonly database: DatabaseService,
    private readonly notifications: NotificationService,
    private readonly announcementsService: AnnouncementsService,
    private readonly demoService: DemoService,
  ) {}

  @Post('cron/booking-open')
  @HttpCode(200)
  async bookingOpen(@Headers('authorization') auth: string) {
    this.verifyCronSecret(auth);


    const now = await this.demoService.getNow();
    const today = now.toISODate()!;

    // Find today's scheduled training day
    const [day] = await this.database.db
      .select()
      .from(trainingDays)
      .where(eq(trainingDays.localDate, today))
      .limit(1);

    if (!day || day.status !== 'SCHEDULED') {
      return { ok: true, skipped: 'no scheduled day today' };
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
    });

    return { ok: true, localDate: today };
  }

  @Post('cron/process-outbox')
  @HttpCode(200)
  async processOutbox(@Headers('authorization') auth: string) {
    this.verifyCronSecret(auth);
    await this.notifications.processAllPending();
    return { ok: true };
  }

  @Post('cron/generate-announcement')
  @HttpCode(200)
  async generateAnnouncement(@Headers('authorization') auth: string) {
    this.verifyCronSecret(auth);
    const nowAnn = await this.demoService.getNow();
    const todayAnn = nowAnn.toISODate()!;

    const [day] = await this.database.db
      .select()
      .from(trainingDays)
      .where(eq(trainingDays.localDate, todayAnn))
      .limit(1);

    if (!day || day.status !== 'SCHEDULED') {
      return { ok: true, skipped: 'no scheduled day today' };
    }

    await this.announcementsService.autoGenerate(todayAnn);
    return { ok: true, localDate: todayAnn };
  }

  @Post('cron/auto-confirm-attendance')
  @HttpCode(200)
  async autoConfirmAttendance(@Headers('authorization') auth: string) {
    this.verifyCronSecret(auth);

    const now = await this.demoService.getNow();
    const today = now.toISODate()!;

    const [day] = await this.database.db
      .select()
      .from(trainingDays)
      .where(eq(trainingDays.localDate, today))
      .limit(1);

    if (!day || day.status === 'CANCELLED') {
      return { ok: true, skipped: 'no active day today' };
    }

    const [admin] = await this.database.db
      .select({ id: admins.id })
      .from(admins)
      .limit(1);

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
      .leftJoin(attendance, eq(attendance.bookingId, bookings.id))
      .where(
        and(
          eq(bookings.trainingDayId, day.id),
          eq(bookings.status, 'ACTIVE'),
          isNull(attendance.bookingId),
        ),
      );

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

  private verifyCronSecret(auth: string) {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) return; // not configured — allow (portfolio/dev)
    const expected = `Bearer ${cronSecret}`;
    if (auth !== expected) throw new ForbiddenException();
  }
}