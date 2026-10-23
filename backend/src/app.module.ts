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
import { ClockModule } from './clock/clock.module';
import { PaymentModule } from './payment/payment.module';
import { PricesModule } from './prices/prices.module';
import { PurchasesModule } from './purchases/purchases.module';
import { TrainerScheduleModule } from './trainer-schedule/trainer-schedule.module';

@Module({
  imports: [
    DatabaseModule,
    ClockModule,
    HealthModule,
    AuthModule,
    ScheduleModule,
    BookingModule,
    AdminScheduleModule,
    NotificationsModule,
    AiModule,
    PaymentModule,
    PricesModule,
    PurchasesModule,
    TrainerScheduleModule,
  ],
})
export class AppModule {}
