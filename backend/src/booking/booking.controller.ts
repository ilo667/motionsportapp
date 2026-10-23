import { Controller, Post, Delete, Patch, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { BookingService } from './booking.service';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.guard';
import { CreateBookingDto } from './dto/create-booking.dto';
import { CancelBookingDto } from './dto/cancel-booking.dto';
import { SwitchBookingDto } from './dto/switch-booking.dto';

@Controller('bookings')
@UseGuards(SessionGuard)
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @Post()
  async book(@CurrentUser() user: SessionUser, @Body() dto: CreateBookingDto) {
    if (user.type !== 'member') throw new Error('Members only');
    return this.bookingService.book(user.id, dto.slotId);
  }

  @Delete('current')
  @HttpCode(HttpStatus.OK)
  async cancelCurrent(@CurrentUser() user: SessionUser, @Body() dto: CancelBookingDto) {
    if (user.type !== 'member') throw new Error('Members only');
    return this.bookingService.cancel(user.id, dto.slotId, dto.reason);
  }

  @Patch('current')
  @HttpCode(HttpStatus.OK)
  async switchSlot(@CurrentUser() user: SessionUser, @Body() dto: SwitchBookingDto) {
    if (user.type !== 'member') throw new Error('Members only');
    return this.bookingService.switchSlot(user.id, dto.newSlotId, dto.reason);
  }
}
