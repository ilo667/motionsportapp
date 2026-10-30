import { Module } from '@nestjs/common';
import { EntitlementsService } from './entitlements.service';

// Own module to avoid a cycle: payments, purchases, admin, schedule and crons all use it
@Module({
  providers: [EntitlementsService],
  exports: [EntitlementsService],
})
export class EntitlementsModule {}
