import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type BlockedUser,
  type Connection,
  type CreateReportSchema,
  defaultReportSeverity,
  type PageResponse,
  type ReportTargetType,
} from '@voyago/shared';
import { type z } from 'zod';
import { ChatService } from '../chat/chat.service.js';
import { type AuthUser } from '../common/auth/current-user.decorator.js';
import { decodeCursor, encodeCursor } from '../common/pagination/cursor.js';
import { PrismaService } from '../database/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { blockedIds, isBlockedEitherWay } from './blocks.js';

const person = { select: { id: true, username: true, displayName: true } } as const;

/**
 * Follows, blocks and reports. Blocking is free, needs no reason, and hides each person from the
 * other: profiles, trips, posts and invitations. Blocking also removes follows both ways.
 */
@Injectable()
export class SocialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly chat: ChatService,
  ) {}

  async follow(user: AuthUser, username: string): Promise<void> {
    const target = await this.visibleUser(user, username);
    if (target.id === user.id) throw new ConflictException('You cannot follow yourself');
    const created = await this.prisma.follow.createMany({
      data: [{ followerId: user.id, followeeId: target.id }],
      skipDuplicates: true,
    });
    if (created.count === 1) {
      const me = await this.prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { username: true },
      });
      await this.notifications.notify(this.prisma, [target.id], {
        type: 'NEW_FOLLOWER',
        title: `@${me.username} followed you`,
        body: null,
        data: { username: me.username },
      });
    }
  }

  async unfollow(user: AuthUser, username: string): Promise<void> {
    const target = await this.prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (!target) throw new NotFoundException('Profile not found');
    await this.prisma.follow.deleteMany({ where: { followerId: user.id, followeeId: target.id } });
  }

  followers(user: AuthUser, username: string, query: PageQuery) {
    return this.connections(user, username, 'followers', query);
  }

  following(user: AuthUser, username: string, query: PageQuery) {
    return this.connections(user, username, 'following', query);
  }

  async block(user: AuthUser, username: string): Promise<void> {
    const target = await this.prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (!target) throw new NotFoundException('Profile not found');
    if (target.id === user.id) throw new ConflictException('You cannot block yourself');
    await this.prisma.$transaction(async (tx) => {
      await tx.userBlock.createMany({
        data: [{ blockerId: user.id, blockedId: target.id }],
        skipDuplicates: true,
      });
      await tx.follow.deleteMany({
        where: {
          OR: [
            { followerId: user.id, followeeId: target.id },
            { followerId: target.id, followeeId: user.id },
          ],
        },
      });
      // Open invitations between them are withdrawn.
      await tx.tripInvitation.updateMany({
        where: {
          status: 'PENDING',
          OR: [
            { invitedById: user.id, inviteeId: target.id },
            { invitedById: target.id, inviteeId: user.id },
          ],
        },
        data: { status: 'REVOKED', respondedAt: new Date() },
      });
    });
  }

  async unblock(user: AuthUser, username: string): Promise<void> {
    const target = await this.prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (!target) throw new NotFoundException('Profile not found');
    await this.prisma.userBlock.deleteMany({ where: { blockerId: user.id, blockedId: target.id } });
  }

  async blocks(user: AuthUser): Promise<BlockedUser[]> {
    const rows = await this.prisma.userBlock.findMany({
      where: { blockerId: user.id },
      include: { blocked: person },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rows.map((row) => ({ user: row.blocked, blockedAt: row.createdAt.toISOString() }));
  }

  /**
   * Report a member, trip, community, post or chat message. Repeat reports of the same thing by
   * the same person are merged while the first is unresolved.
   */
  async report(user: AuthUser, input: z.output<typeof CreateReportSchema>) {
    const reportedUserId = await this.reportTarget(user, input.targetType, input.targetId);
    const existing = await this.prisma.report.findFirst({
      where: {
        reporterId: user.id,
        targetType: input.targetType,
        targetId: input.targetId,
        status: { in: ['OPEN', 'IN_REVIEW'] },
      },
      select: { id: true, createdAt: true },
    });
    const report =
      existing ??
      (await this.prisma.report.create({
        data: {
          reporterId: user.id,
          targetType: input.targetType,
          targetId: input.targetId,
          reportedUserId,
          reason: input.reason,
          severity: defaultReportSeverity(input.reason),
          details: input.details ?? null,
        },
        select: { id: true, createdAt: true },
      }));
    return { id: report.id, status: 'OPEN' as const, createdAt: report.createdAt.toISOString() };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** An active member the viewer may see (404 across a block, as for profiles). */
  private async visibleUser(user: AuthUser, username: string) {
    const target = await this.prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        status: true,
        deletedAt: true,
        preferences: { select: { profileVisibility: true } },
      },
    });
    if (
      !target ||
      target.status !== 'ACTIVE' ||
      target.deletedAt ||
      (await isBlockedEitherWay(this.prisma, user.id, target.id))
    ) {
      throw new NotFoundException('Profile not found');
    }
    return target;
  }

  /**
   * Followers or following of a member. Shown when their profile is visible in full to the
   * viewer (public, or followers-only and the viewer follows them). People in a block with the
   * viewer are left out.
   */
  private async connections(
    user: AuthUser,
    username: string,
    which: 'followers' | 'following',
    query: PageQuery,
  ): Promise<PageResponse<Connection>> {
    const target = await this.visibleUser(user, username);
    if (target.id !== user.id) {
      const visibility = target.preferences?.profileVisibility ?? 'PUBLIC';
      const follows =
        visibility === 'FOLLOWERS' &&
        (await this.prisma.follow.count({
          where: { followerId: user.id, followeeId: target.id },
        })) > 0;
      if (visibility === 'PRIVATE' || (visibility === 'FOLLOWERS' && !follows)) {
        throw new ForbiddenException("This member's connections are private");
      }
    }
    const hidden = await blockedIds(this.prisma, user.id);
    const cursor = decodeCursor(query.cursor);
    const other = which === 'followers' ? 'followerId' : 'followeeId';
    const rows = await this.prisma.follow.findMany({
      where: {
        ...(which === 'followers' ? { followeeId: target.id } : { followerId: target.id }),
        [other]: { notIn: hidden },
        ...(which === 'followers'
          ? { follower: { status: 'ACTIVE', deletedAt: null } }
          : { followee: { status: 'ACTIVE', deletedAt: null } }),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, [other]: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      include: { follower: person, followee: person },
      orderBy: [{ createdAt: 'desc' }, { [other]: 'desc' }],
      take: query.limit + 1,
    });
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const people = page.map((row) => (which === 'followers' ? row.follower : row.followee));
    const mine = new Set(
      (
        await this.prisma.follow.findMany({
          where: { followerId: user.id, followeeId: { in: people.map((p) => p.id) } },
          select: { followeeId: true },
        })
      ).map((row) => row.followeeId),
    );
    const last = page.at(-1);
    return {
      data: page.map((row, index) => {
        const someone = people[index] ?? row.follower;
        return {
          user: someone,
          since: row.createdAt.toISOString(),
          isFollowing: mine.has(someone.id),
        };
      }),
      page: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor({
                createdAt: last.createdAt,
                id: which === 'followers' ? last.followerId : last.followeeId,
              })
            : null,
      },
    };
  }

  /** Checks the reported thing exists (and is visible to the reporter); returns who is responsible. */
  private async reportTarget(
    user: AuthUser,
    type: ReportTargetType,
    id: string,
  ): Promise<string | null> {
    const notFound = new NotFoundException('Nothing to report with that id');
    switch (type) {
      case 'USER': {
        if (id === user.id) throw new ConflictException('You cannot report yourself');
        const row = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
        if (!row) throw notFound;
        return row.id;
      }
      case 'TRIP': {
        const row = await this.prisma.trip.findFirst({
          where: { id, deletedAt: null, status: { not: 'DRAFT' } },
          select: { organiserId: true },
        });
        if (!row) throw notFound;
        return row.organiserId;
      }
      case 'COMMUNITY': {
        const row = await this.prisma.community.findFirst({
          where: { id, deletedAt: null },
          select: { members: { where: { role: 'OWNER' }, select: { userId: true } } },
        });
        if (!row) throw notFound;
        return row.members[0]?.userId ?? null;
      }
      case 'POST': {
        const row = await this.prisma.post.findFirst({
          where: { id, deletedAt: null },
          select: { authorId: true },
        });
        if (!row) throw notFound;
        return row.authorId;
      }
      case 'MESSAGE': {
        // Only someone in the chat can report a message from it.
        const row = await this.prisma.message.findFirst({
          where: { id, deletedAt: null },
          select: { senderId: true, conversationId: true },
        });
        if (!row) throw notFound;
        await this.chat.access(user.id, row.conversationId).catch(() => {
          throw notFound;
        });
        if (row.senderId === user.id) throw new ConflictException('You cannot report yourself');
        return row.senderId;
      }
    }
  }
}

type PageQuery = { limit: number; cursor?: string | undefined };
