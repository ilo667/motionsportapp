import {
  Controller,
  Post,
  Headers,
  ForbiddenException,
  HttpCode,
} from '@nestjs/common';
import { DateTime } from 'luxon';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { NotificationService } from './notification.service';
import { trainingDays } from '../database/schema';

const KY_ZONE = 'Europe/Kyiv';

@Controller('internal')
export class InternalCronController {
  constructor(
    private readonly database: DatabaseService,
    private readonly notifications: NotificationService,
  ) {}

  @Post('cron/booking-open')
  @HttpCode(200)
  async bookingOpen(@Headers('authorization') auth: string) {
    this.verifyCronSecret(auth);


    const now = DateTime.now().setZone(KY_ZONE);
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

  private verifyCronSecret(auth: string) {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) return; // not configured — allow (portfolio/dev)
    const expected = `Bearer ${cronSecret}`;
    if (auth !== expected) throw new ForbiddenException();
  }
}