import { Controller, Get, Post, Body, Headers, HttpCode, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { SessionGuard, SessionUser } from '../auth/session.guard';
import { MemberGuard } from '../common/guards/member.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreateCheckoutDto } from './dto/create-checkout.dto';

@Controller('payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('checkout')
  @UseGuards(SessionGuard, MemberGuard)
  @HttpCode(200)
  createCheckout(@Body() dto: CreateCheckoutDto, @CurrentUser() user: SessionUser) {
    return this.paymentService.checkoutPurchase(dto.purchaseId, user.id);
  }

  @Get('status')
  @UseGuards(SessionGuard, MemberGuard)
  getStatus(@Query('order') orderId: string, @CurrentUser() user: SessionUser) {
    if (!orderId) throw new BadRequestException('order is required');
    return this.paymentService.getStatus(orderId, user.id);
  }

  @Post('liqpay/callback')
  @HttpCode(200)
  async liqpayCallback(
    @Headers('content-type') _ct: string,
    @Body('data') data: string,
    @Body('signature') signature: string,
  ) {
    return this.paymentService.handleCallback(data, signature);
  }
}
