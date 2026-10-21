// TODO: migrate to config module for env validation
import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { ScheduleModule } from './schedule/schedule.module';
import { BookingModule } from './booking/booking.module';
import { AdminScheduleModule } from './admin/admin-schedule.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AiModule } from './ai/ai.module';
import { DemoModule } from './demo/demo.module';
import { PaymentModule } from './payment/payment.module';

@Module({
  imports: [DatabaseModule, HealthModule, AuthModule, ScheduleModule, BookingModule, AdminScheduleModule, NotificationsModule, AiModule, DemoModule, PaymentModule],
})
export class AppModule {}