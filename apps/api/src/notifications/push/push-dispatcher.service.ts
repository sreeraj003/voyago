import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { type PushMessage, PUSH_SENDER, type PushSender } from './push-sender.js';
import { JobMonitor } from '../../observability/job-monitor.service.js';

const INTERVAL_MS = 2_000;
const BATCH = 200;
/** A push that could not go out within this long is dropped: a late alert is worse than none. */
const STALE_MS = 15 * 60 * 1000;

interface Claimed {
  id: string;
  user_id: string;
  title: string;
  body: string | null;
  data: unknown;
  push_pending_at: Date;
}

/**
 * Sends pushes for new notifications. Notifications are written in the same transaction as the
 * change they describe, with `push_pending_at` set; this worker claims pending rows with
 * `FOR UPDATE SKIP LOCKED`, so a push goes out only after commit and only once, even with several
 * API instances.
 */
@Injectable()
export class PushDispatcherService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PUSH_SENDER) private readonly sender: PushSender,
    private readonly jobs: JobMonitor,
  ) {}

  onModuleInit(): void {
    if (!this.sender.enabled) return;
    // The monitor skips a tick while the previous drain is still going.
    this.timer = this.jobs.every(
      'push-delivery',
      'Sends push notifications for new notifications',
      INTERVAL_MS,
      () => this.drain(),
    );
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Handles one batch; returns how many notifications it claimed (0 when none are waiting). */
  async runOnce(now = new Date()): Promise<number> {
    const claimed = await this.prisma.$queryRaw<Claimed[]>`
      WITH picked AS (
        SELECT "id", "push_pending_at" FROM "notifications"
        WHERE "push_pending_at" IS NOT NULL
        ORDER BY "push_pending_at"
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED)
      UPDATE "notifications" n SET "push_pending_at" = NULL
      FROM picked WHERE n."id" = picked."id"
      RETURNING n."id", n."user_id", n."title", n."body", n."data", picked."push_pending_at"`;
    const fresh = claimed.filter((row) => now.getTime() - row.push_pending_at.getTime() < STALE_MS);
    if (fresh.length === 0) return claimed.length;

    const userIds = [...new Set(fresh.map((row) => row.user_id))];
    const [tokens, optedOut] = await Promise.all([
      this.prisma.pushToken.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, token: true },
      }),
      this.prisma.userPreference.findMany({
        where: { userId: { in: userIds }, pushEnabled: false },
        select: { userId: true },
      }),
    ]);
    const muted = new Set(optedOut.map((row) => row.userId));
    const messages: PushMessage[] = [];
    for (const row of fresh) {
      if (muted.has(row.user_id)) continue;
      for (const device of tokens.filter((t) => t.userId === row.user_id)) {
        messages.push({
          to: device.token,
          title: row.title,
          body: row.body?.slice(0, 180) ?? undefined,
          data: { notificationId: row.id, ...readIds(row.data) },
        });
      }
    }
    if (messages.length === 0) return claimed.length;

    const outcomes = await this.sender.send(messages);
    const invalid = messages.filter((_, i) => outcomes[i] === 'invalid_token').map((m) => m.to);
    if (invalid.length > 0) {
      await this.prisma.pushToken.deleteMany({ where: { token: { in: invalid } } });
    }
    return claimed.length;
  }

  private async drain(): Promise<void> {
    while ((await this.runOnce()) > 0) {
      // Drain a backlog before waiting for the next tick.
    }
  }
}

function readIds(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const ids: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') ids[key] = item;
  }
  return ids;
}
