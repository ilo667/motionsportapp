import { Controller, Get, UseGuards } from '@nestjs/common';
import { ScheduleService } from './schedule.service';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.guard';

@Controller('schedule')
export class ScheduleController {
  constructor(private readonly scheduleService: ScheduleService) {}

  @Get('next')
  @UseGuards(SessionGuard)
  async getNext(@CurrentUser() user: SessionUser) {
    const memberId = user.type === 'member' ? user.id : undefined;
    return this.scheduleService.getNext(memberId);
  }
}