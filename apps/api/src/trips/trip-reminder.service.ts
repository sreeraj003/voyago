import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';

/** Members are reminded once, this long before departure. */
export const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;
const INTERVAL_MS = 15 * 60 * 1000;

/**
 * Sends the "your trip is tomorrow" reminder. Each trip is claimed with a conditional update of
 * `reminder_sent_at`, so several API instances never send it twice.
 */
@Injectable()
export class TripReminderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TripReminderService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.runSafely(), INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async sendDue(now = new Date()): Promise<number> {
    const claimed = await this.prisma.$queryRaw<{ id: string; title: string }[]>`
      UPDATE "trips" SET "reminder_sent_at" = ${now}
      WHERE "reminder_sent_at" IS NULL AND "deleted_at" IS NULL
        AND "status" IN ('PUBLISHED', 'FULL')
        AND "departure_at" > ${now}
        AND "departure_at" <= ${new Date(now.getTime() + REMINDER_LEAD_MS)}
      RETURNING "id", "title"`;
    for (const trip of claimed) {
      const members = await this.prisma.tripParticipant.findMany({
        where: { tripId: trip.id, status: 'ACTIVE' },
        select: { userId: true },
      });
      await this.notifications.notify(
        this.prisma,
        members.map((m) => m.userId),
        {
          type: 'TRIP_REMINDER',
          title: `${trip.title} is coming up`,
          body: 'It departs within 24 hours. Check the meeting point and what to bring.',
          data: { tripId: trip.id },
        },
      );
    }
    return claimed.length;
  }

  private async runSafely(): Promise<void> {
    try {
      await this.sendDue();
    } catch (error) {
      this.logger.warn(`Trip reminders failed: ${(error as Error).message}`);
    }
  }
}
