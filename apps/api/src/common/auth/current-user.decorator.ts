import { type UserRole } from '@voyago/shared';
import { createParamDecorator, type ExecutionContext, UnauthorizedException } from '@nestjs/common';

/** The signed-in member, attached to the request by AuthGuard. */
export interface AuthUser {
  id: string;
  role: UserRole;
  sessionFamilyId: string;
}

export interface RequestWithUser {
  user?: AuthUser;
  headers: Record<string, string | string[] | undefined>;
}

/** `@CurrentUser() user: AuthUser` in a handler of a non-public route. */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const user = context.switchToHttp().getRequest<RequestWithUser>().user;
  if (!user) throw new UnauthorizedException('Authentication required');
  return user;
});
