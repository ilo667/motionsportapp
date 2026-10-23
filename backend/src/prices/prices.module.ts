import { Module } from '@nestjs/common';
import { PricesController, MemberPricesController } from './prices.controller';
import { PricesService } from './prices.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [PricesController, MemberPricesController],
  providers: [PricesService],
})
export class PricesModule {}
