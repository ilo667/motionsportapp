import { Controller, Post, Delete, Patch, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { BookingService } from './booking.service';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.guard';
import { CreateBookingDto } from './dto/create-booking.dto';
import { CancelBookingDto } from './dto/cancel-booking.dto';
import { SwitchBookingDto } from './dto/switch-booking.dto';
import { AddGuestDto } from './dto/add-guest.dto';

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

  // A free guest on the member's group booking (one per booking)
  @Post('guest')
  @HttpCode(HttpStatus.OK)
  async addGuest(@CurrentUser() user: SessionUser, @Body() dto: AddGuestDto) {
    if (user.type !== 'member') throw new Error('Members only');
    return this.bookingService.addGuest(user.id, dto.slotId, dto.name);
  }

  @Delete('guest')
  @HttpCode(HttpStatus.OK)
  async removeGuest(@CurrentUser() user: SessionUser, @Body() dto: CreateBookingDto) {
    if (user.type !== 'member') throw new Error('Members only');
    return this.bookingService.removeGuest(user.id, dto.slotId);
  }
}
