import { Injectable } from '@nestjs/common';
import { MODERATION_SLA_HOURS, type SystemStatus } from '@voyago/shared';
import { PrismaService } from '../database/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { APP_VERSION } from '../version.js';
import { JobMonitor } from './job-monitor.service.js';
import { MetricsRegistry } from './metrics.registry.js';

const HOUR_MS = 3_600_000;

/** Hourly client-error counters in Redis, summed for the last day. */
export const clientErrorKey = (date: Date) => `client-errors:${date.toISOString().slice(0, 13)}`;

/**
 * What operations needs at a glance: dependencies with latency, request latency and errors,
 * background jobs, payment webhook problems and the moderation backlog against its SLA.
 */
@Injectable()
export class SystemStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly jobs: JobMonitor,
    private readonly metrics: MetricsRegistry,
  ) {}

  async status(now = new Date()): Promise<SystemStatus> {
    const [database, redis] = await Promise.all([
      this.timed(async () => {
        await this.prisma.$queryRaw`SELECT 1`;
        return true;
      }),
      this.timed(() => this.redis.ping()),
    ]);
    this.metrics.set(
      'dependency_up',
      { name: 'database' },
      database.up ? 1 : 0,
      'Dependency is reachable',
    );
    this.metrics.set('dependency_up', { name: 'redis' }, redis.up ? 1 : 0);
    for (const [name, probe] of [
      ['database', database],
      ['redis', redis],
    ] as const) {
      if (probe.latencyMs !== null) {
        this.metrics.set('dependency_latency_ms', { name }, probe.latencyMs, 'Probe latency');
      }
    }

    const [jobs, payments, moderation, clientErrors] = await Promise.all([
      this.jobs.status(now),
      this.payments(now),
      this.moderation(now),
      this.clientErrors(now),
    ]);
    return {
      generatedAt: now.toISOString(),
      version: APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      dependencies: [
        { name: 'database', ...database },
        { name: 'redis', ...redis },
      ],
      http: this.metrics.httpSummary(),
      jobs,
      payments,
      moderation,
      clientErrors24h: clientErrors,
    };
  }

  private async payments(now: Date) {
    const [stuck, invalid, failedRefunds, mismatches] = await Promise.all([
      this.prisma.paymentEvent.count({
        where: {
          processedAt: null,
          signatureValid: true,
          receivedAt: { lt: new Date(now.getTime() - 10 * 60_000) },
        },
      }),
      this.prisma.paymentEvent.count({
        where: {
          signatureValid: false,
          receivedAt: { gte: new Date(now.getTime() - 24 * HOUR_MS) },
        },
      }),
      this.prisma.refund.count({ where: { status: 'FAILED' } }),
      this.prisma.payment.count({ where: { failureCode: 'AMOUNT_MISMATCH' } }),
    ]);
    this.metrics.set(
      'payment_webhooks_stuck',
      {},
      stuck,
      'Provider events not applied after 10 minutes',
    );
    return {
      stuckWebhooks: stuck,
      invalidSignatures24h: invalid,
      failedRefunds,
      amountMismatches: mismatches,
    };
  }

  private async moderation(now: Date) {
    const open = await this.prisma.report.findMany({
      where: { status: { in: ['OPEN', 'IN_REVIEW'] } },
      select: { severity: true, createdAt: true },
    });
    const overdue = open.filter(
      (r) => now.getTime() - r.createdAt.getTime() > MODERATION_SLA_HOURS[r.severity] * HOUR_MS,
    ).length;
    const oldest = open.reduce<number | null>(
      (min, r) => (min === null || r.createdAt.getTime() < min ? r.createdAt.getTime() : min),
      null,
    );
    this.metrics.set('moderation_reports_overdue', {}, overdue, 'Reports past their SLA');
    return {
      open: open.length,
      overdue,
      oldestOpenHours:
        oldest === null ? null : Math.round(((now.getTime() - oldest) / HOUR_MS) * 10) / 10,
    };
  }

  private async clientErrors(now: Date): Promise<number> {
    if (!this.redis.isReady) return 0;
    const keys = Array.from({ length: 24 }, (_, i) =>
      clientErrorKey(new Date(now.getTime() - i * HOUR_MS)),
    );
    try {
      const values = await this.redis.client.mget(keys);
      return values.reduce((sum, v) => sum + Number(v ?? 0), 0);
    } catch {
      return 0;
    }
  }

  private async timed(probe: () => Promise<boolean>) {
    const started = Date.now();
    try {
      const up = await Promise.race([
        probe(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000).unref()),
      ]);
      return { up, latencyMs: up ? Date.now() - started : null };
    } catch {
      return { up: false, latencyMs: null };
    }
  }
}
