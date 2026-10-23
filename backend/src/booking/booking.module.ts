import { Module } from '@nestjs/common';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EntitlementsModule } from '../purchases/entitlements.module';

@Module({
  imports: [AuthModule, NotificationsModule, EntitlementsModule],
  controllers: [BookingController],
  providers: [BookingService],
})
export class BookingModule {}
