import { Controller, Post, Body, Headers, HttpCode, UseGuards } from '@nestjs/common';
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
  createCheckout(
    @Body() dto: CreateCheckoutDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.paymentService.createCheckout(dto.slotId, user.id);
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
