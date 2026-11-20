import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator.js';

/**
 * Global authentication guard: secure by default.
 *
 * Every route requires authentication unless it is marked @Public(). Sign-in arrives in
 * milestone 04; until then no request can authenticate, so non-public routes return 401.
 * Milestone 04 replaces `authenticate` with real token verification. Nothing here pretends
 * a user is signed in.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return this.authenticate();
  }

  private authenticate(): boolean {
    throw new UnauthorizedException('Authentication required');
  }
}
