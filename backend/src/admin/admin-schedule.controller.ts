import { Controller, Put, Patch, Body, Param, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { AdminScheduleService } from './admin-schedule.service';
import { SessionGuard } from '../auth/session.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { UpsertTrainingDayDto } from './dto/upsert-training-day.dto';
import { UpdateSlotDto } from './dto/update-slot.dto';

@Controller('admin')
@UseGuards(SessionGuard, AdminGuard)
export class AdminScheduleController {
  constructor(private readonly adminScheduleService: AdminScheduleService) {}

  @Put('training-days/:date')
  @HttpCode(HttpStatus.OK)
  upsertTrainingDay(
    @Param('date') date: string,
    @Body() dto: UpsertTrainingDayDto,
  ) {
    return this.adminScheduleService.upsertTrainingDay(date, dto);
  }

  @Patch('slots/:slotId')
  @HttpCode(HttpStatus.OK)
  updateSlot(@Param('slotId') slotId: string, @Body() dto: UpdateSlotDto) {
    return this.adminScheduleService.updateSlot(slotId, dto);
  }
}