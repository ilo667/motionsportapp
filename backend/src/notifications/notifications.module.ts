import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { PushService } from './push.service';
import { PushSubscriptionsService } from './push-subscriptions.service';
import { VacancyAlertsService } from './vacancy-alerts.service';
import { NotificationService } from './notification.service';
import { PushSubscriptionsController } from './push-subscriptions.controller';
import { VacancyAlertsController } from './vacancy-alerts.controller';
import { InternalCronController } from './internal-cron.controller';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [PushSubscriptionsController, VacancyAlertsController, InternalCronController],
  providers: [PushService, PushSubscriptionsService, VacancyAlertsService, NotificationService],
  exports: [NotificationService, VacancyAlertsService],
})
export class NotificationsModule {}