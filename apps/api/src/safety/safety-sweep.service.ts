import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { SafetyService } from './safety.service.js';
import { JobMonitor } from '../observability/job-monitor.service.js';

const INTERVAL_MS = 30_000;

/**
 * Ends location sessions that expired, whose trip ended, whose member left, or whose account
 * was suspended, and clears old SOS locations. Every read and update checks these as well; this
 * is the backstop so nothing is kept longer than it should be.
 */
@Injectable()
export class SafetySweepService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly safety: SafetyService,
    private readonly jobs: JobMonitor,
  ) {}

  onModuleInit(): void {
    this.timer = this.jobs.every(
      'safety-sweep',
      'Ends expired live-location sessions and clears old SOS locations',
      INTERVAL_MS,
      () => this.safety.sweep(),
    );
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }
}
