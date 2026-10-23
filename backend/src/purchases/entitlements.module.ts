import { Module } from '@nestjs/common';
import { EntitlementsService } from './entitlements.service';

// Its own module so payments, purchases, the admin, the schedule and the crons can all use it without a cycle
@Module({
  providers: [EntitlementsService],
  exports: [EntitlementsService],
})
export class EntitlementsModule {}
