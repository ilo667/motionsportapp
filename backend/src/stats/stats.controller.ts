import { Controller, Get, UseGuards } from '@nestjs/common';
import { StatsService } from './stats.service';
import { SessionGuard, SessionUser } from '../auth/session.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';

@Controller('admin/stats')
@UseGuards(SessionGuard, AdminGuard)
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get()
  get(@CurrentUser() user: SessionUser) {
    return this.statsService.forTrainer(user.id);
  }
}
