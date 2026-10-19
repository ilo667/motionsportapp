import { Controller, Put, Delete, Param, UseGuards, Req, HttpCode } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { VacancyAlertsService } from './vacancy-alerts.service';

@Controller('slots')
@UseGuards(SessionGuard)
export class VacancyAlertsController {
  constructor(private readonly svc: VacancyAlertsService) {}

  @Put(':slotId/vacancy-alert')
  @HttpCode(200)
  async subscribe(@Param('slotId') slotId: string, @Req() req: Express.Request) {
    const user = (req as unknown as { user: { id: string } }).user;
    await this.svc.subscribe(user.id, slotId);
    return { ok: true };
  }

  @Delete(':slotId/vacancy-alert')
  @HttpCode(200)
  async unsubscribe(@Param('slotId') slotId: string, @Req() req: Express.Request) {
    const user = (req as unknown as { user: { id: string } }).user;
    await this.svc.unsubscribe(user.id, slotId);
    return { ok: true };
  }
}