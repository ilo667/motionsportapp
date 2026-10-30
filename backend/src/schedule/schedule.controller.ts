import { Controller, Get, UseGuards } from '@nestjs/common';
import { ScheduleService } from './schedule.service';
import { SessionGuard } from '../auth/session.guard';
import { MemberGuard } from '../common/guards/member.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.guard';

@Controller('schedule')
export class ScheduleController {
  constructor(private readonly scheduleService: ScheduleService) {}

  // A trainer's session gets 403
  @Get('next')
  @UseGuards(SessionGuard, MemberGuard)
  async getNext(@CurrentUser() user: SessionUser) {
    return this.scheduleService.getNext(user.id);
  }
}
