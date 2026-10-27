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
import { CreateAssignedSlotDto } from './dto/create-assigned-slot.dto';
import { SlotMembersDto } from './dto/update-slot-members.dto';

@Controller('admin')
@UseGuards(SessionGuard, AdminGuard)
export class AdminScheduleController {
  constructor(private readonly adminScheduleService: AdminScheduleService) {}

  @Get('schedule')
  getSchedule(@CurrentUser() user: SessionUser) {
    return this.adminScheduleService.getSchedule(user.id);
  }

  @Get('history')
  getHistory(@CurrentUser() user: SessionUser, @Query('before') before?: string) {
    return this.adminScheduleService.getHistory(
      user.id,
      before && /^\d{4}-\d{2}-\d{2}$/.test(before) ? before : undefined,
    );
  }

  @Get('slots/:slotId/cancellations')
  getSlotCancellations(@Param('slotId', ParseUUIDPipe) slotId: string, @CurrentUser() user: SessionUser) {
    return this.adminScheduleService.getSlotCancellations(user.id, slotId);
  }

  @Get('calendar')
  getCalendar(@Query('month') month: string, @CurrentUser() user: SessionUser) {
    return this.adminScheduleService.getCalendar(user.id, month);
  }

  @Put('training-days/:date')
  @HttpCode(HttpStatus.OK)
  upsertTrainingDay(@Param('date') date: string, @Body() dto: UpsertTrainingDayDto, @CurrentUser() user: SessionUser) {
    return this.adminScheduleService.upsertTrainingDay(user.id, date, dto);
  }

  // Group slot at any time 06:00–21:00. Assigned slots: POST training-days/:date/assigned-slots
  @Put('training-days/:date/slots/:slotTime')
  @HttpCode(HttpStatus.OK)
  upsertCalendarSlot(
    @Param('date') date: string,
    @Param('slotTime') slotTime: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.adminScheduleService.upsertGroupSlot(user.id, date, slotTime);
  }

  @Post('training-days/:date/assigned-slots')
  createAssignedSlot(
    @Param('date') date: string,
    @Body() dto: CreateAssignedSlotDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.adminScheduleService.createAssignedSlot(user.id, date, dto);
  }

  @Put('slots/:slotId/members')
  @HttpCode(HttpStatus.OK)
  updateSlotMembers(
    @Param('slotId', ParseUUIDPipe) slotId: string,
    @Body() dto: SlotMembersDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.adminScheduleService.updateSlotMembers(user.id, slotId, dto.memberIds);
  }

  @Patch('slots/:slotId')
  @HttpCode(HttpStatus.OK)
  updateSlot(
    @Param('slotId', ParseUUIDPipe) slotId: string,
    @Body() dto: UpdateSlotDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.adminScheduleService.updateSlot(user.id, slotId, dto);
  }
}
