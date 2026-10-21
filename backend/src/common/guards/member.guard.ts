import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { SessionUser } from '../../auth/session.guard';

@Injectable()
export class MemberGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const user: SessionUser | undefined = ctx.switchToHttp().getRequest().user;
    if (!user || user.type !== 'member') throw new ForbiddenException();
    return true;
  }
}
