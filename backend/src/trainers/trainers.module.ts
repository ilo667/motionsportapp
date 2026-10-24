import { Module } from '@nestjs/common';
import { TrainerInvitesController } from './trainer-invites.controller';
import { TrainerInvitesService } from './trainer-invites.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [TrainerInvitesController],
  providers: [TrainerInvitesService],
})
export class TrainersModule {}
