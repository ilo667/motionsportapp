import { Module } from '@nestjs/common';
import { AdminScheduleController } from './admin-schedule.controller';
import { AdminScheduleService } from './admin-schedule.service';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [AdminScheduleController],
  providers: [AdminScheduleService],
})
export class AdminScheduleModule {}