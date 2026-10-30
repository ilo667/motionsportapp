import {
  Injectable,
  UnauthorizedException,
  InternalServerErrorException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { eq, and, isNull, gt, ne } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { ClockService } from '../clock/clock.service';
import { members, admins, sessions, trainerInvites } from '../database/schema';
import { newToken, hashToken } from './token';
import { deleteDeadSessions } from './dead-sessions';
import type { RegisterMemberDto } from './dto/register-member.dto';
import type { LoginMemberDto } from './dto/login-member.dto';
import type { RecoverMemberDto } from './dto/recover-member.dto';
import type { LoginAdminDto } from './dto/login-admin.dto';
import type { RegisterAdminDto } from './dto/register-admin.dto';
import type { ChangePasswordDto } from './dto/change-password.dto';

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const BCRYPT_ROUNDS = 12;
// Same bcrypt cost as real hashes: an unknown code or username takes as long, so timing leaks nothing
const DUMMY_HASH = '$2b$12$t.Mnp58vbb/O.oSG0aHVEuyog3GrnDk1woQu4pJdSwJ0TDWhl7DkO';

export async function secretMatches(secret: string, hash: string | undefined): Promise<boolean> {
  const valid = await bcrypt.compare(secret, hash ?? DUMMY_HASH);
  return valid && hash !== undefined;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly clock: ClockService,
  ) {}

  async registerMember(dto: RegisterMemberDto) {
    const pinHash = await bcrypt.hash(dto.pin, BCRYPT_ROUNDS);
    const rawRecoveryCode = crypto.randomBytes(20).toString('base64url');
    const recoveryHash = await bcrypt.hash(rawRecoveryCode, BCRYPT_ROUNDS);
    const memberCode = await this.generateUniqueMemberCode();

    const [member] = await this.database.db
      .insert(members)
      .values({ memberCode, displayName: dto.displayName, pinHash, recoveryHash })
      .returning();

    const sessionToken = await this.createSession('member', member.id);
    return { memberCode, recoveryCode: rawRecoveryCode, sessionToken };
  }

  async loginMember(dto: LoginMemberDto) {
    const [member] = await this.database.db
      .select()
      .from(members)
      .where(eq(members.memberCode, dto.memberCode))
      .limit(1);

    const valid = await secretMatches(dto.pin, member?.pinHash);
    if (!member || member.disabledAt || !valid) throw new UnauthorizedException('Invalid credentials');

    const sessionToken = await this.createSession('member', member.id);
    return { memberCode: member.memberCode, displayName: member.displayName, sessionToken };
  }

  async recoverMember(dto: RecoverMemberDto) {
    const [member] = await this.database.db
      .select()
      .from(members)
      .where(eq(members.memberCode, dto.memberCode))
      .limit(1);

    const valid = await secretMatches(dto.recoveryCode, member?.recoveryHash);
    if (!member || member.disabledAt || !valid) throw new UnauthorizedException('Invalid credentials');

    const newPinHash = await bcrypt.hash(dto.newPin, BCRYPT_ROUNDS);
    const newRawRecovery = crypto.randomBytes(20).toString('base64url');
    const newRecoveryHash = await bcrypt.hash(newRawRecovery, BCRYPT_ROUNDS);

    await this.database.db
      .update(members)
      .set({ pinHash: newPinHash, recoveryHash: newRecoveryHash })
      .where(eq(members.id, member.id));

    await this.database.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.principalId, member.id), isNull(sessions.revokedAt)));

    const sessionToken = await this.createSession('member', member.id);
    return { memberCode: member.memberCode, recoveryCode: newRawRecovery, sessionToken };
  }

  async loginAdmin(dto: LoginAdminDto) {
    const [admin] = await this.database.db.select().from(admins).where(eq(admins.username, dto.username)).limit(1);

    // A disabled trainer gets the same answer as a wrong password
    const valid = await secretMatches(dto.password, admin?.passwordHash);
    if (!admin || admin.disabledAt || !valid) throw new UnauthorizedException('Invalid credentials');

    const sessionToken = await this.createSession('admin', admin.id);
    return { username: admin.username, sessionToken };
  }

  // Lets the invite page show a message for a dead link instead of a form
  async checkInvite(rawToken: string) {
    const [invite] = await this.database.db
      .select({ id: trainerInvites.id })
      .from(trainerInvites)
      .where(this.liveInvite(rawToken))
      .limit(1);
    return { valid: !!invite };
  }

  // Invite taken compare-and-set: one link, one trainer. A taken username rolls back, the link stays usable
  async registerAdmin(dto: RegisterAdminDto) {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const now = this.clock.now().toJSDate();

    const admin = await this.database.db.transaction(async (tx) => {
      const [invite] = await tx
        .update(trainerInvites)
        .set({ usedAt: now })
        .where(this.liveInvite(dto.token))
        .returning({ id: trainerInvites.id, createdByAdminId: trainerInvites.createdByAdminId });
      if (!invite) throw new BadRequestException('Invalid invite');

      // Checked before the insert: a unique violation would abort the transaction with a 500
      const [taken] = await tx.select({ id: admins.id }).from(admins).where(eq(admins.username, dto.username)).limit(1);
      if (taken) throw new ConflictException('Username taken');

      const [created] = await tx
        .insert(admins)
        .values({ username: dto.username, passwordHash, invitedByAdminId: invite.createdByAdminId })
        .returning({ id: admins.id, username: admins.username });
      await tx.update(trainerInvites).set({ usedByAdminId: created.id }).where(eq(trainerInvites.id, invite.id));
      return created;
    });

    const sessionToken = await this.createSession('admin', admin.id);
    return { username: admin.username, sessionToken };
  }

  // Revokes the trainer's other sessions
  async changeAdminPassword(adminId: string, sessionId: string, dto: ChangePasswordDto) {
    const [admin] = await this.database.db
      .select({ passwordHash: admins.passwordHash })
      .from(admins)
      .where(eq(admins.id, adminId))
      .limit(1);
    if (!admin || !(await bcrypt.compare(dto.currentPassword, admin.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    await this.database.db.update(admins).set({ passwordHash }).where(eq(admins.id, adminId));
    await this.database.db
      .update(sessions)
      .set({ revokedAt: this.clock.now().toJSDate() })
      .where(
        and(
          eq(sessions.principalType, 'admin'),
          eq(sessions.principalId, adminId),
          ne(sessions.id, sessionId),
          isNull(sessions.revokedAt),
        ),
      );
    return { ok: true };
  }

  async revokeSession(sessionId: string) {
    await this.database.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
  }

  async validateSessionToken(rawToken: string) {
    const tokenHash = hashToken(rawToken);

    const [session] = await this.database.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
      .limit(1);

    return session ?? null;
  }

  private async generateUniqueMemberCode(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const digits = crypto.randomInt(10000, 100000);
      const code = `GYM-${digits}`;
      const [existing] = await this.database.db
        .select({ id: members.id })
        .from(members)
        .where(eq(members.memberCode, code))
        .limit(1);
      if (!existing) return code;
    }
    throw new InternalServerErrorException('Failed to generate unique member code');
  }

  private async createSession(principalType: 'member' | 'admin', principalId: string) {
    const rawToken = newToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

    await this.database.db.insert(sessions).values({ principalType, principalId, tokenHash, expiresAt });
    // Housekeeping must not fail the sign-in; the next one retries
    await deleteDeadSessions(this.database.db, new Date()).catch((err: unknown) =>
      this.logger.warn(`Deleting dead sessions failed: ${String(err)}`),
    );
    return rawToken;
  }

  private liveInvite(rawToken: string) {
    return and(
      eq(trainerInvites.tokenHash, hashToken(rawToken)),
      isNull(trainerInvites.usedAt),
      isNull(trainerInvites.revokedAt),
      gt(trainerInvites.expiresAt, this.clock.now().toJSDate()),
    );
  }
}
