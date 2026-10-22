import {
  Controller,
  Get,
  Put,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { AdminScheduleService } from './admin-schedule.service';
import { SessionGuard, SessionUser } from '../auth/session.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UpsertTrainingDayDto } from './dto/upsert-training-day.dto';
import { UpdateSlotDto } from './dto/update-slot.dto';
import { UpdateAttendanceDto } from './dto/update-attendance.dto';
import { UpdateMemberNoteDto } from './dto/update-member-note.dto';
import { CreateAssignedSlotDto } from './dto/create-assigned-slot.dto';
import { SlotMembersDto } from './dto/update-slot-members.dto';

@Controller('admin')
@UseGuards(SessionGuard, AdminGuard)
export class AdminScheduleController {
  constructor(private readonly adminScheduleService: AdminScheduleService) {}

  @Get('schedule')
  getSchedule() {
    return this.adminScheduleService.getSchedule();
  }

  @Get('members')
  getMembers() {
    return this.adminScheduleService.getMembers();
  }

  @Patch('members/:memberId/note')
  updateMemberNote(@Param('memberId', ParseUUIDPipe) memberId: string, @Body() dto: UpdateMemberNoteDto) {
    return this.adminScheduleService.updateMemberNote(memberId, dto);
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

  // Group slot (19:00 / 20:00). Assigned slots: POST training-days/:date/assigned-slots
  @Put('training-days/:date/slots/:slotTime')
  @HttpCode(HttpStatus.OK)
  upsertCalendarSlot(
    @Param('date') date: string,
    @Param('slotTime') slotTime: string,
  ) {
    return this.adminScheduleService.upsertGroupSlot(date, slotTime);
  }

  @Post('training-days/:date/assigned-slots')
  createAssignedSlot(@Param('date') date: string, @Body() dto: CreateAssignedSlotDto) {
    return this.adminScheduleService.createAssignedSlot(date, dto);
  }

  @Put('slots/:slotId/members')
  @HttpCode(HttpStatus.OK)
  updateSlotMembers(@Param('slotId', ParseUUIDPipe) slotId: string, @Body() dto: SlotMembersDto) {
    return this.adminScheduleService.updateSlotMembers(slotId, dto.memberIds);
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