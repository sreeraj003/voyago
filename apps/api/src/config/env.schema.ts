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
     * tests; refused in production. `twilio` or `msg91`: real delivery with the keys below.
     */
    SMS_PROVIDER: z.enum(['none', 'dev', 'twilio', 'msg91']).default('none'),
    TWILIO_ACCOUNT_SID: z.string().default(''),
    TWILIO_AUTH_TOKEN: z.string().default(''),
    /** A Twilio number in E.164, or leave empty and set TWILIO_MESSAGING_SERVICE_SID. */
    TWILIO_FROM: z.string().default(''),
    TWILIO_MESSAGING_SERVICE_SID: z.string().default(''),
    MSG91_AUTH_KEY: z.string().default(''),
    /** DLT-approved OTP template (flow) id. */
    MSG91_TEMPLATE_ID: z.string().default(''),
    /** The variable in that template that holds the code. */
    MSG91_OTP_VARIABLE: z.string().default('otp'),
    /**
     * DLT-approved SOS template (flow) id, with variables `name`, `trip` and `link`. Without it,
     * MSG91 cannot text emergency contacts (SOS still reaches the trip's members in the app).
     */
    MSG91_SOS_TEMPLATE_ID: z.string().default(''),
    /**
     * `none`: no email is sent (verification and reset return 503). `dev`: as for SMS.
     * `resend` or `postmark`: real delivery with the keys below.
     */
    EMAIL_PROVIDER: z.enum(['none', 'dev', 'resend', 'postmark']).default('none'),
    /** Sender, e.g. `Voyago <no-reply@yourdomain.in>`; the domain must be verified with the provider. */
    EMAIL_FROM: z.string().default(''),
    RESEND_API_KEY: z.string().default(''),
    POSTMARK_SERVER_TOKEN: z.string().default(''),
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

    // ── Chat and push (milestone 09) ───────────────────────────────────────────
    /** Messages one member may send per minute, across all chats. */
    CHAT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(30),
    /**
     * `none`: in-app notifications only. `dev`: pushes are logged and kept in memory for tests;
     * refused in production. `expo`: Expo's push service, which delivers through FCM (Android)
     * and APNs (iOS) using the credentials uploaded to your Expo project.
     */
    PUSH_PROVIDER: z.enum(['none', 'dev', 'expo']).default('none'),
    /** Optional: required only if "enhanced push security" is turned on in the Expo project. */
    EXPO_ACCESS_TOKEN: z.string().default(''),

    // ── Payments (milestone 13) ────────────────────────────────────────────────
    /** `none`: booking stays closed. `razorpay`: Razorpay Orders, Checkout, webhooks and refunds. */
    PAYMENT_PROVIDER: z.enum(['none', 'razorpay']).default('none'),
    RAZORPAY_KEY_ID: z.string().default(''),
    /** Signs API calls and checkout signatures; stays on the server. */
    RAZORPAY_KEY_SECRET: z.string().default(''),
    /** The secret set on the Razorpay webhook (Dashboard > Webhooks); verifies every webhook. */
    RAZORPAY_WEBHOOK_SECRET: z.string().default(''),
    /**
     * Live (real money) keys are refused unless this is `true`, which should only be set once the
     * legal review, provider approval and operator agreements are in place.
     */
    PAYMENTS_LIVE_APPROVED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    /** Platform commission in basis points (1000 = 10%), applied to new bookings. */
    PLATFORM_COMMISSION_BPS: z.coerce.number().int().min(0).max(5000).default(1000),
    /** Tax on the commission in basis points (1800 = 18% GST), applied to new bookings. */
    COMMISSION_TAX_BPS: z.coerce.number().int().min(0).max(5000).default(1800),
    /** Public base URL of this API, for the provider's checkout return address. */
    API_PUBLIC_URL: z.url().default('http://localhost:3000'),

    // ── Subscriptions (milestone 14) ───────────────────────────────────────────
    /**
     * Whether members can buy Explorer Pro and Organiser Pro (needs PAYMENT_PROVIDER too). Set to
     * `false` to hide paid plans while repeat use is still being proven. Existing subscriptions keep
     * working either way. Prices are set per plan in the admin app.
     */
    SUBSCRIPTIONS_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
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
    // A chosen provider must have its keys, so it fails at start-up, not at the first sign-in.
    const required: Record<string, (keyof typeof env)[]> = {
      twilio: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
      msg91: ['MSG91_AUTH_KEY', 'MSG91_TEMPLATE_ID'],
      resend: ['RESEND_API_KEY', 'EMAIL_FROM'],
      postmark: ['POSTMARK_SERVER_TOKEN', 'EMAIL_FROM'],
    };
    for (const provider of [env.SMS_PROVIDER, env.EMAIL_PROVIDER]) {
      for (const key of required[provider] ?? []) {
        if (!env[key]) {
          ctx.addIssue({ code: 'custom', path: [key], message: `required when using ${provider}` });
        }
      }
    }
    if (env.SMS_PROVIDER === 'twilio' && !env.TWILIO_FROM && !env.TWILIO_MESSAGING_SERVICE_SID) {
      ctx.addIssue({
        code: 'custom',
        path: ['TWILIO_FROM'],
        message: 'Set TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID',
      });
    }
    if (env.PAYMENT_PROVIDER === 'razorpay') {
      for (const key of [
        'RAZORPAY_KEY_ID',
        'RAZORPAY_KEY_SECRET',
        'RAZORPAY_WEBHOOK_SECRET',
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'required when using razorpay' });
        }
      }
      if (env.RAZORPAY_KEY_ID.startsWith('rzp_live_') && !env.PAYMENTS_LIVE_APPROVED) {
        ctx.addIssue({
          code: 'custom',
          path: ['RAZORPAY_KEY_ID'],
          message:
            'live payment keys need PAYMENTS_LIVE_APPROVED=true (only after legal, provider and operator approval)',
        });
      }
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
    for (const key of ['SMS_PROVIDER', 'EMAIL_PROVIDER', 'PUSH_PROVIDER'] as const) {
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
