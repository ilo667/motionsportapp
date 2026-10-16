import {
  Injectable,
  UnauthorizedException,
  InternalServerErrorException,
  ConflictException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { eq, and, isNull, gt, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { members, admins, sessions } from '../database/schema';
import type { RegisterMemberDto } from './dto/register-member.dto';
import type { LoginMemberDto } from './dto/login-member.dto';
import type { RecoverMemberDto } from './dto/recover-member.dto';
import type { LoginAdminDto } from './dto/login-admin.dto';
import type { SetupAdminDto } from './dto/setup-admin.dto';

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(private readonly database: DatabaseService) {}

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

    if (!member || member.disabledAt) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.pin, member.pinHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    const sessionToken = await this.createSession('member', member.id);
    return { memberCode: member.memberCode, displayName: member.displayName, sessionToken };
  }

  async recoverMember(dto: RecoverMemberDto) {
    const [member] = await this.database.db
      .select()
      .from(members)
      .where(eq(members.memberCode, dto.memberCode))
      .limit(1);

    if (!member || member.disabledAt) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.recoveryCode, member.recoveryHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

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

  async setupAdmin(dto: SetupAdminDto) {
    const [{ count }] = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(admins);

    if (count > 0) throw new ConflictException('Admin account already exists');

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const [admin] = await this.database.db
      .insert(admins)
      .values({ username: dto.username, passwordHash })
      .returning();

    const sessionToken = await this.createSession('admin', admin.id);
    return { username: admin.username, sessionToken };
  }

  async loginAdmin(dto: LoginAdminDto) {
    const [admin] = await this.database.db
      .select()
      .from(admins)
      .where(eq(admins.username, dto.username))
      .limit(1);

    if (!admin) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, admin.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    const sessionToken = await this.createSession('admin', admin.id);
    return { username: admin.username, sessionToken };
  }

  async revokeSession(sessionId: string) {
    await this.database.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.id, sessionId));
  }

  async validateSessionToken(rawToken: string) {
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const [session] = await this.database.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
        ),
      )
      .limit(1);

    return session ?? null;
  }

  private async generateUniqueMemberCode(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const digits = Math.floor(10000 + Math.random() * 90000);
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
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

    await this.database.db.insert(sessions).values({ principalType, principalId, tokenHash, expiresAt });
    return rawToken;
  }
}