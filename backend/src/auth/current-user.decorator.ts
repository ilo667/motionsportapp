import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { SessionUser } from './session.guard';

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): SessionUser => {
  return ctx.switchToHttp().getRequest<{ user: SessionUser }>().user;
});
