import { Controller, Get, Post, Body, Param, UseGuards, HttpCode, ParseUUIDPipe } from '@nestjs/common';
import { PurchasesService } from './purchases.service';
import { SessionGuard, SessionUser } from '../auth/session.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AddClubCardDto } from './dto/add-club-card.dto';

// Trainer side of purchases: cash requests of own clients, a client's cards and packages
@Controller('admin')
@UseGuards(SessionGuard, AdminGuard)
export class AdminPurchasesController {
  constructor(private readonly purchasesService: PurchasesService) {}

  @Get('purchases/pending')
  pendingCash(@CurrentUser() user: SessionUser) {
    return this.purchasesService.pendingCash(user.id);
  }

  @Post('purchases/:id/confirm')
  @HttpCode(200)
  confirm(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.purchasesService.confirmCash(user.id, id);
  }

  @Post('purchases/:id/reject')
  @HttpCode(200)
  reject(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.purchasesService.rejectCash(user.id, id);
  }

  @Get('members/:memberId/purchases')
  memberPurchases(@Param('memberId', ParseUUIDPipe) memberId: string, @CurrentUser() user: SessionUser) {
    return this.purchasesService.memberPurchases(user.id, memberId);
  }

  @Post('members/:memberId/club-card')
  @HttpCode(200)
  addCard(
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: AddClubCardDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.purchasesService.addCard(user.id, memberId, dto.priceItemId, dto.activate ?? false);
  }

  @Post('members/:memberId/club-cards/:cardId/activate')
  @HttpCode(200)
  activateCard(
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Param('cardId', ParseUUIDPipe) cardId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.purchasesService.activateCard(user.id, memberId, cardId);
  }
}
