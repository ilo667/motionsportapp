import {
  Controller,
  Get,
  Put,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AdminScheduleService } from './admin-schedule.service';
import { SessionGuard, SessionUser } from '../auth/session.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UpsertTrainingDayDto } from './dto/upsert-training-day.dto';
import { UpdateSlotDto } from './dto/update-slot.dto';
import { UpdateAttendanceDto } from './dto/update-attendance.dto';

@Controller('admin')
@UseGuards(SessionGuard, AdminGuard)
export class AdminScheduleController {
  constructor(private readonly adminScheduleService: AdminScheduleService) {}

  @Get('schedule')
  getSchedule() {
    return this.adminScheduleService.getSchedule();
  }

  @Get('calendar')
  getCalendar(@Query('month') month: string) {
    return this.adminScheduleService.getCalendar(month);
  }

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

  @Put('slots/:slotId/attendance/all')
  @HttpCode(HttpStatus.OK)
  markAllAttendance(
    @Param('slotId') slotId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.adminScheduleService.markAllAttendance(slotId, user.id);
  }

  @Patch('bookings/:bookingId/attendance')
  @HttpCode(HttpStatus.OK)
  updateBookingAttendance(
    @Param('bookingId') bookingId: string,
    @Body() dto: UpdateAttendanceDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.adminScheduleService.updateBookingAttendance(bookingId, dto, user.id);
  }
}