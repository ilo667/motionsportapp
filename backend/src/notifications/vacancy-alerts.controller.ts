import { Controller, Put, Delete, Param, UseGuards, HttpCode, ParseUUIDPipe } from '@nestjs/common';
import { SessionGuard, SessionUser } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { VacancyAlertsService } from './vacancy-alerts.service';

@Controller('slots')
@UseGuards(SessionGuard)
export class VacancyAlertsController {
  constructor(private readonly svc: VacancyAlertsService) {}

  @Put(':slotId/vacancy-alert')
  @HttpCode(200)
  async subscribe(@Param('slotId', ParseUUIDPipe) slotId: string, @CurrentUser() user: SessionUser) {
    await this.svc.subscribe(user.id, slotId);
    return { ok: true };
  }

  @Delete(':slotId/vacancy-alert')
  @HttpCode(200)
  async unsubscribe(@Param('slotId', ParseUUIDPipe) slotId: string, @CurrentUser() user: SessionUser) {
    await this.svc.unsubscribe(user.id, slotId);
    return { ok: true };
  }
}
