import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { SessionUser } from '../../auth/session.guard';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const user = ctx.switchToHttp().getRequest<{ user?: SessionUser }>().user;
    if (!user || user.type !== 'admin') throw new ForbiddenException();
    return true;
  }
}