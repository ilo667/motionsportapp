import { Injectable } from '@nestjs/common';
import { eq, and, isNull, inArray } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { pushSubscriptions } from '../database/schema';

@Injectable()
export class PushSubscriptionsService {
  constructor(private readonly database: DatabaseService) {}

  async upsert(memberId: string, endpoint: string, p256dh: string, auth: string) {
    await this.database.db
      .insert(pushSubscriptions)
      .values({ memberId, endpoint, p256dh, auth })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { memberId, p256dh, auth, disabledAt: null },
      });
  }

  async remove(memberId: string, endpoint: string) {
    await this.database.db
      .update(pushSubscriptions)
      .set({ disabledAt: new Date() })
      .where(
        and(
          eq(pushSubscriptions.memberId, memberId),
          eq(pushSubscriptions.endpoint, endpoint),
        ),
      );
  }

  async findAll() {
    return this.database.db
      .select()
      .from(pushSubscriptions)
      .where(isNull(pushSubscriptions.disabledAt));
  }

  async findActiveByMemberIds(memberIds: string[]) {
    if (memberIds.length === 0) return [];
    return this.database.db
      .select()
      .from(pushSubscriptions)
      .where(
        and(
          inArray(pushSubscriptions.memberId, memberIds),
          isNull(pushSubscriptions.disabledAt),
        ),
      );
  }

  async disableByEndpoint(endpoint: string) {
    await this.database.db
      .update(pushSubscriptions)
      .set({ disabledAt: new Date() })
      .where(eq(pushSubscriptions.endpoint, endpoint));
  }
}