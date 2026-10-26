import { Module } from '@nestjs/common';
import { FreezesController } from './freezes.controller';
import { AdminFreezesController } from './admin-freezes.controller';
import { FreezesService } from './freezes.service';
import { AuthModule } from '../auth/auth.module';
import { EntitlementsModule } from '../purchases/entitlements.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [AuthModule, EntitlementsModule, NotificationsModule],
  controllers: [FreezesController, AdminFreezesController],
  providers: [FreezesService],
  exports: [FreezesService],
})
export class FreezesModule {}
