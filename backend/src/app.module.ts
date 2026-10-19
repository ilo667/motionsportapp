import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { ScheduleModule } from './schedule/schedule.module';
import { BookingModule } from './booking/booking.module';
import { AdminScheduleModule } from './admin/admin-schedule.module';

@Module({
  imports: [DatabaseModule, HealthModule, AuthModule, ScheduleModule, BookingModule, AdminScheduleModule],
})
export class AppModule {}