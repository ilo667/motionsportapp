import { Module } from '@nestjs/common';
import { AdminScheduleController } from './admin-schedule.controller';
import { AdminScheduleService } from './admin-schedule.service';
import { AdminSlotsService } from './admin-slots.service';
import { AdminAttendanceController } from './admin-attendance.controller';
import { AdminAttendanceService } from './admin-attendance.service';
import { AdminMembersController } from './admin-members.controller';
import { AdminMembersService } from './admin-members.service';
import { AdminTrainersController } from './admin-trainers.controller';
import { AdminTrainersService } from './admin-trainers.service';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EntitlementsModule } from '../purchases/entitlements.module';

@Module({
  imports: [AuthModule, NotificationsModule, EntitlementsModule],
  controllers: [AdminScheduleController, AdminAttendanceController, AdminMembersController, AdminTrainersController],
  providers: [
    AdminScheduleService,
    AdminSlotsService,
    AdminAttendanceService,
    AdminMembersService,
    AdminTrainersService,
  ],
})
export class AdminScheduleModule {}
