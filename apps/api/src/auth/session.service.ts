import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { type AuthTokens } from '@voyago/shared';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { randomToken, sha256Hex } from './crypto.js';
import { TokenService } from './token.service.js';

export type RevokeReason =
  | 'rotated'
  | 'logout'
  | 'logout_all'
  | 'reuse_detected'
  | 'password_changed'
  | 'password_reset'
  | 'account_inactive';

const DAY_MS = 24 * 60 * 60 * 1000;

class RotationConflict extends Error {}

/**
 * Refresh-token sessions.
 *
 * - Each sign-in starts a session family. Each refresh rotates the token: the presented session
 *   is revoked (reason `rotated`) and points to its replacement in the same family.
 * - Presenting a rotated token again means it was copied: the whole family is revoked.
 * - Only SHA-256 hashes of refresh tokens are stored.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  /** Starts a new session family for a user who just proved their identity. */
  async signIn(userId: string, userAgent?: string): Promise<AuthTokens> {
    const familyId = randomUUID();
    const refreshToken = randomToken();
    await this.prisma.authSession.create({
      data: {
        userId,
        familyId,
        refreshTokenHash: sha256Hex(refreshToken),
        expiresAt: this.newExpiry(),
        userAgent: userAgent?.slice(0, 200) ?? null,
        lastUsedAt: new Date(),
      },
    });
    await this.prisma.user.update({ where: { id: userId }, data: { lastActiveAt: new Date() } });
    return this.tokens.buildTokens({ userId, sessionFamilyId: familyId }, refreshToken);
  }

  async refresh(refreshToken: string, userAgent?: string): Promise<AuthTokens> {
    const invalid = new UnauthorizedException('Session expired. Sign in again.');
    const session = await this.prisma.authSession.findUnique({
      where: { refreshTokenHash: sha256Hex(refreshToken) },
      include: { user: { select: { status: true, deletedAt: true } } },
    });
    if (!session) throw invalid;

    if (session.revokedAt) {
      if (session.revokedReason === 'rotated') await this.handleReuse(session.familyId);
      throw invalid;
    }
    if (session.expiresAt <= new Date()) throw invalid;
    if (session.user.status !== 'ACTIVE' || session.user.deletedAt) {
      await this.revokeFamily(session.familyId, 'account_inactive');
      throw invalid;
    }

    const nextToken = randomToken();
    try {
      await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const next = await tx.authSession.create({
          data: {
            userId: session.userId,
            familyId: session.familyId,
            refreshTokenHash: sha256Hex(nextToken),
            expiresAt: this.newExpiry(),
            userAgent: userAgent?.slice(0, 200) ?? session.userAgent,
            lastUsedAt: now,
          },
        });
        // Conditional update: only one of two concurrent refreshes with the same token wins.
        const rotated = await tx.authSession.updateMany({
          where: { id: session.id, revokedAt: null },
          data: {
            revokedAt: now,
            revokedReason: 'rotated',
            replacedById: next.id,
            lastUsedAt: now,
          },
        });
        if (rotated.count !== 1) throw new RotationConflict();
      });
    } catch (error) {
      if (error instanceof RotationConflict) {
        await this.handleReuse(session.familyId);
        throw invalid;
      }
      throw error;
    }
    return this.tokens.buildTokens(
      { userId: session.userId, sessionFamilyId: session.familyId },
      nextToken,
    );
  }

  async revokeFamily(familyId: string, reason: RevokeReason): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Revokes every session of a user, optionally keeping the current family signed in. */
  async revokeAllForUser(userId: string, reason: RevokeReason, exceptFamilyId?: string) {
    await this.prisma.authSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptFamilyId ? { familyId: { not: exceptFamilyId } } : {}),
      },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Used by the auth guard on every request: is this session family still signed in? */
  async findActiveUser(userId: string, familyId: string) {
    const session = await this.prisma.authSession.findFirst({
      where: { familyId, userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { user: { select: { id: true, role: true, status: true, deletedAt: true } } },
    });
    return session?.user ?? null;
  }

  private async handleReuse(familyId: string): Promise<void> {
    this.logger.warn(`Refresh token reuse detected; revoking session family ${familyId}`);
    await this.revokeFamily(familyId, 'reuse_detected');
  }

  private newExpiry(): Date {
    return new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * DAY_MS);
  }
}
