import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { JobMonitor } from '../observability/job-monitor.service.js';

/** Published trips that never started are expired this long after their departure time. */
export const EXPIRY_GRACE_MS = 24 * 60 * 60 * 1000;
const INTERVAL_MS = 15 * 60 * 1000;

/**
 * Moves PUBLISHED / FULL trips that were never started to EXPIRED and closes their pending
 * join requests. Runs every 15 minutes in each API instance through the job monitor (see
 * /admin/system); the conditional update makes concurrent runs harmless.
 */
@Injectable()
export class TripExpiryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TripExpiryService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobMonitor,
  ) {}

  onModuleInit(): void {
    this.timer = this.jobs.every(
      'trip-expiry',
      'Expires published trips that never started',
      INTERVAL_MS,
      () => this.expireOverdue(),
    );
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
    // Requests to trips that can no longer take people are closed (also covers older rows).
    await this.prisma.tripJoinRequest.updateMany({
      where: {
        status: 'PENDING',
        trip: { status: { in: ['EXPIRED', 'CANCELLED', 'IN_PROGRESS', 'COMPLETED'] } },
      },
      data: { status: 'CANCELLED', decidedAt: now },
    });
    return result.count;
  }
}
