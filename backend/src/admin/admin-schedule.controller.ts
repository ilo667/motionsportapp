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
import { AdminSlotsService } from './admin-slots.service';
import { SessionGuard, SessionUser } from '../auth/session.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UpsertTrainingDayDto } from './dto/upsert-training-day.dto';
import { UpdateSlotDto } from './dto/update-slot.dto';
import { CreateAssignedSlotDto } from './dto/create-assigned-slot.dto';
import { SlotMembersDto } from './dto/update-slot-members.dto';
import { ParseDatePipe, ParseMonthPipe, ParseTimePipe } from '../common/pipes/date-pipes';

@Controller('admin')
@UseGuards(SessionGuard, AdminGuard)
export class AdminScheduleController {
  constructor(
    private readonly adminScheduleService: AdminScheduleService,
    private readonly adminSlotsService: AdminSlotsService,
  ) {}

  @Get('schedule')
  getSchedule(@CurrentUser() user: SessionUser) {
    return this.adminScheduleService.getSchedule(user.id);
  }

  @Get('history')
  getHistory(
    @CurrentUser() user: SessionUser,
    @Query('before', new ParseDatePipe({ optional: true })) before: string | undefined,
  ) {
    return this.adminScheduleService.getHistory(user.id, before);
  }

  @Get('slots/:slotId/cancellations')
  getSlotCancellations(@Param('slotId', ParseUUIDPipe) slotId: string, @CurrentUser() user: SessionUser) {
    return this.adminScheduleService.getSlotCancellations(user.id, slotId);
  }

  @Get('calendar')
  getCalendar(@Query('month', ParseMonthPipe) month: string, @CurrentUser() user: SessionUser) {
    return this.adminScheduleService.getCalendar(user.id, month);
  }

  @Put('training-days/:date')
  @HttpCode(HttpStatus.OK)
  upsertTrainingDay(
    @Param('date', ParseDatePipe) date: string,
    @Body() dto: UpsertTrainingDayDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.adminSlotsService.upsertTrainingDay(user.id, date, dto);
  }

  // Group slots only; assigned slots use POST training-days/:date/assigned-slots
  @Put('training-days/:date/slots/:slotTime')
  @HttpCode(HttpStatus.OK)
  upsertCalendarSlot(
    @Param('date', ParseDatePipe) date: string,
    @Param('slotTime', ParseTimePipe) slotTime: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.adminSlotsService.upsertGroupSlot(user.id, date, slotTime);
  }

  @Post('training-days/:date/assigned-slots')
  createAssignedSlot(
    @Param('date', ParseDatePipe) date: string,
    @Body() dto: CreateAssignedSlotDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.adminSlotsService.createAssignedSlot(user.id, date, dto);
  }

  @Put('slots/:slotId/members')
  @HttpCode(HttpStatus.OK)
  updateSlotMembers(
    @Param('slotId', ParseUUIDPipe) slotId: string,
    @Body() dto: SlotMembersDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.adminSlotsService.updateSlotMembers(user.id, slotId, dto.memberIds);
  }

  @Patch('slots/:slotId')
  @HttpCode(HttpStatus.OK)
  updateSlot(
    @Param('slotId', ParseUUIDPipe) slotId: string,
    @Body() dto: UpdateSlotDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.adminSlotsService.updateSlot(user.id, slotId, dto);
  }
}
