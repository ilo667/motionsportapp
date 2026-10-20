import { Module } from '@nestjs/common';
import { AdminScheduleController } from './admin-schedule.controller';
import { AdminScheduleService } from './admin-schedule.service';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DemoModule } from '../demo/demo.module';

@Module({
  imports: [AuthModule, NotificationsModule, DemoModule],
  controllers: [AdminScheduleController],
  providers: [AdminScheduleService],
})
export class AdminScheduleModule {}