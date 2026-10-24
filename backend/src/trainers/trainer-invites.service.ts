import { Injectable, ConflictException } from '@nestjs/common';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { ClockService } from '../clock/clock.service';
import { admins, trainerInvites } from '../database/schema';
import { newToken, hashToken } from '../auth/token';

export const INVITE_DAYS = 7;

// «Запросити тренера»: any signed-in trainer makes a one-time link; the new trainer signs up through
// POST /auth/admin/register (AuthService.registerAdmin)
@Injectable()
export class TrainerInvitesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clock: ClockService,
  ) {}

  // The raw token leaves the server only here; the DB keeps its hash
  async create(adminId: string) {
    const token = newToken();
    const expiresAt = this.clock.now().plus({ days: INVITE_DAYS }).toJSDate();
    const [invite] = await this.database.db
      .insert(trainerInvites)
      .values({ tokenHash: hashToken(token), createdByAdminId: adminId, expiresAt })
      .returning({ id: trainerInvites.id });
    return { id: invite.id, token, expiresAt };
  }

  // Invites still waiting to be used, from every trainer
  async listActive() {
    return this.database.db
      .select({
        id: trainerInvites.id,
        createdBy: admins.username,
        createdAt: trainerInvites.createdAt,
        expiresAt: trainerInvites.expiresAt,
      })
      .from(trainerInvites)
      .innerJoin(admins, eq(admins.id, trainerInvites.createdByAdminId))
      .where(
        and(
          isNull(trainerInvites.usedAt),
          isNull(trainerInvites.revokedAt),
          gt(trainerInvites.expiresAt, this.clock.now().toJSDate()),
        ),
      )
      .orderBy(asc(trainerInvites.createdAt));
  }

  // Any trainer may revoke any invite; compare-and-set, so a used or already revoked one answers 409
  async revoke(inviteId: string) {
    const [revoked] = await this.database.db
      .update(trainerInvites)
      .set({ revokedAt: this.clock.now().toJSDate() })
      .where(and(eq(trainerInvites.id, inviteId), isNull(trainerInvites.usedAt), isNull(trainerInvites.revokedAt)))
      .returning({ id: trainerInvites.id });
    if (!revoked) throw new ConflictException('Invite already used or revoked');
    return { ok: true };
  }
}
