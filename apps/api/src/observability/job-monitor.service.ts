import { Injectable, Logger } from '@nestjs/common';
import { type JobStatus } from '@voyago/shared';
import { PrismaService } from '../database/prisma.service.js';
import { AlertsService } from './alerts.service.js';
import { MetricsRegistry } from './metrics.registry.js';

type JobInfo = { description: string; intervalMs: number };

/** Alert after this many failures in a row. */
const ALERT_AFTER = 3;
/** Successful runs are written to the database at most this often per job. */
const PERSIST_SUCCESS_MS = 60_000;

/**
 * Runs and records the background jobs (sweeps, reminders, retention). Each run updates its row
 * in `job_runs`; failures are logged, counted, and alerted after three in a row. A job never
 * throws out of `run`, so a failing sweep can't take the process down.
 */
@Injectable()
export class JobMonitor {
  private readonly logger = new Logger(JobMonitor.name);
  private readonly jobs = new Map<string, JobInfo>();
  private readonly running = new Set<string>();
  private readonly failing = new Set<string>();
  /** Successful runs not yet written, and when each job's row was last written. */
  private readonly unsaved = new Map<string, number>();
  private readonly savedAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsRegistry,
    private readonly alerts: AlertsService,
  ) {}

  register(name: string, description: string, intervalMs: number) {
    this.jobs.set(name, { description, intervalMs });
  }

  /**
   * Starts `fn` every `intervalMs` (unref'd); returns the timer to clear on shutdown. A run that
   * is still going when the next tick comes is not started twice.
   */
  every(name: string, description: string, intervalMs: number, fn: () => Promise<unknown>) {
    this.register(name, description, intervalMs);
    const timer = setInterval(() => {
      if (this.running.has(name)) return;
      void this.run(name, fn);
    }, intervalMs);
    timer.unref();
    return timer;
  }

  async run(name: string, fn: () => Promise<unknown>): Promise<boolean> {
    const startedAt = new Date();
    const t0 = process.hrtime.bigint();
    this.running.add(name);
    try {
      await fn();
      this.metrics.inc(
        'job_runs_total',
        { job: name, outcome: 'success' },
        1,
        'Background job runs',
      );
      this.metrics.set('job_last_success_timestamp_seconds', { job: name }, Date.now() / 1000);
      await this.record(name, startedAt, null);
      return true;
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      this.metrics.inc(
        'job_runs_total',
        { job: name, outcome: 'failure' },
        1,
        'Background job runs',
      );
      this.logger.warn(`Job ${name} failed: ${message}`);
      const row = await this.record(name, startedAt, message);
      if (row && row.consecutiveFailures >= ALERT_AFTER) {
        await this.alerts.raise(
          `job:${name}`,
          `Background job "${name}" has failed ${row.consecutiveFailures} times in a row: ${message}`,
        );
      }
      return false;
    } finally {
      this.running.delete(name);
      const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
      this.metrics.set('job_last_duration_seconds', { job: name }, seconds);
    }
  }

  async status(now = new Date()): Promise<JobStatus[]> {
    const rows = await this.prisma.jobRun.findMany();
    const byName = new Map(rows.map((r) => [r.name, r]));
    const names = [...new Set([...this.jobs.keys(), ...byName.keys()])].sort();
    return names.map((name) => {
      const info = this.jobs.get(name);
      const row = byName.get(name);
      const interval = info?.intervalMs ?? 0;
      const lastSuccess = row?.lastSuccessAt?.getTime() ?? null;
      // Successes are written at most once a minute, so allow for that on frequent jobs.
      const window = Math.max(3 * interval, 3 * PERSIST_SUCCESS_MS);
      const stale =
        interval > 0 && row?.lastStartedAt
          ? lastSuccess === null || now.getTime() - lastSuccess > window
          : false;
      return {
        name,
        description: info?.description ?? 'Not running in this process',
        intervalSeconds: Math.round(interval / 1000),
        lastStartedAt: row?.lastStartedAt?.toISOString() ?? null,
        lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
        lastError: row?.lastError ?? null,
        lastErrorAt: row?.lastErrorAt?.toISOString() ?? null,
        consecutiveFailures: row?.consecutiveFailures ?? 0,
        runs: row?.runs ?? 0,
        failures: row?.failures ?? 0,
        healthy: (row?.consecutiveFailures ?? 0) === 0 && !stale,
      };
    });
  }

  /**
   * Writes the run to `job_runs`. Failures are written at once; successes at most once a
   * minute per job (frequent jobs such as push delivery would otherwise write every few seconds),
   * with the runs in between added to the count.
   */
  private async record(name: string, startedAt: Date, error: string | null) {
    const pending = (this.unsaved.get(name) ?? 0) + 1;
    const last = this.savedAt.get(name) ?? 0;
    // A success right after a failure is always written, so the failure streak clears at once.
    const recovering = this.failing.has(name);
    if (error === null && !recovering && last > 0 && Date.now() - last < PERSIST_SUCCESS_MS) {
      this.unsaved.set(name, pending);
      return null;
    }
    const now = new Date();
    const outcome = error
      ? { lastError: error, lastErrorAt: now }
      : { lastSuccessAt: now, consecutiveFailures: 0 };
    try {
      const row = await this.prisma.jobRun.upsert({
        where: { name },
        create: {
          name,
          lastStartedAt: startedAt,
          ...outcome,
          runs: pending,
          failures: error ? 1 : 0,
          consecutiveFailures: error ? 1 : 0,
        },
        update: {
          lastStartedAt: startedAt,
          ...outcome,
          runs: { increment: pending },
          ...(error ? { failures: { increment: 1 }, consecutiveFailures: { increment: 1 } } : {}),
        },
      });
      this.unsaved.delete(name);
      this.savedAt.set(name, Date.now());
      if (error) this.failing.add(name);
      else this.failing.delete(name);
      return row;
    } catch (failure) {
      // Monitoring must not break the job; the database may be what is down.
      this.unsaved.set(name, pending);
      this.logger.warn(`Could not record job ${name}: ${(failure as Error).message}`);
      return null;
    }
  }
}
