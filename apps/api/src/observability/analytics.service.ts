import { Inject, Injectable, Logger } from '@nestjs/common';
import { ANALYTICS_EVENTS, type AnalyticsEventName, type AnalyticsProps } from '@voyago/shared';
import { createHmac } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { MetricsRegistry } from './metrics.registry.js';

/** The day boundary for "active today" and daily charts. */
export const ANALYTICS_TIME_ZONE = 'Asia/Kolkata';

/** YYYY-MM-DD in India time. */
export function indiaDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ANALYTICS_TIME_ZONE }).format(date);
}

/**
 * Product analytics, first-party. Each event stores a pseudonymous actor key (a keyed hash of the
 * user id) and only the properties its dictionary entry allows (packages/shared/src/analytics.ts).
 * Recording never fails the request that caused it: errors are logged and counted.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);
  private readonly key: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly metrics: MetricsRegistry,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.key = config.ANALYTICS_HASH_KEY
      ? Buffer.from(config.ANALYTICS_HASH_KEY)
      : createHmac('sha256', config.OTP_HMAC_SECRET).update('voyago-analytics-actor').digest();
  }

  /** The pseudonymous key for a user: stable, not reversible without the key. */
  actorKey(userId: string): string {
    return createHmac('sha256', this.key).update(userId).digest('hex').slice(0, 32);
  }

  async track<N extends AnalyticsEventName>(
    name: N,
    userId: string | null,
    properties: AnalyticsProps<N>,
  ): Promise<void> {
    try {
      // Only the dictionary's properties survive (unknown keys are stripped).
      const props = ANALYTICS_EVENTS[name].properties.parse(properties) as object;
      await this.prisma.analyticsEvent.create({
        data: { name, actorKey: userId ? this.actorKey(userId) : null, properties: props },
      });
      this.metrics.inc('analytics_events_total', { name }, 1, 'Analytics events recorded');
    } catch (error) {
      this.metrics.inc('analytics_event_failures_total', { name }, 1, 'Analytics events dropped');
      this.logger.warn(`Analytics event ${name} not recorded: ${(error as Error).message}`);
    }
  }

  /** Records `trip_viewed` at most once per member, trip and day. */
  async tripViewed(userId: string, tripId: string, props: AnalyticsProps<'trip_viewed'>) {
    if (await this.firstToday(`view:${this.actorKey(userId)}:${tripId}`)) {
      await this.track('trip_viewed', userId, props);
    }
  }

  /**
   * The member made a signed-in request: once a day, record `user_active` (for DAU, MAU and
   * retention) and refresh `users.last_active_at`. Redis skips repeats cheaply; without Redis the
   * check for today's event keeps it to one (DAU counts distinct members either way).
   */
  async active(userId: string, now = new Date()): Promise<void> {
    try {
      const day = indiaDay(now);
      if (!(await this.firstToday(`active:${userId}:${day}`))) return;
      const since = new Date(`${day}T00:00:00+05:30`);
      const actorKey = this.actorKey(userId);
      const seen = await this.prisma.analyticsEvent.findFirst({
        where: { name: 'user_active', actorKey, occurredAt: { gte: since } },
        select: { id: true },
      });
      await this.prisma.user.updateMany({ where: { id: userId }, data: { lastActiveAt: now } });
      if (!seen) await this.track('user_active', userId, {});
    } catch (error) {
      this.logger.warn(`Could not mark activity: ${(error as Error).message}`);
    }
  }

  /** Deletes every event of these users (account deletion). */
  async forget(userIds: string[]): Promise<number> {
    if (userIds.length === 0) return 0;
    const { count } = await this.prisma.analyticsEvent.deleteMany({
      where: { actorKey: { in: userIds.map((id) => this.actorKey(id)) } },
    });
    return count;
  }

  private async firstToday(key: string): Promise<boolean> {
    if (!this.redis.isReady) return true;
    try {
      return (await this.redis.client.set(`analytics:${key}`, '1', 'EX', 26 * 3600, 'NX')) === 'OK';
    } catch {
      return true;
    }
  }
}
