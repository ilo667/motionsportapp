import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { members, admins } from '../database/schema';
import { AuthService } from './auth.service';

export type SessionUser =
  | { type: 'member'; sessionId: string; id: string; memberCode: string; displayName: string }
  | { type: 'admin'; sessionId: string; id: string; username: string };

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly database: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ cookies?: Record<string, string>; user?: SessionUser }>();
    const rawToken = req.cookies?.['session'];
    if (!rawToken) throw new UnauthorizedException();

    const session = await this.authService.validateSessionToken(rawToken);
    if (!session) throw new UnauthorizedException();

    if (session.principalType === 'member') {
      const [member] = await this.database.db
        .select()
        .from(members)
        .where(eq(members.id, session.principalId))
        .limit(1);

      if (!member || member.disabledAt) throw new UnauthorizedException();

      req.user = {
        type: 'member',
        sessionId: session.id,
        id: member.id,
        memberCode: member.memberCode,
        displayName: member.displayName,
      };
    } else if (session.principalType === 'admin') {
      const [admin] = await this.database.db
        .select()
        .from(admins)
        .where(eq(admins.id, session.principalId))
        .limit(1);

      if (!admin) throw new UnauthorizedException();

      req.user = { type: 'admin', sessionId: session.id, id: admin.id, username: admin.username };
    } else {
      throw new UnauthorizedException();
    }

    return true;
  }
}