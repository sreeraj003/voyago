import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SessionService } from '../../auth/session.service.js';
import { AnalyticsService } from '../../observability/analytics.service.js';
import { TokenService } from '../../auth/token.service.js';
import { type RequestWithUser } from './current-user.decorator.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

/**
 * Global authentication guard: secure by default.
 *
 * Every route requires a valid `Authorization: Bearer <access token>` unless marked @Public().
 * Besides the token signature and expiry, the session family must still be signed in (not
 * logged out or revoked) and the account must be active, so logout and suspension take effect
 * immediately rather than when the access token expires.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly analytics: AnalyticsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = readBearer(request.headers.authorization);
    if (!token) throw new UnauthorizedException('Authentication required');

    const claims = await this.tokens.verifyAccessToken(token);
    const user = await this.sessions.findActiveUser(claims.userId, claims.sessionFamilyId);
    if (!user || user.status !== 'ACTIVE' || user.deletedAt) {
      throw new UnauthorizedException('Session ended. Sign in again.');
    }
    request.user = { id: user.id, role: user.role, sessionFamilyId: claims.sessionFamilyId };
    // Once a day per member: last active time and the `user_active` event. Never blocks.
    void this.analytics.active(user.id);
    return true;
  }
}

function readBearer(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9_\-.]+)$/.exec(header.trim());
  return match?.[1] ?? null;
}
