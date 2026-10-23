import { Module } from '@nestjs/common';
import { AdminScheduleController } from './admin-schedule.controller';
import { AdminScheduleService } from './admin-schedule.service';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EntitlementsModule } from '../purchases/entitlements.module';

@Module({
  imports: [AuthModule, NotificationsModule, EntitlementsModule],
  controllers: [AdminScheduleController],
  providers: [AdminScheduleService],
})
export class AdminScheduleModule {}
