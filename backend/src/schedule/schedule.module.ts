import { Module } from '@nestjs/common';
import { ScheduleController } from './schedule.controller';
import { ScheduleService } from './schedule.service';
import { AuthModule } from '../auth/auth.module';
import { DemoModule } from '../demo/demo.module';
import { PaymentModule } from '../payment/payment.module';

@Module({
  imports: [AuthModule, DemoModule, PaymentModule],
  controllers: [ScheduleController],
  providers: [ScheduleService],
  exports: [ScheduleService],
})
export class ScheduleModule {}