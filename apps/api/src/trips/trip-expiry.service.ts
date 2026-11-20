import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';

/** Published trips that never started are expired this long after their departure time. */
export const EXPIRY_GRACE_MS = 24 * 60 * 60 * 1000;
const INTERVAL_MS = 15 * 60 * 1000;

/**
 * Moves PUBLISHED / FULL trips that were never started to EXPIRED. Runs every 15 minutes in
 * each API instance; the conditional update makes concurrent runs harmless. A dedicated job
 * runner replaces this in milestone 15.
 */
@Injectable()
export class TripExpiryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TripExpiryService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.runSafely(), INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async expireOverdue(now = new Date()): Promise<number> {
    const result = await this.prisma.trip.updateMany({
      where: {
        status: { in: ['PUBLISHED', 'FULL'] },
        deletedAt: null,
        departureAt: { lt: new Date(now.getTime() - EXPIRY_GRACE_MS) },
      },
      data: { status: 'EXPIRED' },
    });
    if (result.count > 0) this.logger.log(`Expired ${result.count} trips that never started`);
    return result.count;
  }

  private async runSafely(): Promise<void> {
    try {
      await this.expireOverdue();
    } catch (error) {
      this.logger.warn(`Trip expiry failed: ${(error as Error).message}`);
    }
  }
}
