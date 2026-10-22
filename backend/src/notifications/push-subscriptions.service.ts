import { Injectable } from '@nestjs/common';
import { eq, and, or, isNull, inArray } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { pushSubscriptions, adminPushSubscriptions, members } from '../database/schema';

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

  // Members whose coach is one of these (and members without a coach, when asked)
  async findForCoaches(coachIds: string[], includeUnassigned: boolean) {
    const ofCoaches = coachIds.length > 0 ? inArray(members.coachId, coachIds) : undefined;
    const unassigned = includeUnassigned ? isNull(members.coachId) : undefined;
    const who = ofCoaches && unassigned ? or(ofCoaches, unassigned) : (ofCoaches ?? unassigned);
    if (!who) return [];
    return this.database.db
      .select({ endpoint: pushSubscriptions.endpoint, p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth })
      .from(pushSubscriptions)
      .innerJoin(members, eq(members.id, pushSubscriptions.memberId))
      .where(and(isNull(pushSubscriptions.disabledAt), who));
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

  // Coach's devices live in their own table, so member-wide sends (BOOKING_OPEN) never reach them
  async upsertAdmin(adminId: string, endpoint: string, p256dh: string, auth: string) {
    await this.database.db
      .insert(adminPushSubscriptions)
      .values({ adminId, endpoint, p256dh, auth })
      .onConflictDoUpdate({
        target: adminPushSubscriptions.endpoint,
        set: { adminId, p256dh, auth, disabledAt: null },
      });
  }

  async removeAdmin(adminId: string, endpoint: string) {
    await this.database.db
      .update(adminPushSubscriptions)
      .set({ disabledAt: new Date() })
      .where(and(eq(adminPushSubscriptions.adminId, adminId), eq(adminPushSubscriptions.endpoint, endpoint)));
  }

  async findAllAdmin() {
    return this.database.db
      .select()
      .from(adminPushSubscriptions)
      .where(isNull(adminPushSubscriptions.disabledAt));
  }

  async findAdminByAdminId(adminId: string) {
    return this.database.db
      .select()
      .from(adminPushSubscriptions)
      .where(and(eq(adminPushSubscriptions.adminId, adminId), isNull(adminPushSubscriptions.disabledAt)));
  }

  async disableAdminByEndpoint(endpoint: string) {
    await this.database.db
      .update(adminPushSubscriptions)
      .set({ disabledAt: new Date() })
      .where(eq(adminPushSubscriptions.endpoint, endpoint));
  }
}