import { Injectable, NotFoundException } from '@nestjs/common';
import {
  type AppNotification,
  type NotificationsQuerySchema,
  type NotificationType,
  type PageResponse,
} from '@voyago/shared';
import { type z } from 'zod';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { PrismaService } from '../database/prisma.service.js';
import { type Prisma } from '../generated/prisma/client.js';

type Client = Prisma.TransactionClient | PrismaService;

export interface NewNotification {
  type: NotificationType;
  title: string;
  body?: string | null;
  /** Ids for navigation only; never personal data. */
  data?: AppNotification['data'];
}

/**
 * In-app notifications. Writes take an optional transaction so a notification is saved only
 * when the change it describes is. Push and email delivery arrive with milestone 09.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async notify(client: Client, userIds: string[], notification: NewNotification): Promise<void> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return;
    await client.notification.createMany({
      data: unique.map((userId) => ({
        userId,
        type: notification.type,
        title: notification.title.slice(0, 160),
        body: notification.body?.slice(0, 1000) ?? null,
        data: notification.data ?? {},
      })),
    });
  }

  async list(
    userId: string,
    query: z.output<typeof NotificationsQuerySchema>,
  ): Promise<PageResponse<AppNotification>> {
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.notification.findMany({
      where: {
        userId,
        ...(query.unreadOnly ? { readAt: null } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit);
    return {
      data: page.data.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        data: readData(row.data),
        readAt: row.readAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      page: page.page,
    };
  }

  unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  async markRead(userId: string, id: string): Promise<void> {
    const updated = await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { readAt: new Date() },
    });
    if (updated.count === 0) throw new NotFoundException('Notification not found');
  }

  async markAllRead(userId: string): Promise<number> {
    const updated = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return updated.count;
  }
}

const DATA_KEYS = ['tripId', 'joinRequestId', 'invitationId', 'communitySlug', 'username'] as const;

function readData(value: unknown): AppNotification['data'] {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  const data: AppNotification['data'] = {};
  for (const key of DATA_KEYS) {
    const item = record[key];
    if (typeof item === 'string') data[key] = item;
  }
  return data;
}
