import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  type AuthMethods,
  type AuthTokens,
  type SignInResult,
  type SocialProvider,
} from '@voyago/shared';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { AnalyticsService } from '../observability/analytics.service.js';
import { randomToken, sha256Hex } from './crypto.js';
import { EMAIL_SENDER, type EmailSender } from './delivery/email-sender.js';
import { LoginAttemptsService } from './login-attempts.service.js';
import { OtpService } from './otp.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { SocialTokenVerifier } from './social/social-token.verifier.js';
import { type SignupIdentity, TokenService } from './token.service.js';

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

type TokenPurpose = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';

interface NewAccount {
  username: string;
  displayName: string;
}

/**
 * Account lifecycle: sign-up, sign-in (password, phone OTP, Google, Apple), verification and
 * recovery. Responses never reveal whether an email address or phone number has an account.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly otp: OtpService,
    private readonly social: SocialTokenVerifier,
    private readonly loginAttempts: LoginAttemptsService,
    private readonly analytics: AnalyticsService,
  ) {}

  methods(): AuthMethods {
    return {
      password: true,
      phoneOtp: this.otp.enabled,
      google: this.social.isEnabled('google'),
      apple: this.social.isEnabled('apple'),
      emailDelivery: this.email.enabled,
    };
  }

  // ── Email and password ────────────────────────────────────────────────────

  /**
   * Same response whether or not the email already has an account. An existing owner gets an
   * email saying someone tried to register (and can reset their password). Only a taken
   * username returns 409: usernames are public anyway.
   */
  async register(input: { email: string; password: string } & NewAccount): Promise<void> {
    // Hash first so both paths take the same time.
    const passwordHash = await this.passwords.hash(input.password);
    await this.assertUsernameAvailable(input.username);

    const existing = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });
    if (existing) {
      await this.sendEmail(input.email, 'Someone tried to sign up with your email', [
        'Someone tried to create a Voyago account with this email address.',
        'If it was you, sign in instead, or reset your password from the sign-in screen.',
        'If it was not you, you can ignore this email.',
      ]);
      return;
    }

    try {
      const user = await this.prisma.user.create({
        data: {
          email: input.email,
          passwordHash,
          username: input.username,
          displayName: input.displayName,
          preferences: { create: {} },
        },
        select: { id: true },
      });
      await this.analytics.track('account_registered', user.id, { method: 'email' });
      await this.sendVerificationEmail(user.id, input.email);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Lost a race: either the username or the email was just taken.
      await this.assertUsernameAvailable(input.username);
    }
  }

  async login(email: string, password: string, userAgent?: string): Promise<AuthTokens> {
    await this.loginAttempts.assertNotLocked(email);
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, passwordHash: true, status: true, deletedAt: true },
    });
    const valid = await this.passwords.verify(user?.passwordHash, password);
    if (!user || !valid) {
      await this.loginAttempts.recordFailure(email);
      throw new UnauthorizedException('Invalid email or password');
    }
    await this.loginAttempts.reset(email);
    this.assertActive(user);
    return this.sessions.signIn(user.id, userAgent);
  }

  async changePassword(
    userId: string,
    sessionFamilyId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!user.passwordHash) {
      throw new BadRequestException(
        'This account has no password yet. Add an email and use "Forgot password" to set one.',
      );
    }
    if (!(await this.passwords.verify(user.passwordHash, currentPassword))) {
      throw new BadRequestException({
        message: 'Validation failed',
        details: [{ path: 'currentPassword', message: 'Current password is incorrect' }],
      });
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await this.passwords.hash(newPassword) },
    });
    // Other devices are signed out; this one stays signed in.
    await this.sessions.revokeAllForUser(userId, 'password_changed', sessionFamilyId);
  }

  /** Always 202 when email delivery is configured, whether or not the account exists. */
  async forgotPassword(email: string): Promise<void> {
    this.assertEmailDelivery();
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, status: true, deletedAt: true },
    });
    if (!user || user.status !== 'ACTIVE' || user.deletedAt) return;
    const token = await this.issueToken(user.id, 'PASSWORD_RESET', PASSWORD_RESET_TTL_MS);
    await this.sendEmail(email, 'Reset your Voyago password', [
      'Use this link within 1 hour to choose a new password:',
      `${this.config.APP_PUBLIC_URL}/reset-password?token=${token}`,
      'If you did not ask for this, ignore this email. Your password has not changed.',
    ]);
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const passwordHash = await this.passwords.hash(password);
    const userId = await this.consumeToken(token, 'PASSWORD_RESET');
    const now = new Date();
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { emailVerifiedAt: true },
    });
    await this.prisma.user.update({
      where: { id: userId },
      // The link arrived by email, so the address is proven too.
      data: { passwordHash, emailVerifiedAt: user.emailVerifiedAt ?? now },
    });
    await this.sessions.revokeAllForUser(userId, 'password_reset');
  }

  async requestEmailVerification(userId: string): Promise<'sent' | 'already_verified'> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true },
    });
    if (!user.email) throw new BadRequestException('Add an email address first');
    if (user.emailVerifiedAt) return 'already_verified';
    this.assertEmailDelivery();
    await this.sendVerificationEmail(userId, user.email);
    return 'sent';
  }

  async confirmEmailVerification(token: string): Promise<void> {
    const userId = await this.consumeToken(token, 'EMAIL_VERIFICATION');
    await this.prisma.user.updateMany({
      where: { id: userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
  }

  // ── Phone OTP and social sign-in ──────────────────────────────────────────

  requestOtp(phone: string) {
    return this.otp.request(phone);
  }

  async verifyOtp(phone: string, code: string, userAgent?: string): Promise<SignInResult> {
    await this.otp.verify(phone, code);
    const user = await this.prisma.user.findUnique({
      where: { phone },
      select: { id: true, status: true, deletedAt: true, phoneVerifiedAt: true },
    });
    if (!user) {
      return this.signupRequired({ kind: 'phone', phone }, null);
    }
    this.assertActive(user);
    if (!user.phoneVerifiedAt) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { phoneVerifiedAt: new Date() },
      });
    }
    return { status: 'AUTHENTICATED', tokens: await this.sessions.signIn(user.id, userAgent) };
  }

  async socialSignIn(
    provider: SocialProvider,
    idToken: string,
    userAgent?: string,
  ): Promise<SignInResult> {
    const identity = await this.social.verify(provider, idToken);
    const linked = await this.prisma.authIdentity.findUnique({
      where: {
        provider_providerUserId: {
          provider: identity.provider,
          providerUserId: identity.providerUserId,
        },
      },
      select: { user: { select: { id: true, status: true, deletedAt: true } } },
    });
    if (linked) {
      this.assertActive(linked.user);
      return {
        status: 'AUTHENTICATED',
        tokens: await this.sessions.signIn(linked.user.id, userAgent),
      };
    }

    if (identity.email) {
      const byEmail = await this.prisma.user.findUnique({
        where: { email: identity.email },
        select: { id: true, status: true, deletedAt: true, emailVerifiedAt: true },
      });
      if (byEmail) {
        // Link automatically only when both sides have verified the same address; otherwise
        // someone could pre-register an unverified account with another person's email.
        if (!byEmail.emailVerifiedAt) {
          throw new ConflictException(
            'An account already uses this email. Sign in with your password and verify your email first.',
          );
        }
        this.assertActive(byEmail);
        await this.prisma.authIdentity.create({
          data: {
            userId: byEmail.id,
            provider: identity.provider,
            providerUserId: identity.providerUserId,
            email: identity.email,
          },
        });
        return {
          status: 'AUTHENTICATED',
          tokens: await this.sessions.signIn(byEmail.id, userAgent),
        };
      }
    }

    return this.signupRequired({ kind: 'social', ...identity }, identity.name);
  }

  /** Creates the account for a verified phone or social identity, then signs in. */
  async completeSignup(
    signupToken: string,
    account: NewAccount,
    userAgent?: string,
  ): Promise<AuthTokens> {
    const identity = await this.tokens.verifySignupToken(signupToken);
    await this.assertUsernameAvailable(account.username);
    const now = new Date();
    const base = {
      username: account.username,
      displayName: account.displayName,
      preferences: { create: {} },
    };

    let userId: string;
    try {
      if (identity.kind === 'phone') {
        const user = await this.prisma.user.create({
          data: { ...base, phone: identity.phone, phoneVerifiedAt: now },
          select: { id: true },
        });
        userId = user.id;
      } else {
        const emailFree =
          identity.email !== null &&
          !(await this.prisma.user.findUnique({
            where: { email: identity.email },
            select: { id: true },
          }));
        const user = await this.prisma.user.create({
          data: {
            ...base,
            ...(emailFree ? { email: identity.email, emailVerifiedAt: now } : {}),
            identities: {
              create: {
                provider: identity.provider,
                providerUserId: identity.providerUserId,
                email: identity.email,
              },
            },
          },
          select: { id: true },
        });
        userId = user.id;
      }
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await this.assertUsernameAvailable(account.username);
      throw new ConflictException('An account already exists for this sign-in. Sign in instead.');
    }
    await this.analytics.track('account_registered', userId, {
      method:
        identity.kind === 'phone' ? 'phone' : identity.provider === 'APPLE' ? 'apple' : 'google',
    });
    return this.sessions.signIn(userId, userAgent);
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  refresh(refreshToken: string, userAgent?: string) {
    return this.sessions.refresh(refreshToken, userAgent);
  }

  logout(sessionFamilyId: string) {
    return this.sessions.revokeFamily(sessionFamilyId, 'logout');
  }

  logoutAll(userId: string) {
    return this.sessions.revokeAllForUser(userId, 'logout_all');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async signupRequired(
    identity: SignupIdentity,
    suggestedDisplayName: string | null,
  ): Promise<SignInResult> {
    return {
      status: 'SIGNUP_REQUIRED',
      signupToken: await this.tokens.signSignupToken(identity),
      suggestedDisplayName,
    };
  }

  private async assertUsernameAvailable(username: string): Promise<void> {
    const taken = await this.prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (taken) throw new ConflictException('This username is taken');
  }

  private assertActive(user: { status: string; deletedAt: Date | null }): void {
    if (user.status !== 'ACTIVE' || user.deletedAt) {
      throw new ForbiddenException('This account is not active. Contact support for help.');
    }
  }

  private assertEmailDelivery(): void {
    if (!this.email.enabled) {
      throw new ServiceUnavailableException('Email is not available yet');
    }
  }

  private async sendVerificationEmail(userId: string, address: string): Promise<void> {
    if (!this.email.enabled) {
      this.logger.warn('No email provider configured: verification email not sent');
      return;
    }
    const token = await this.issueToken(userId, 'EMAIL_VERIFICATION', EMAIL_VERIFICATION_TTL_MS);
    await this.sendEmail(address, 'Verify your email for Voyago', [
      'Confirm this address within 24 hours:',
      `${this.config.APP_PUBLIC_URL}/verify-email?token=${token}`,
    ]);
  }

  /** Issues a single-use token; earlier unused tokens for the same purpose stop working. */
  private async issueToken(userId: string, purpose: TokenPurpose, ttlMs: number): Promise<string> {
    const token = randomToken();
    await this.prisma.$transaction([
      this.prisma.verificationToken.updateMany({
        where: { userId, purpose, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
      this.prisma.verificationToken.create({
        data: {
          userId,
          purpose,
          tokenHash: sha256Hex(token),
          expiresAt: new Date(Date.now() + ttlMs),
        },
      }),
    ]);
    return token;
  }

  private async consumeToken(token: string, purpose: TokenPurpose): Promise<string> {
    const invalid = new BadRequestException('This link is invalid or has expired');
    const record = await this.prisma.verificationToken.findUnique({
      where: { tokenHash: sha256Hex(token) },
      select: { id: true, userId: true, purpose: true },
    });
    if (!record || record.purpose !== purpose) throw invalid;
    const consumed = await this.prisma.verificationToken.updateMany({
      where: { id: record.id, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw invalid;
    return record.userId;
  }

  private async sendEmail(to: string, subject: string, lines: string[]): Promise<void> {
    if (!this.email.enabled) return;
    try {
      await this.email.send({ to, subject, text: lines.join('\n\n') });
    } catch (error) {
      // Delivery problems must not change the response (that would reveal account existence).
      this.logger.error(`Email delivery failed: ${(error as Error).message}`);
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
