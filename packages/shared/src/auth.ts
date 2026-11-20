import { z } from 'zod';

/**
 * Sign-in and account-recovery contracts shared by the API and the apps.
 * Methods: email + password, phone OTP, and Google / Apple when configured on the server.
 */

/** Handles that could be mistaken for staff or system accounts. */
const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'api',
  'help',
  'me',
  'moderator',
  'root',
  'support',
  'system',
  'voyago',
]);

/**
 * 3 to 30 letters, digits, `_` or `.`; no leading, trailing or repeated dots.
 * Unique case-insensitively in the database.
 */
export const UsernameSchema = z
  .string()
  .trim()
  .regex(
    /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_.]{1,28}[A-Za-z0-9_]$/,
    'Use 3 to 30 letters, numbers, underscores or dots',
  )
  .refine((value) => !RESERVED_USERNAMES.has(value.toLowerCase()), 'This username is reserved');

export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email('Enter a valid email address'));

/** E.164, e.g. +919876543210. Spaces, dashes and brackets in the input are ignored. */
export const PhoneSchema = z
  .string()
  .transform((value) => value.replace(/[\s\-()]/g, ''))
  .pipe(z.string().regex(/^\+[1-9]\d{6,14}$/, 'Enter the number with country code, e.g. +91…'));

/** Length is what matters most; no composition rules (NIST SP 800-63B). */
export const PasswordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128, 'Use at most 128 characters');

export const DisplayNameSchema = z.string().trim().min(1).max(80);

export const OtpCodeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');

/** Opaque single-use tokens (refresh tokens, email links): base64url, 43 characters. */
export const OpaqueTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid or expired token');

// ── Requests ────────────────────────────────────────────────────────────────

export const RegisterSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  username: UsernameSchema,
  displayName: DisplayNameSchema,
});
export type RegisterInput = z.input<typeof RegisterSchema>;

export const LoginSchema = z.object({
  email: EmailSchema,
  // Not validated for length here so a too-short password gets the same generic error.
  password: z.string().min(1).max(128),
});
export type LoginInput = z.input<typeof LoginSchema>;

export const RefreshSchema = z.object({ refreshToken: OpaqueTokenSchema });

export const OtpRequestSchema = z.object({ phone: PhoneSchema });
export const OtpVerifySchema = z.object({ phone: PhoneSchema, code: OtpCodeSchema });

export const SocialProviderSchema = z.enum(['google', 'apple']);
export type SocialProvider = z.infer<typeof SocialProviderSchema>;
export const SocialSignInSchema = z.object({ idToken: z.string().min(20).max(4096) });

/** Finishes a phone or social sign-up: the verified identity is carried by `signupToken`. */
export const CompleteSignupSchema = z.object({
  signupToken: z.string().min(20).max(2048),
  username: UsernameSchema,
  displayName: DisplayNameSchema,
});

export const EmailVerifyConfirmSchema = z.object({ token: OpaqueTokenSchema });
export const ForgotPasswordSchema = z.object({ email: EmailSchema });
export const ResetPasswordSchema = z.object({ token: OpaqueTokenSchema, password: PasswordSchema });
export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: PasswordSchema,
});

// ── Responses ───────────────────────────────────────────────────────────────

export const AuthTokensSchema = z.object({
  accessToken: z.string(),
  /** Seconds until the access token expires. */
  expiresIn: z.number().int(),
  refreshToken: z.string(),
  tokenType: z.literal('Bearer'),
});
export type AuthTokens = z.infer<typeof AuthTokensSchema>;

/**
 * Result of OTP verification or social sign-in. A new person gets a short-lived signup token
 * to choose a username; an existing member gets tokens straight away.
 */
export const SignInResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('AUTHENTICATED'), tokens: AuthTokensSchema }),
  z.object({
    status: z.literal('SIGNUP_REQUIRED'),
    signupToken: z.string(),
    suggestedDisplayName: z.string().nullable(),
  }),
]);
export type SignInResult = z.infer<typeof SignInResultSchema>;

export const AuthMethodsSchema = z.object({
  password: z.boolean(),
  phoneOtp: z.boolean(),
  google: z.boolean(),
  apple: z.boolean(),
  emailDelivery: z.boolean(),
});
export type AuthMethods = z.infer<typeof AuthMethodsSchema>;
