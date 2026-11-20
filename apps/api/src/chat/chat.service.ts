import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  type ChatMessage,
  type ChatPerson,
  type Conversation,
  type PageResponse,
  type ReadState,
} from '@voyago/shared';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { decodeCursor, encodeCursor } from '../common/pagination/cursor.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { CloudinaryService } from '../integrations/cloudinary.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { RedisService } from '../redis/redis.service.js';
import { blockedIds } from '../social/blocks.js';
import { directMessageAllowed } from './message-permission.js';
import { RealtimeService } from './realtime.service.js';

type PageQuery = { limit: number; cursor?: string | undefined };
type ConversationRow = Prisma.ConversationGetPayload<{ include: typeof conversationInclude }>;
type MessageRow = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;

const person = { select: { id: true, username: true, displayName: true } } as const;
const conversationInclude = {
  trip: { select: { id: true, title: true, deletedAt: true } },
  community: { select: { id: true, slug: true, name: true, deletedAt: true } },
} as const;
const messageInclude = { sender: person } as const;

/** Trip members who can use the trip's chat; finished trips stay open for photos and thanks. */
const TRIP_CHAT_STATUSES = ['ACTIVE', 'COMPLETED'] as const;
const MUTED_FOREVER = new Date('9999-12-31T00:00:00Z');
const PREVIEW_LENGTH = 120;

/** What the viewer may do in one conversation, worked out once per request. */
interface Access {
  conversation: ConversationRow;
  userId: string;
  otherUserId: string | null;
  canAnnounce: boolean;
}

export interface SendInput {
  clientId: string;
  body?: string | undefined;
  imageId?: string | undefined;
  announcement?: boolean | undefined;
}

