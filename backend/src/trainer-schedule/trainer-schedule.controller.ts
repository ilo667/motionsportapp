import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { SessionGuard, SessionUser } from '../auth/session.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { TrainerScheduleService } from './trainer-schedule.service';
import { SaveScheduleDto } from './dto/save-schedule.dto';

// «Мій розклад»: the signed-in trainer's own regular group trainings
@Controller('admin/my-schedule')
@UseGuards(SessionGuard, AdminGuard)
export class TrainerScheduleController {
  constructor(private readonly schedules: TrainerScheduleService) {}

  @Get()
  get(@CurrentUser() user: SessionUser) {
    return this.schedules.get(user.id);
  }

  @Put()
  save(@Body() dto: SaveScheduleDto, @CurrentUser() user: SessionUser) {
    return this.schedules.save(user.id, dto);
  }
}
