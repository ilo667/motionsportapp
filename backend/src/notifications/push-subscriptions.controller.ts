import {
  Controller,
  Post,
  Delete,
  Get,
  Body,
  UseGuards,
  HttpCode,
  Req,
} from '@nestjs/common';
import { SessionGuard, SessionUser } from '../auth/session.guard';
import { PushSubscriptionsService } from './push-subscriptions.service';
import {
  UpsertPushSubscriptionDto,
  DeletePushSubscriptionDto,
} from './dto/upsert-push-subscription.dto';

@Controller('push')
export class PushSubscriptionsController {
  constructor(private readonly svc: PushSubscriptionsService) {}

  @Get('vapid-public-key')
  getVapidKey() {
    return { publicKey: process.env.VAPID_PUBLIC_KEY ?? '' };
  }

  @Post('subscriptions')
  @UseGuards(SessionGuard)
  @HttpCode(200)
  async subscribe(@Body() dto: UpsertPushSubscriptionDto, @Req() req: Express.Request) {
    const user = (req as unknown as { user: SessionUser }).user;
    if (user.type === 'admin') await this.svc.upsertAdmin(user.id, dto.endpoint, dto.p256dh, dto.auth);
    else await this.svc.upsert(user.id, dto.endpoint, dto.p256dh, dto.auth);
    return { ok: true };
  }

  @Delete('subscriptions')
  @UseGuards(SessionGuard)
  @HttpCode(200)
  async unsubscribe(@Body() dto: DeletePushSubscriptionDto, @Req() req: Express.Request) {
    const user = (req as unknown as { user: SessionUser }).user;
    if (user.type === 'admin') await this.svc.removeAdmin(user.id, dto.endpoint);
    else await this.svc.remove(user.id, dto.endpoint);
    return { ok: true };
  }
}