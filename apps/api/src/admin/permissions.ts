import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type AdminPermission, hasPermission } from '@voyago/shared';
import { type AuthUser, type RequestWithUser } from '../common/auth/current-user.decorator.js';

const PERMISSION_KEY = 'admin:permission';

/** The permission an admin route needs. Every route behind PermissionGuard must declare one. */
export const RequirePermission = (permission: AdminPermission) =>
  SetMetadata(PERMISSION_KEY, permission);

/**
 * Backend role-based access control for /admin routes. Runs after the global AuthGuard, which
 * loads the member's current role on every request, so a role change applies immediately.
 * A route without @RequirePermission is refused (fail closed).
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const permission = this.reflector.getAllAndOverride<AdminPermission | undefined>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    const user = context.switchToHttp().getRequest<RequestWithUser>().user;
    if (!user) throw new UnauthorizedException('Authentication required');
    if (!permission || !hasPermission(user.role, permission)) {
      throw new ForbiddenException('Your role does not allow this');
    }
    return true;
  }
}

/** Who is acting, for the audit log. */
export interface Actor {
  user: AuthUser;
  requestId: string | null;
}

/** `@CurrentActor() actor: Actor`: the signed-in staff member and the request id. */
export const CurrentActor = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<RequestWithUser & { id?: unknown }>();
  if (!request.user) throw new UnauthorizedException('Authentication required');
  return {
    user: request.user,
    requestId: typeof request.id === 'string' ? request.id : null,
  } satisfies Actor;
});
