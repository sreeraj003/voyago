import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { AnalyticsService } from './analytics.service.js';
import { JobMonitor } from './job-monitor.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** How long things that only serve operations are kept (docs/OPERATIONS.md, "Data retention"). */
export const RETENTION = {
  readNotificationsDays: 180,
  endedSessionsDays: 30,
  usedTokensDays: 7,
  otpChallengesDays: 1,
  jobRunsStaleDays: 30,
} as const;

export type RetentionResult = Record<string, number>;

/**
 * Deletes data past its retention period. Money records (payments, refunds, ledger, provider
 * events) and the audit log are never deleted here: they are kept for accounting and law.
 * Live location and SOS positions have their own sweep (milestone 11).
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    private readonly jobs: JobMonitor,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.timer = this.jobs.every(
      'data-retention',
      'Deletes analytics events, read notifications, ended sessions and used tokens past retention',
      RETENTION_INTERVAL_MS,
      () => this.run(),
    );
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async run(now = new Date()): Promise<RetentionResult> {
    const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const deletedUsers = await this.prisma.user.findMany({
      where: { deletedAt: { gte: ago(3) } },
      select: { id: true },
      take: 1000,
    });
    const [events, forgotten, notifications, sessions, tokens, otps, jobs] = await Promise.all([
      this.prisma.analyticsEvent.deleteMany({
        where: { occurredAt: { lt: ago(this.config.ANALYTICS_RETENTION_DAYS) } },
      }),
      this.analytics.forget(deletedUsers.map((u) => u.id)),
      this.prisma.notification.deleteMany({
        where: { readAt: { lt: ago(RETENTION.readNotificationsDays) } },
      }),
      this.prisma.authSession.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: ago(RETENTION.endedSessionsDays) } },
            { revokedAt: { lt: ago(RETENTION.endedSessionsDays) } },
          ],
        },
      }),
      this.prisma.verificationToken.deleteMany({
        where: {
          OR: [
            { consumedAt: { lt: ago(RETENTION.usedTokensDays) } },
            { expiresAt: { lt: ago(RETENTION.usedTokensDays) } },
          ],
        },
      }),
      this.prisma.otpChallenge.deleteMany({
        where: { createdAt: { lt: ago(RETENTION.otpChallengesDays) } },
      }),
      this.prisma.jobRun.deleteMany({
        where: { updatedAt: { lt: ago(RETENTION.jobRunsStaleDays) } },
      }),
    ]);
    return {
      analyticsEvents: events.count,
      deletedAccountsEvents: forgotten,
      readNotifications: notifications.count,
      authSessions: sessions.count,
      verificationTokens: tokens.count,
      otpChallenges: otps.count,
      jobRuns: jobs.count,
    };
  }
}
