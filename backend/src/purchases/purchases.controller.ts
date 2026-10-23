import { Controller, Get, Post, Body, Param, UseGuards, HttpCode, ParseUUIDPipe } from '@nestjs/common';
import { PurchasesService } from './purchases.service';
import { SessionGuard, SessionUser } from '../auth/session.guard';
import { MemberGuard } from '../common/guards/member.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreatePurchaseDto } from './dto/create-purchase.dto';

// A member's own purchases: club cards and trainer packages
@Controller('purchases')
@UseGuards(SessionGuard, MemberGuard)
export class PurchasesController {
  constructor(private readonly purchasesService: PurchasesService) {}

  @Get()
  getMine(@CurrentUser() user: SessionUser) {
    return this.purchasesService.getForMember(user.id);
  }

  @Post()
  create(@Body() dto: CreatePurchaseDto, @CurrentUser() user: SessionUser) {
    return this.purchasesService.create(user.id, dto);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.purchasesService.cancel(user.id, id);
  }
}
