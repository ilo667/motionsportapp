import {
  Controller,
  Put,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { AdminAttendanceService } from './admin-attendance.service';
import { SessionGuard, SessionUser } from '../auth/session.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UpdateAttendanceDto } from './dto/update-attendance.dto';

@Controller('admin')
@UseGuards(SessionGuard, AdminGuard)
export class AdminAttendanceController {
  constructor(private readonly adminAttendanceService: AdminAttendanceService) {}

  @Put('slots/:slotId/attendance/all')
  @HttpCode(HttpStatus.OK)
  markAllAttendance(@Param('slotId') slotId: string, @CurrentUser() user: SessionUser) {
    return this.adminAttendanceService.markAllAttendance(slotId, user.id);
  }

  @Patch('bookings/:bookingId/attendance')
  @HttpCode(HttpStatus.OK)
  updateBookingAttendance(
    @Param('bookingId') bookingId: string,
    @Body() dto: UpdateAttendanceDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.adminAttendanceService.updateBookingAttendance(bookingId, dto, user.id);
  }

  // A guest a member brought to a group training: ✓ / ✗ for the count, nothing is spent
  @Patch('guests/:guestId/attendance')
  @HttpCode(HttpStatus.OK)
  updateGuestAttendance(
    @Param('guestId', ParseUUIDPipe) guestId: string,
    @Body() dto: UpdateAttendanceDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.adminAttendanceService.updateGuestAttendance(guestId, dto, user.id);
  }

  // «Не списувати» on a late cancellation
  @Post('bookings/:bookingId/waive-fee')
  @HttpCode(HttpStatus.OK)
  waiveCancelFee(@Param('bookingId', ParseUUIDPipe) bookingId: string, @CurrentUser() user: SessionUser) {
    return this.adminAttendanceService.waiveCancelFee(bookingId, user.id);
  }
}
