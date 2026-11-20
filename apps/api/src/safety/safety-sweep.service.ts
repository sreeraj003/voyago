import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { SafetyService } from './safety.service.js';

const INTERVAL_MS = 30_000;

/**
 * Ends location sessions that expired, whose trip ended, whose member left, or whose account
 * was suspended, and clears old SOS locations. Every read and update checks these as well; this
 * is the backstop so nothing is kept longer than it should be.
 */
@Injectable()
export class SafetySweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SafetySweepService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly safety: SafetyService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.runSafely(), INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  private async runSafely(): Promise<void> {
    try {
      await this.safety.sweep();
    } catch (error) {
      this.logger.warn(`Safety sweep failed: ${(error as Error).message}`);
    }
  }
}
