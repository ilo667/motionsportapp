import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TrainerScheduleController } from './trainer-schedule.controller';
import { TrainerScheduleService } from './trainer-schedule.service';

@Module({
  imports: [AuthModule],
  controllers: [TrainerScheduleController],
  providers: [TrainerScheduleService],
})
export class TrainerScheduleModule {}
