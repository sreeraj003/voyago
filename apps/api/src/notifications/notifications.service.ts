import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  type AppNotification,
  type NotificationsQuerySchema,
  type NotificationType,
  type PageResponse,
} from '@voyago/shared';
import { type z } from 'zod';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PUSH_SENDER, type PushSender } from './push/push-sender.js';

type Client = Prisma.TransactionClient | PrismaService;

export interface NewNotification {
  type: NotificationType;
  title: string;
  body?: string | null;
  /** Ids for navigation only; never personal data. */
  data?: AppNotification['data'];
}

/**
 * In-app notifications, each also pushed to the member's devices when a push provider is set up.
 * Writes take an optional transaction so a notification (and its push) exists only when the change
 * it describes does; PushDispatcherService sends the pushes after commit.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PUSH_SENDER) private readonly push: PushSender,
  ) {}

  async notify(client: Client, userIds: string[], notification: NewNotification): Promise<void> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return;
    const pushPendingAt = this.push.enabled ? new Date() : null;
    await client.notification.createMany({
      data: unique.map((userId) => ({
        userId,
        type: notification.type,
        title: notification.title.slice(0, 160),
        body: notification.body?.slice(0, 1000) ?? null,
        data: notification.data ?? {},
        pushPendingAt,
      })),
    });
  }

  /**
   * One unread "new message" notification per member and chat: a further message updates it
   * (and pushes again) instead of adding another row.
   */
  async notifyMessage(
    userIds: string[],
    conversationId: string,
    notification: Omit<NewNotification, 'type' | 'data'>,
  ): Promise<void> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return;
    const title = notification.title.slice(0, 160);
    const body = notification.body?.slice(0, 1000) ?? null;
    const pushPendingAt = this.push.enabled ? new Date() : null;
    const updated = await this.prisma.$queryRaw<{ user_id: string }[]>`
      UPDATE "notifications"
      SET "title" = ${title}, "body" = ${body}, "created_at" = now(), "push_pending_at" = ${pushPendingAt}
      WHERE "user_id" = ANY(${unique}::uuid[]) AND "type" = 'NEW_MESSAGE' AND "read_at" IS NULL
        AND "data"->>'conversationId' = ${conversationId}
      RETURNING "user_id"`;
    const done = new Set(updated.map((row) => row.user_id));
    const rest = unique.filter((id) => !done.has(id));
    if (rest.length === 0) return;
    await this.prisma.notification.createMany({
      data: rest.map((userId) => ({
        userId,
        type: 'NEW_MESSAGE' as const,
        title,
        body,
        data: { conversationId } satisfies Prisma.InputJsonObject,
        pushPendingAt,
      })),
    });
  }

  /** Reading a chat clears its "new message" notification. */
  async markConversationRead(userId: string, conversationId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: {
        userId,
        type: 'NEW_MESSAGE',
        readAt: null,
        data: { path: ['conversationId'], equals: conversationId },
      },
      data: { readAt: new Date(), pushPendingAt: null },
    });
  }

  /** Registers a device; a token that moves to another account (shared phone) moves with it. */
  async registerPushToken(userId: string, token: string, platform: 'IOS' | 'ANDROID') {
    await this.prisma.pushToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform, lastSeenAt: new Date() },
    });
  }

  async removePushToken(userId: string, token: string): Promise<void> {
    await this.prisma.pushToken.deleteMany({ where: { userId, token } });
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

  /** Unread notifications other than chat messages, which the chat list already counts. */
  unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { userId, readAt: null, type: { not: 'NEW_MESSAGE' } },
    });
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

const DATA_KEYS = [
  'tripId',
  'joinRequestId',
  'invitationId',
  'communitySlug',
  'username',
  'conversationId',
  'packageId',
] as const;

function readData(value: unknown): AppNotification['data'] {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  const data: AppNotification['data'] = {};
  for (const key of DATA_KEYS) {
    const item = record[key];
    if (typeof item === 'string') data[key] = item;
  }
  if (record.screen === 'safety' || record.screen === 'questions') data.screen = record.screen;
  return data;
}
