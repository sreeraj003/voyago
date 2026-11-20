import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

/**
 * Every environment variable the API reads. The app refuses to start when
 * a required value is missing or malformed, so misconfiguration fails fast.
 */
export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    CORS_ORIGINS: csv,
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine(
        (value) => /^postgres(ql)?:\/\//.test(value),
        'DATABASE_URL must be a postgres:// URL',
      ),
    REDIS_URL: z
      .string()
      .min(1, 'REDIS_URL is required')
      .refine(
        (value) => /^rediss?:\/\//.test(value),
        'REDIS_URL must be a redis:// or rediss:// URL',
      ),
    /** Set to true when running behind a load balancer so rate limits see the real client IP. */
    TRUST_PROXY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    RATE_LIMIT_TTL_SECONDS: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),

    // ── Authentication (milestone 04) ──────────────────────────────────────────
    /** HMAC key for access tokens. At least 32 characters; generate with `openssl rand -base64 48`. */
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    /** HMAC key for OTP codes and one-time tokens. Different from JWT_ACCESS_SECRET. */
    OTP_HMAC_SECRET: z.string().min(32, 'OTP_HMAC_SECRET must be at least 32 characters'),
    /**
     * `none`: phone sign-in is disabled (503). `dev`: codes are logged and kept in memory for
     * tests; refused in production. A real SMS provider adapter is added when credentials exist.
     */
    SMS_PROVIDER: z.enum(['none', 'dev']).default('none'),
    /** `none`: no email is sent (verification and reset return 503). `dev`: as for SMS. */
    EMAIL_PROVIDER: z.enum(['none', 'dev']).default('none'),
    /** Base URL used in links inside emails (verification, password reset). */
    APP_PUBLIC_URL: z.url().default('http://localhost:8081'),
    /** OAuth client ids allowed as the `aud` of Google ID tokens. Empty disables Google sign-in. */
    GOOGLE_CLIENT_IDS: csv,
    /** Apple Services/bundle ids allowed as `aud`. Empty disables Apple sign-in. */
    APPLE_CLIENT_IDS: csv,
    /** Requests per minute per client IP on each sign-in, OTP and recovery route. */
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

    // ── Maps and media (optional; features return 503 until configured) ───────
    /**
     * Server-side Google Maps Platform key with Places API (New) and Routes API enabled. Never
     * sent to the apps: they call Voyago, which calls Google. Restrict it by API and server IP.
     */
    GOOGLE_MAPS_API_KEY: z.string().default(''),
    CLOUDINARY_CLOUD_NAME: z.string().default(''),
    CLOUDINARY_API_KEY: z.string().default(''),
    /** Signs upload requests; stays on the server. */
    CLOUDINARY_API_SECRET: z.string().default(''),
    /** Top-level Cloudinary folder, so environments don't mix (voyago-dev, voyago-prod). */
    CLOUDINARY_FOLDER: z
      .string()
      .regex(/^[a-z0-9_-]{1,40}$/)
      .default('voyago-dev'),

    // ── Discovery (milestone 06) ───────────────────────────────────────────────
    /** Radius used when a nearby or point search does not send one. */
    DISCOVERY_DEFAULT_RADIUS_KM: z.coerce.number().int().min(1).max(500).default(25),
    /** Largest radius a member may ask for. */
    DISCOVERY_MAX_RADIUS_KM: z.coerce.number().int().min(1).max(500).default(200),
  })
  .superRefine((env, ctx) => {
    const cloudinary = [
      env.CLOUDINARY_CLOUD_NAME,
      env.CLOUDINARY_API_KEY,
      env.CLOUDINARY_API_SECRET,
    ];
    if (cloudinary.some(Boolean) && !cloudinary.every(Boolean)) {
      ctx.addIssue({
        code: 'custom',
        path: ['CLOUDINARY_API_SECRET'],
        message: 'Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET together',
      });
    }
    if (env.DISCOVERY_DEFAULT_RADIUS_KM > env.DISCOVERY_MAX_RADIUS_KM) {
      ctx.addIssue({
        code: 'custom',
        path: ['DISCOVERY_DEFAULT_RADIUS_KM'],
        message: 'must not exceed DISCOVERY_MAX_RADIUS_KM',
      });
    }
    if (env.NODE_ENV !== 'production') return;
    // Development-only adapters can never be enabled in production.
    for (const key of ['SMS_PROVIDER', 'EMAIL_PROVIDER'] as const) {
      if (env[key] === 'dev') {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `"dev" is not allowed in production`,
        });
      }
    }
    for (const key of ['JWT_ACCESS_SECRET', 'OTP_HMAC_SECRET'] as const) {
      if (/change-me|example|dev-only/i.test(env[key])) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'placeholder secret in production' });
      }
    }
    if (env.JWT_ACCESS_SECRET === env.OTP_HMAC_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['OTP_HMAC_SECRET'],
        message: 'must differ from JWT_ACCESS_SECRET',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

export function validateEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}
