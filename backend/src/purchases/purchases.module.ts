import { Module } from '@nestjs/common';
import { PurchasesController } from './purchases.controller';
import { AdminPurchasesController } from './admin-purchases.controller';
import { PurchasesService } from './purchases.service';
import { EntitlementsModule } from './entitlements.module';
import { AuthModule } from '../auth/auth.module';
import { PaymentModule } from '../payment/payment.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [AuthModule, EntitlementsModule, PaymentModule, NotificationsModule],
  controllers: [PurchasesController, AdminPurchasesController],
  providers: [PurchasesService],
  exports: [PurchasesService],
})
export class PurchasesModule {}
