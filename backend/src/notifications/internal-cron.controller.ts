import { Controller, Get, Headers, ForbiddenException } from '@nestjs/common';
import { PaymentService } from '../payment/payment.service';
import { safeEqual } from '../auth/token';
import { CronService } from './cron.service';

// Vercel Cron calls with GET and `Authorization: Bearer $CRON_SECRET`; routes must be @Get.
// Only checks the secret; the jobs are in CronService
@Controller('internal')
export class InternalCronController {
  constructor(
    private readonly cron: CronService,
    private readonly paymentService: PaymentService,
  ) {}

  @Get('cron/booking-open')
  async bookingOpen(@Headers('authorization') auth: string) {
    this.verifyCronSecret(auth);
    return this.cron.bookingOpen();
  }

  @Get('cron/generate-announcement')
  async generateAnnouncement(@Headers('authorization') auth: string) {
    this.verifyCronSecret(auth);
    return this.cron.generateAnnouncement();
  }

  @Get('cron/auto-confirm-attendance')
  async autoConfirmAttendance(@Headers('authorization') auth: string) {
    this.verifyCronSecret(auth);
    return this.cron.autoConfirmAttendance();
  }

  @Get('cron/expire-payments')
  async expirePayments(@Headers('authorization') auth: string) {
    this.verifyCronSecret(auth);
    return this.paymentService.expireStale();
  }

  private verifyCronSecret(auth: string | undefined) {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      // Allow manual runs locally; in production a missing secret is a misconfiguration
      if (process.env.NODE_ENV === 'production') throw new ForbiddenException('CRON_SECRET is not configured');
      return;
    }
    if (!safeEqual(`Bearer ${cronSecret}`, auth)) throw new ForbiddenException();
  }
}
