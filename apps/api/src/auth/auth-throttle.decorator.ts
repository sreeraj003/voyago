import { type ExecutionContext } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

/** Express app setting holding AUTH_RATE_LIMIT_MAX (set in bootstrap). */
export const AUTH_RATE_LIMIT_SETTING = 'voyago.authRateLimit';

/**
 * Stricter per-IP limit for sign-in, OTP and recovery routes: AUTH_RATE_LIMIT_MAX requests per
 * minute for each route. Per-account and per-phone limits are enforced in the services.
 */
export const AuthThrottle = () =>
  Throttle({
    default: {
      ttl: 60_000,
      limit: (context: ExecutionContext) =>
        Number(
          context
            .switchToHttp()
            .getRequest<{ app: { get(name: string): unknown } }>()
            .app.get(AUTH_RATE_LIMIT_SETTING) ?? 10,
        ),
    },
  });
