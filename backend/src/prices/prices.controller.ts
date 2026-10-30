import { Controller, Get, Patch, Body, Param, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { PricesService } from './prices.service';
import { SessionGuard, SessionUser } from '../auth/session.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { MemberGuard } from '../common/guards/member.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UpdatePriceDto } from './dto/update-price.dto';

@Controller('admin/prices')
@UseGuards(SessionGuard, AdminGuard)
export class PricesController {
  constructor(private readonly pricesService: PricesService) {}

  @Get()
  getPrices() {
    return this.pricesService.getPrices();
  }

  @Patch(':id')
  updatePrice(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePriceDto, @CurrentUser() user: SessionUser) {
    return this.pricesService.updatePrice(user.id, id, dto);
  }
}

// Member view: amounts only
@Controller('prices')
@UseGuards(SessionGuard, MemberGuard)
export class MemberPricesController {
  constructor(private readonly pricesService: PricesService) {}

  @Get()
  getPrices() {
    return this.pricesService.getMemberPrices();
  }
}