/**
 * Direct, trip and community chats. Who belongs to a group chat follows the trip or community
 * itself (active participants, active members), so leaving or being removed ends access at once;
 * conversation_members rows only hold read position and mute. Admins have no route to read chats:
 * moderation works from what members report.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
    private readonly notifications: NotificationsService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimeService,
  ) {}

  // ── Opening chats ──────────────────────────────────────────────────────────

  async openTrip(userId: string, tripId: string): Promise<Conversation> {
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, deletedAt: null },
      select: { id: true },
    });
    if (!trip) throw new NotFoundException('Trip not found');
    if (!(await this.isTripMember(userId, tripId))) {
      throw new ForbiddenException('Only people on the trip can use its chat');
    }
    const conversation = await this.getOrCreate(
      { type: 'TRIP_GROUP', trip: { connect: { id: tripId } } },
      { tripId },
    );
    return this.view(await this.access(userId, conversation.id));
  }

  async openCommunity(userId: string, slug: string): Promise<Conversation> {
    const community = await this.prisma.community.findFirst({
      where: { slug, deletedAt: null },
      select: { id: true },
    });
    if (!community) throw new NotFoundException('Community not found');
    if (!(await this.isCommunityMember(userId, community.id))) {
      throw new ForbiddenException('Only members can use the community chat');
    }
    const conversation = await this.getOrCreate(
      { type: 'COMMUNITY', community: { connect: { id: community.id } } },
      { communityId: community.id },
    );
    return this.view(await this.access(userId, conversation.id));
  }

  async openDirect(userId: string, username: string): Promise<Conversation> {
    const other = await this.prisma.user.findFirst({
      where: { username: username.toLowerCase(), status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    if (!other || other.id === userId) throw new NotFoundException('Member not found');
    const directKey = [userId, other.id].sort().join(':');
    const existing = await this.prisma.conversation.findUnique({
      where: { directKey },
      select: { id: true },
    });
    if (existing) return this.view(await this.access(userId, existing.id));

    if (!(await directMessageAllowed(this.prisma, userId, other.id))) {
      throw new ForbiddenException('This member is not accepting messages from you');
    }
    const conversation = await this.getOrCreate(
      {
        type: 'DIRECT',
        directKey,
        members: { create: [{ userId }, { userId: other.id }] },
      },
      { directKey },
    );
    return this.view(await this.access(userId, conversation.id));
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  async get(userId: string, conversationId: string): Promise<Conversation> {
    return this.view(await this.access(userId, conversationId));
  }

  /** My chats with at least one message, latest activity first. */
  async list(userId: string, query: PageQuery): Promise<PageResponse<Conversation>> {
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.conversation.findMany({
      where: {
        lastMessageAt: { not: null },
        OR: [
          { type: 'DIRECT', members: { some: { userId, leftAt: null } } },
          {
            type: 'TRIP_GROUP',
            trip: {
              deletedAt: null,
              participants: { some: { userId, status: { in: [...TRIP_CHAT_STATUSES] } } },
            },
          },
          {
            type: 'COMMUNITY',
            community: { deletedAt: null, members: { some: { userId, status: 'ACTIVE' } } },
          },
        ],
        ...(cursor
          ? {
              AND: {
                OR: [
                  { lastMessageAt: { lt: cursor.createdAt } },
                  { lastMessageAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              },
            }
          : {}),
      },
      include: conversationInclude,
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const hasMore = rows.length > query.limit;
    const pageRows = rows.slice(0, query.limit);
    const data: Conversation[] = [];
    for (const conversation of pageRows) {
      data.push(await this.view(await this.accessFor(userId, conversation)));
    }
    const last = pageRows.at(-1);
    return {
      data,
      page: {
        hasMore,
        nextCursor:
          hasMore && last?.lastMessageAt
            ? encodeCursor({ createdAt: last.lastMessageAt, id: last.id })
            : null,
      },
    };
  }

  /** Total unread messages across my 50 most recent chats (for the tab badge). */
  async unreadTotal(userId: string): Promise<number> {
    const page = await this.list(userId, { limit: 50 });
    return page.data.reduce((sum, c) => sum + (c.muted ? 0 : c.unreadCount), 0);
  }

  /** Message history, newest first. Messages from blocked people are left out of group chats. */
  async messages(
    userId: string,
    conversationId: string,
    query: PageQuery,
  ): Promise<PageResponse<ChatMessage>> {
    const access = await this.access(userId, conversationId);
    const cursor = decodeCursor(query.cursor);
    const hidden = await this.hiddenSenders(access);
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        ...this.notFrom(hidden),
        ...(cursor
          ? {
              AND: {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              },
            }
          : {}),
      },
      include: messageInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const hasMore = rows.length > query.limit;
    const pageRows = rows.slice(0, query.limit);
    const last = pageRows.at(-1);
    return {
      data: pageRows.map((row) => this.toMessage(row)),
      page: { hasMore, nextCursor: hasMore && last ? encodeCursor(last) : null },
    };
  }

  // ── Writing ────────────────────────────────────────────────────────────────

  /**
   * Stores and delivers a message. Sending again with the same clientId returns the stored message
   * (`created: false`) without delivering it twice, so a device can safely retry.
   */
  async send(
    userId: string,
    conversationId: string,
    input: SendInput,
  ): Promise<{ message: ChatMessage; created: boolean }> {
    const access = await this.access(userId, conversationId);
    const duplicate = await this.findByClientId(conversationId, userId, input.clientId);
    if (duplicate) return { message: this.toMessage(duplicate), created: false };

    if (
      access.otherUserId &&
      !(await directMessageAllowed(this.prisma, userId, access.otherUserId, conversationId))
    ) {
      throw new ForbiddenException('This member is not accepting messages from you');
    }
    if (input.announcement && !access.canAnnounce) {
      throw new ForbiddenException('Only organisers and moderators can post announcements');
    }
    if (input.imageId) {
      await this.cloudinary.assertOwnUpload(userId, input.imageId, 'chat-photo', 'imageId');
    }
    await this.assertWithinRateLimit(userId);

    let row: MessageRow;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.message.create({
          data: {
            conversationId,
            senderId: userId,
            clientId: input.clientId,
            type: input.imageId ? 'IMAGE' : input.announcement ? 'ANNOUNCEMENT' : 'TEXT',
            body: input.body ?? null,
            attachmentKey: input.imageId ?? null,
          },
          include: messageInclude,
        });
        await tx.conversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: created.createdAt },
        });
        // Your own message counts as read.
        await tx.conversationMember.upsert({
          where: { conversationId_userId: { conversationId, userId } },
          create: { conversationId, userId, lastReadAt: created.createdAt },
          update: { lastReadAt: created.createdAt },
        });
        return created;
      });
    } catch (error) {
      // Two copies of the same retry arrived together: the other one won.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.findByClientId(conversationId, userId, input.clientId);
        if (winner) return { message: this.toMessage(winner), created: false };
      }
      throw error;
    }

    const message = this.toMessage(row);
    const hidden = await blockedIds(this.prisma, userId);
    const recipients = await this.recipientsOf(access, row);
    // Large community chats reach only those with the chat open; others see it next time.
    const direct = access.conversation.type === 'COMMUNITY' ? [] : recipients;
    this.realtime.emitTo(conversationId, [...direct, userId], hidden, 'message:new', message);
    await this.notifyRecipients(access, row, recipients, hidden).catch((error: unknown) => {
      this.logger.warn(`Message notifications failed: ${(error as Error).message}`);
    });
    return { message, created: true };
  }

  /** Moves my read position forward (never back) and tells the others. */
  async markRead(userId: string, conversationId: string, messageId: string): Promise<ReadState> {
    await this.access(userId, conversationId);
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      select: { createdAt: true },
    });
    if (!message) throw new NotFoundException('Message not found');
    await this.prisma.conversationMember.upsert({
      where: { conversationId_userId: { conversationId, userId } },
      create: { conversationId, userId, lastReadAt: message.createdAt },
      update: {},
    });
    // Conditional, so two devices marking at once can't move the position back.
    await this.prisma.conversationMember.updateMany({
      where: {
        conversationId,
        userId,
        OR: [{ lastReadAt: null }, { lastReadAt: { lt: message.createdAt } }],
      },
      data: { lastReadAt: message.createdAt },
    });
    const member = await this.prisma.conversationMember.findUniqueOrThrow({
      where: { conversationId_userId: { conversationId, userId } },
      select: { lastReadAt: true },
    });
    const state = {
      userId,
      lastReadAt: (member.lastReadAt ?? message.createdAt).toISOString(),
    };
    const hidden = await blockedIds(this.prisma, userId);
    this.realtime.emitToConversation(conversationId, hidden, 'message:read', {
      conversationId,
      ...state,
    });
    await this.notifications.markConversationRead(userId, conversationId);
    return state;
  }

  async mute(userId: string, conversationId: string, muted: boolean): Promise<Conversation> {
    await this.access(userId, conversationId);
    await this.prisma.conversationMember.upsert({
      where: { conversationId_userId: { conversationId, userId } },
      create: { conversationId, userId, mutedUntil: muted ? MUTED_FOREVER : null },
      update: { mutedUntil: muted ? MUTED_FOREVER : null },
    });
    return this.get(userId, conversationId);
  }

  /** Deletes one of my own messages for everyone; the text and photo are removed. */
  async deleteMessage(userId: string, messageId: string): Promise<void> {
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, senderId: userId, deletedAt: null },
      select: { id: true, conversationId: true },
    });
    if (!message) throw new NotFoundException('Message not found');
    await this.access(userId, message.conversationId);
    await this.prisma.message.update({
      where: { id: message.id },
      data: { deletedAt: new Date(), body: null, attachmentKey: null },
    });
    this.realtime.emitToConversation(message.conversationId, [], 'message:deleted', {
      conversationId: message.conversationId,
      messageId: message.id,
    });
  }

  // ── Access ─────────────────────────────────────────────────────────────────

  /** The conversation if the user belongs to it; 404 otherwise, so chats can't be probed. */
  async access(userId: string, conversationId: string): Promise<Access> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: conversationInclude,
    });
    if (!conversation) throw new NotFoundException('Chat not found');
    return this.accessFor(userId, conversation);
  }

  private async accessFor(userId: string, conversation: ConversationRow): Promise<Access> {
    const notFound = new NotFoundException('Chat not found');
    if (conversation.type === 'DIRECT') {
      const members = await this.prisma.conversationMember.findMany({
        where: { conversationId: conversation.id, leftAt: null },
        select: { userId: true },
      });
      if (!members.some((m) => m.userId === userId)) throw notFound;
      const other = members.find((m) => m.userId !== userId)?.userId ?? null;
      return { conversation, userId, otherUserId: other, canAnnounce: false };
    }
    if (conversation.type === 'TRIP_GROUP') {
      if (!conversation.trip || conversation.trip.deletedAt) throw notFound;
      const participant = await this.prisma.tripParticipant.findFirst({
        where: {
          tripId: conversation.trip.id,
          userId,
          status: { in: [...TRIP_CHAT_STATUSES] },
        },
        select: { role: true },
      });
      if (!participant) throw notFound;
      return {
        conversation,
        userId,
        otherUserId: null,
        canAnnounce: participant.role === 'ORGANISER' || participant.role === 'CO_ORGANISER',
      };
    }
    if (!conversation.community || conversation.community.deletedAt) throw notFound;
    const member = await this.prisma.communityMember.findFirst({
      where: { communityId: conversation.community.id, userId, status: 'ACTIVE' },
      select: { role: true },
    });
    if (!member) throw notFound;
    return { conversation, userId, otherUserId: null, canAnnounce: member.role !== 'MEMBER' };
  }

  private async isTripMember(userId: string, tripId: string): Promise<boolean> {
    const row = await this.prisma.tripParticipant.findFirst({
      where: { tripId, userId, status: { in: [...TRIP_CHAT_STATUSES] } },
      select: { userId: true },
    });
    return row !== null;
  }

  private async isCommunityMember(userId: string, communityId: string): Promise<boolean> {
    const row = await this.prisma.communityMember.findFirst({
      where: { communityId, userId, status: 'ACTIVE' },
      select: { userId: true },
    });
    return row !== null;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async getOrCreate(
    data: Prisma.ConversationCreateInput,
    unique: Prisma.ConversationWhereUniqueInput,
  ): Promise<{ id: string }> {
    const existing = await this.prisma.conversation.findUnique({
      where: unique,
      select: { id: true },
    });
    if (existing) return existing;
    try {
      return await this.prisma.conversation.create({ data, select: { id: true } });
    } catch (error) {
      // Someone opened the same chat at the same moment.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.prisma.conversation.findUnique({
          where: unique,
          select: { id: true },
        });
        if (winner) return winner;
      }
      throw error;
    }
  }

  private findByClientId(conversationId: string, senderId: string, clientId: string) {
    return this.prisma.message.findFirst({
      where: { conversationId, senderId, clientId },
      include: messageInclude,
    });
  }

  /** Group chats hide messages from people you blocked or who blocked you. */
  private async hiddenSenders(access: Access): Promise<string[]> {
    if (access.conversation.type === 'DIRECT') return [];
    return blockedIds(this.prisma, access.userId);
  }

  private notFrom(hidden: string[]): Prisma.MessageWhereInput {
    if (hidden.length === 0) return {};
    return { OR: [{ senderId: null }, { senderId: { notIn: hidden } }] };
  }

  private async assertWithinRateLimit(userId: string): Promise<void> {
    const key = `chat:rate:${userId}:${Math.floor(Date.now() / 60_000)}`;
    let count: number;
    try {
      count = await this.redis.client.incr(key);
      if (count === 1) await this.redis.client.expire(key, 120);
    } catch (error) {
      // Redis down: let the message through rather than break chat; the HTTP limit still applies.
      this.logger.warn(`Chat rate limit unavailable: ${(error as Error).message}`);
      return;
    }
    if (count > this.config.CHAT_RATE_LIMIT_PER_MINUTE) {
      throw new HttpException(
        'You are sending messages too quickly. Wait a moment.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * In-app notification (and push) for members who are not looking at the chat right now:
   * direct and trip chats on every message, community chats only for announcements. Muted chats
   * and blocked people are skipped.
   */
  /**
   * Who should hear about a message beyond those with the chat open: the other person, everyone
   * on the trip, or (announcements only) every community member. Excludes the sender.
   */
  private async recipientsOf(access: Access, row: MessageRow): Promise<string[]> {
    const { conversation } = access;
    let ids: string[] = [];
    if (conversation.type === 'DIRECT') {
      ids = access.otherUserId ? [access.otherUserId] : [];
    } else if (conversation.type === 'TRIP_GROUP' && conversation.trip) {
      const members = await this.prisma.tripParticipant.findMany({
        where: { tripId: conversation.trip.id, status: 'ACTIVE' },
        select: { userId: true },
      });
      ids = members.map((m) => m.userId);
    } else if (row.type === 'ANNOUNCEMENT' && conversation.community) {
      const members = await this.prisma.communityMember.findMany({
        where: { communityId: conversation.community.id, status: 'ACTIVE' },
        select: { userId: true },
      });
      ids = members.map((m) => m.userId);
    }
    return ids.filter((id) => id !== access.userId);
  }

  private async notifyRecipients(
    access: Access,
    row: MessageRow,
    recipients: string[],
    hidden: string[],
  ) {
    const { conversation } = access;
    if (recipients.length === 0) return;
    const [muted, online] = await Promise.all([
      this.prisma.conversationMember.findMany({
        where: { conversationId: conversation.id, mutedUntil: { gt: new Date() } },
        select: { userId: true },
      }),
      this.realtime.onlineUserIds(conversation.id),
    ]);
    const skip = new Set([
      access.userId,
      ...hidden,
      ...online,
      ...(row.type === 'ANNOUNCEMENT' ? [] : muted.map((m) => m.userId)),
    ]);
    const targets = recipients.filter((id) => !skip.has(id));
    if (targets.length === 0) return;

    const sender = row.sender?.displayName ?? 'Someone';
    const name = this.titleOf(conversation, null);
    const title =
      row.type === 'ANNOUNCEMENT'
        ? `Announcement in ${name}`
        : conversation.type === 'DIRECT'
          ? sender
          : `${sender} in ${name}`;
    const preview = row.body ? row.body.slice(0, PREVIEW_LENGTH) : 'Sent a photo';
    await this.notifications.notifyMessage(targets, conversation.id, { title, body: preview });
  }

  private titleOf(conversation: ConversationRow, other: ChatPerson | null): string {
    if (conversation.type === 'TRIP_GROUP') return conversation.trip?.title ?? 'Trip chat';
    if (conversation.type === 'COMMUNITY') return conversation.community?.name ?? 'Community chat';
    return other?.displayName ?? 'Direct message';
  }

  private async view(access: Access): Promise<Conversation> {
    const { conversation, userId } = access;
    const [member, other, hidden] = await Promise.all([
      this.prisma.conversationMember.findUnique({
        where: { conversationId_userId: { conversationId: conversation.id, userId } },
        select: { lastReadAt: true, mutedUntil: true },
      }),
      access.otherUserId
        ? this.prisma.user.findUnique({ where: { id: access.otherUserId }, ...person })
        : null,
      this.hiddenSenders(access),
    ]);
    const visible = { conversationId: conversation.id, ...this.notFrom(hidden) };
    const [last, unreadCount, readRows, canSend] = await Promise.all([
      this.prisma.message.findFirst({
        where: visible,
        include: messageInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.message.count({
        where: {
          ...visible,
          deletedAt: null,
          NOT: { senderId: userId },
          ...(member?.lastReadAt ? { createdAt: { gt: member.lastReadAt } } : {}),
        },
      }),
      conversation.type === 'COMMUNITY'
        ? []
        : this.prisma.conversationMember.findMany({
            where: {
              conversationId: conversation.id,
              lastReadAt: { not: null },
              ...(hidden.length > 0 ? { userId: { notIn: hidden } } : {}),
            },
            select: { userId: true, lastReadAt: true },
          }),
      access.otherUserId
        ? directMessageAllowed(this.prisma, userId, access.otherUserId, conversation.id)
        : true,
    ]);
    const otherUser = other ? { ...other, avatarUrl: null } : null;
    return {
      id: conversation.id,
      type: conversation.type,
      title: this.titleOf(conversation, otherUser),
      tripId: conversation.trip?.id ?? null,
      communitySlug: conversation.community?.slug ?? null,
      otherUser,
      lastMessage: last ? this.toMessage(last) : null,
      unreadCount,
      muted: (member?.mutedUntil ?? new Date(0)) > new Date(),
      canSend,
      canAnnounce: access.canAnnounce,
      readStates: readRows.flatMap((r) =>
        r.lastReadAt ? [{ userId: r.userId, lastReadAt: r.lastReadAt.toISOString() }] : [],
      ),
    };
  }

  private toMessage(row: MessageRow): ChatMessage {
    const deleted = row.deletedAt !== null;
    return {
      id: row.id,
      conversationId: row.conversationId,
      type: row.type,
      body: deleted ? null : row.body,
      imageUrl:
        !deleted && row.attachmentKey ? this.cloudinary.chatPhotoUrl(row.attachmentKey) : null,
      sender: row.sender ? { ...row.sender, avatarUrl: null } : null,
      clientId: row.clientId,
      deleted,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
