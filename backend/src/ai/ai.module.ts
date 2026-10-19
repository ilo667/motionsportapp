import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AnnouncementGeneratorService } from './announcement-generator.service';
import { AnnouncementsService } from './announcements.service';
import { AnnouncementExamplesController, AnnouncementsController } from './announcements.controller';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [AnnouncementExamplesController, AnnouncementsController],
  providers: [AnnouncementGeneratorService, AnnouncementsService],
  exports: [AnnouncementsService],
})
export class AiModule {}