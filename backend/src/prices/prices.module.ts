import { Module } from '@nestjs/common';
import { PricesController, PublicPricesController } from './prices.controller';
import { PricesService } from './prices.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [PricesController, PublicPricesController],
  providers: [PricesService],
})
export class PricesModule {}
