import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type CommunitiesQuerySchema,
  type Community,
  type CommunityMember,
  type CommunityMembersQuerySchema,
  type CommunityRole,
  COMMUNITY_ROLE_RANK,
  type CommunityTripsQuerySchema,
  type CreateAnnouncementSchema,
  type CreateCommunitySchema,
  type MembershipStatus,
  type PageResponse,
  type Post,
  type TripSummary,
  type UpdateCommunitySchema,
} from '@voyago/shared';
import { type z } from 'zod';
import { type AuthUser } from '../common/auth/current-user.decorator.js';
import { decodeCursor, encodeCursor, toPage } from '../common/pagination/cursor.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { CloudinaryService } from '../integrations/cloudinary.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { postInclude, PostsService } from '../posts/posts.service.js';
import { blockedIds, isBlockedEitherWay } from '../social/blocks.js';
import { isStaff } from '../trips/trip-view.js';
import { tripSummarySelect, toTripSummaries } from '../trips/trip-summary.js';

type Tx = Prisma.TransactionClient;
type PageQuery = { limit: number; cursor?: string | undefined };
type Row = Prisma.CommunityGetPayload<object>;

const person = { select: { id: true, username: true, displayName: true } } as const;
const { OWNER, ADMIN, MODERATOR } = COMMUNITY_ROLE_RANK;

/** The viewer's place in a community, worked out once per request. */
interface Access {
  community: Row;
  role: CommunityRole | null;
  status: MembershipStatus | null;
  /** 0 unless an active member. */
  rank: number;
  canSeeContent: boolean;
}

/**
 * Communities and their members. Roles are ranked OWNER > ADMIN > MODERATOR > MEMBER; nobody can
 * act on someone at or above their own rank, so nobody can raise their own privileges. Every
 * moderation action is written to the audit log.
 */
@Injectable()
export class CommunitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
    private readonly notifications: NotificationsService,
    private readonly posts: PostsService,
  ) {}

  async create(user: AuthUser, input: z.output<typeof CreateCommunitySchema>): Promise<Community> {
    if (input.coverImageId) {
      await this.cloudinary.assertOwnUpload(
        user.id,
        input.coverImageId,
        'community-cover',
        'coverImageId',
      );
    }
    const visibility = input.visibility ?? 'PUBLIC';
    try {
      await this.prisma.community.create({
        data: {
          name: input.name,
          slug: input.slug,
          description: input.description ?? null,
          category: input.category ?? 'OTHER',
          mode: input.mode ?? null,
          visibility,
          joinPolicy: input.joinPolicy ?? (visibility === 'PRIVATE' ? 'APPROVAL' : 'OPEN'),
          city: input.city ?? null,
          coverImageKey: input.coverImageId ?? null,
          createdById: user.id,
          members: { create: { userId: user.id, role: 'OWNER' } },
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          message: 'This address is taken',
          details: [{ path: 'slug', message: 'Choose another address' }],
        });
      }
      throw error;
    }
    return this.get(user, input.slug);
  }

  async list(
    user: AuthUser,
    query: z.output<typeof CommunitiesQuerySchema>,
  ): Promise<PageResponse<Community>> {
    const cursor = decodeCursor(query.cursor);
    const filters: Prisma.CommunityWhereInput[] = [];
    if (query.q) {
      filters.push({
        OR: [
          { name: { contains: query.q, mode: 'insensitive' } },
          { description: { contains: query.q, mode: 'insensitive' } },
          { city: { contains: query.q, mode: 'insensitive' } },
        ],
      });
    }
    // A community for both modes shows up under either.
    if (query.mode) filters.push({ OR: [{ mode: query.mode }, { mode: null }] });
    if (cursor) {
      filters.push({
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      });
    }
    const rows = await this.prisma.community.findMany({
      where: {
        deletedAt: null,
        ...(query.category ? { category: query.category } : {}),
        ...(query.city ? { city: { equals: query.city, mode: 'insensitive' } } : {}),
        ...(query.mine ? { members: { some: { userId: user.id, status: 'ACTIVE' } } } : {}),
        AND: filters,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit);
    return { data: await this.views(user, page.data), page: page.page };
  }

  async get(user: AuthUser, slug: string): Promise<Community> {
    const { community } = await this.access(user, slug);
    return (await this.views(user, [community]))[0] as Community;
  }

  async update(
    user: AuthUser,
    slug: string,
    input: z.output<typeof UpdateCommunitySchema>,
  ): Promise<Community> {
    const access = await this.access(user, slug);
    requireRank(access, ADMIN, 'Only admins can edit the community');
    const visibility = input.visibility ?? access.community.visibility;
    const joinPolicy = input.joinPolicy ?? access.community.joinPolicy;
    if (visibility === 'PRIVATE' && joinPolicy === 'OPEN') {
      throw new BadRequestException({
        message: 'Validation failed',
        details: [{ path: 'joinPolicy', message: 'Private communities approve each member' }],
      });
    }
    if (input.coverImageId) {
      await this.cloudinary.assertOwnUpload(
        user.id,
        input.coverImageId,
        'community-cover',
        'coverImageId',
      );
    }
    const { coverImageId, ...fields } = input;
    await this.prisma.community.update({
      where: { id: access.community.id },
      data: {
        ...fields,
        ...(coverImageId !== undefined ? { coverImageKey: coverImageId } : {}),
      },
    });
    return this.get(user, slug);
  }

  /** The owner closes the community. Its posts and members stay for the record. */
  async remove(user: AuthUser, slug: string): Promise<void> {
    const access = await this.access(user, slug);
    requireRank(access, OWNER, 'Only the owner can delete the community');
    await this.prisma.community.update({
      where: { id: access.community.id },
      data: { deletedAt: new Date() },
    });
  }

  // ── Membership ────────────────────────────────────────────────────────────

  /** Join an open community, or ask to join one that approves members. */
  async join(user: AuthUser, slug: string, message?: string): Promise<Community> {
    const access = await this.access(user, slug);
    const { community } = access;
    if (access.status === 'ACTIVE') throw new ConflictException('You are already a member');
    if (access.status === 'PENDING') throw new ConflictException('You already asked to join');
    if (access.status === 'BANNED') {
      throw new ForbiddenException('You were banned from this community');
    }
    const owner = await this.ownerId(community.id);
    if (owner && (await isBlockedEitherWay(this.prisma, user.id, owner))) {
      throw new ForbiddenException('You cannot join this community');
    }
    const open = community.joinPolicy === 'OPEN' && community.visibility === 'PUBLIC';
    const status = open ? 'ACTIVE' : 'PENDING';
    await this.prisma.$transaction(async (tx) => {
      await tx.communityMember.upsert({
        where: { communityId_userId: { communityId: community.id, userId: user.id } },
        create: {
          communityId: community.id,
          userId: user.id,
          status,
          message: open ? null : (message ?? null),
        },
        update: {
          status,
          role: 'MEMBER',
          joinedAt: new Date(),
          message: open ? null : (message ?? null),
        },
      });
      if (!open) {
        await this.notifications.notify(tx, await this.managerIds(tx, community.id, MODERATOR), {
          type: 'COMMUNITY_UPDATE',
          title: `New request to join ${community.name}`,
          body: `@${await usernameOf(tx, user.id)} asked to join.`,
          data: { communitySlug: community.slug, username: await usernameOf(tx, user.id) },
        });
      }
    });
    return this.get(user, slug);
  }

  /** Leave, or cancel a pending request. The owner cannot leave. */
  async leave(user: AuthUser, slug: string): Promise<Community> {
    const access = await this.access(user, slug);
    if (access.role === 'OWNER' && access.status === 'ACTIVE') {
      throw new ConflictException('Owners cannot leave; delete the community instead');
    }
    const updated = await this.prisma.communityMember.updateMany({
      where: {
        communityId: access.community.id,
        userId: user.id,
        status: { in: ['ACTIVE', 'PENDING'] },
      },
      data: { status: 'LEFT', role: 'MEMBER' },
    });
    if (updated.count !== 1) throw new ConflictException('You are not a member');
    return this.get(user, slug);
  }

  async members(
    user: AuthUser,
    slug: string,
    query: z.output<typeof CommunityMembersQuerySchema>,
  ): Promise<PageResponse<CommunityMember>> {
    const access = await this.access(user, slug);
    if (query.status === 'ACTIVE') {
      if (!access.canSeeContent) throw membersOnly();
    } else {
      requireRank(access, MODERATOR, 'Only moderators can see requests and bans');
    }
    const hidden = await blockedIds(this.prisma, user.id);
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.communityMember.findMany({
      where: {
        communityId: access.community.id,
        status: query.status,
        userId: { notIn: hidden },
        user: { status: 'ACTIVE', deletedAt: null },
        ...(cursor
          ? {
              OR: [
                { joinedAt: { lt: cursor.createdAt } },
                { joinedAt: cursor.createdAt, userId: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      include: { user: person },
      orderBy: [{ joinedAt: 'desc' }, { userId: 'desc' }],
      take: query.limit + 1,
    });
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    // Notes sent with requests are for moderators only.
    const showMessages = access.rank >= MODERATOR;
    return {
      data: page.map((row) => ({
        user: row.user,
        role: row.role,
        status: row.status,
        message: showMessages ? row.message : null,
        joinedAt: row.joinedAt.toISOString(),
      })),
      page: {
        hasMore,
        nextCursor:
          hasMore && last ? encodeCursor({ createdAt: last.joinedAt, id: last.userId }) : null,
      },
    };
  }

  async approve(user: AuthUser, slug: string, memberId: string, requestId?: string) {
    const access = await this.access(user, slug);
    requireRank(access, MODERATOR, 'Only moderators can approve members');
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.communityMember.updateMany({
        where: { communityId: access.community.id, userId: memberId, status: 'PENDING' },
        data: { status: 'ACTIVE', joinedAt: new Date(), message: null },
      });
      if (updated.count !== 1) throw new NotFoundException('No pending request from this person');
      await audit(tx, user, 'community.member_approve', access, requestId, { memberId });
      await this.notifications.notify(tx, [memberId], {
        type: 'COMMUNITY_UPDATE',
        title: `You're in: ${access.community.name}`,
        body: null,
        data: { communitySlug: access.community.slug },
      });
    });
  }

  async reject(user: AuthUser, slug: string, memberId: string, requestId?: string) {
    const access = await this.access(user, slug);
    requireRank(access, MODERATOR, 'Only moderators can decline requests');
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.communityMember.updateMany({
        where: { communityId: access.community.id, userId: memberId, status: 'PENDING' },
        data: { status: 'REMOVED', message: null },
      });
      if (updated.count !== 1) throw new NotFoundException('No pending request from this person');
      await audit(tx, user, 'community.member_reject', access, requestId, { memberId });
      await this.notifications.notify(tx, [memberId], {
        type: 'COMMUNITY_UPDATE',
        title: `Your request to join ${access.community.name} was declined`,
        body: null,
        data: { communitySlug: access.community.slug },
      });
    });
  }

  /** Admins and the owner change roles below their own rank, never their own. */
  async setRole(
    user: AuthUser,
    slug: string,
    memberId: string,
    role: 'ADMIN' | 'MODERATOR' | 'MEMBER',
    requestId?: string,
  ) {
    const access = await this.access(user, slug);
    requireRank(access, ADMIN, 'Only admins can change roles');
    if (memberId === user.id) throw new ForbiddenException('You cannot change your own role');
    if (COMMUNITY_ROLE_RANK[role] >= access.rank) {
      throw new ForbiddenException('You can only give roles below your own');
    }
    await this.prisma.$transaction(async (tx) => {
      const target = await this.activeMember(tx, access.community.id, memberId);
      if (COMMUNITY_ROLE_RANK[target.role] >= access.rank) {
        throw new ForbiddenException('You cannot change the role of someone at your level');
      }
      await tx.communityMember.update({
        where: { communityId_userId: { communityId: access.community.id, userId: memberId } },
        data: { role },
      });
      await audit(tx, user, 'community.role_change', access, requestId, {
        memberId,
        from: target.role,
        to: role,
      });
    });
  }

  /** Moderators and above remove (or ban) members below their rank. */
  async removeMember(
    user: AuthUser,
    slug: string,
    memberId: string,
    input: { reason?: string | undefined; ban?: boolean | undefined },
    requestId?: string,
  ) {
    const access = await this.access(user, slug);
    requireRank(access, MODERATOR, 'Only moderators can remove members');
    if (memberId === user.id) throw new ConflictException('Leave the community instead');
    await this.prisma.$transaction(async (tx) => {
      const target = await this.activeMember(tx, access.community.id, memberId);
      if (COMMUNITY_ROLE_RANK[target.role] >= access.rank) {
        throw new ForbiddenException('You cannot remove someone at your level');
      }
      await tx.communityMember.update({
        where: { communityId_userId: { communityId: access.community.id, userId: memberId } },
        data: { status: input.ban ? 'BANNED' : 'REMOVED', role: 'MEMBER' },
      });
      await audit(
        tx,
        user,
        input.ban ? 'community.member_ban' : 'community.member_remove',
        access,
        requestId,
        { memberId, reason: input.reason ?? null, role: target.role },
      );
      await this.notifications.notify(tx, [memberId], {
        type: 'COMMUNITY_UPDATE',
        title: `You were removed from ${access.community.name}`,
        body: input.reason ? `The moderators said: ${input.reason}` : null,
        data: { communitySlug: access.community.slug },
      });
    });
  }

  async unban(user: AuthUser, slug: string, memberId: string, requestId?: string) {
    const access = await this.access(user, slug);
    requireRank(access, ADMIN, 'Only admins can lift bans');
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.communityMember.updateMany({
        where: { communityId: access.community.id, userId: memberId, status: 'BANNED' },
        data: { status: 'REMOVED' },
      });
      if (updated.count !== 1) throw new NotFoundException('This person is not banned');
      await audit(tx, user, 'community.member_unban', access, requestId, { memberId });
    });
  }

  // ── Content ───────────────────────────────────────────────────────────────

  async trips(
    user: AuthUser,
    slug: string,
    query: z.output<typeof CommunityTripsQuerySchema>,
  ): Promise<PageResponse<TripSummary>> {
    const access = await this.access(user, slug);
    if (!access.canSeeContent) throw membersOnly();
    const hidden = await blockedIds(this.prisma, user.id);
    const cursor = decodeCursor(query.cursor);
    const upcoming = query.when === 'upcoming';
    const rows = await this.prisma.trip.findMany({
      where: {
        communityId: access.community.id,
        deletedAt: null,
        tripType: 'COMMUNITY_FREE',
        // Only members see COMMUNITY trips, even in a public community.
        visibility: access.rank > 0 || isStaff(user) ? { in: ['PUBLIC', 'COMMUNITY'] } : 'PUBLIC',
        status: upcoming ? { in: ['PUBLISHED', 'FULL', 'IN_PROGRESS'] } : 'COMPLETED',
        organiserId: { notIn: hidden },
        ...(cursor
          ? upcoming
            ? {
                OR: [
                  { departureAt: { gt: cursor.createdAt } },
                  { departureAt: cursor.createdAt, id: { gt: cursor.id } },
                ],
              }
            : {
                OR: [
                  { departureAt: { lt: cursor.createdAt } },
                  { departureAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
          : {}),
      },
      select: tripSummarySelect,
      orderBy: upcoming
        ? [{ departureAt: 'asc' }, { id: 'asc' }]
        : [{ departureAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: await toTripSummaries(this.prisma, this.cloudinary, page),
      page: {
        hasMore,
        nextCursor:
          hasMore && last ? encodeCursor({ createdAt: last.departureAt, id: last.id }) : null,
      },
    };
  }

  async postsFor(user: AuthUser, slug: string, query: PageQuery): Promise<PageResponse<Post>> {
    const access = await this.access(user, slug);
    if (!access.canSeeContent) throw membersOnly();
    return this.posts.listForCommunity(user, access.community.id, access.rank > 0, query);
  }

  /** Moderators and above post announcements; members are notified in the app. */
  async announce(
    user: AuthUser,
    slug: string,
    input: z.output<typeof CreateAnnouncementSchema>,
  ): Promise<Post> {
    const access = await this.access(user, slug);
    requireRank(access, MODERATOR, 'Only moderators can post announcements');
    const { community } = access;
    const visibility =
      input.membersOnly || community.visibility === 'PRIVATE' ? 'COMMUNITY' : 'PUBLIC';
    const post = await this.prisma.$transaction(async (tx) => {
      const created = await tx.post.create({
        data: {
          authorId: user.id,
          type: 'ANNOUNCEMENT',
          visibility,
          communityId: community.id,
          body: input.body,
        },
        include: postInclude,
      });
      const members = await tx.communityMember.findMany({
        where: { communityId: community.id, status: 'ACTIVE', userId: { not: user.id } },
        select: { userId: true },
      });
      await this.notifications.notify(
        tx,
        members.map((member) => member.userId),
        {
          type: 'COMMUNITY_UPDATE',
          title: `Announcement in ${community.name}`,
          body: input.body.slice(0, 200),
          data: { communitySlug: community.slug },
        },
      );
      return created;
    });
    return (await this.posts.toPosts(user, [post]))[0] as Post;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** The community (404 if missing or deleted) and the viewer's membership. */
  private async access(user: AuthUser, slug: string): Promise<Access> {
    const community = await this.prisma.community.findFirst({
      where: { slug, deletedAt: null },
    });
    if (!community) throw new NotFoundException('Community not found');
    const membership = await this.prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId: community.id, userId: user.id } },
      select: { role: true, status: true },
    });
    const active = membership?.status === 'ACTIVE';
    return {
      community,
      role: active ? membership.role : null,
      status: membership?.status ?? null,
      rank: active ? COMMUNITY_ROLE_RANK[membership.role] : 0,
      canSeeContent: community.visibility === 'PUBLIC' || active || isStaff(user),
    };
  }

  private async views(user: AuthUser, rows: Row[]): Promise<Community[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const [counts, owners, mine] = await Promise.all([
      this.prisma.communityMember.groupBy({
        by: ['communityId'],
        where: { communityId: { in: ids }, status: 'ACTIVE' },
        _count: { _all: true },
      }),
      this.prisma.communityMember.findMany({
        where: { communityId: { in: ids }, role: 'OWNER' },
        select: { communityId: true, user: person },
      }),
      this.prisma.communityMember.findMany({
        where: { communityId: { in: ids }, userId: user.id },
        select: { communityId: true, role: true, status: true },
      }),
    ]);
    const countOf = new Map(counts.map((row) => [row.communityId, row._count._all]));
    const ownerOf = new Map(owners.map((row) => [row.communityId, row.user]));
    const mineOf = new Map(mine.map((row) => [row.communityId, row]));
    return rows.flatMap((row) => {
      const owner = ownerOf.get(row.id);
      if (!owner) return [];
      const membership = mineOf.get(row.id);
      const active = membership?.status === 'ACTIVE';
      const rank = active ? COMMUNITY_ROLE_RANK[membership.role] : 0;
      const actions: Community['viewer']['actions'] = [];
      if (!membership || ['LEFT', 'REMOVED'].includes(membership.status)) {
        actions.push(row.joinPolicy === 'OPEN' && row.visibility === 'PUBLIC' ? 'join' : 'request');
      }
      if (membership?.status === 'PENDING') actions.push('cancel_request');
      if (active && membership.role !== 'OWNER') actions.push('leave');
      if (rank >= ADMIN) actions.push('edit');
      if (rank >= MODERATOR) actions.push('moderate', 'announce');
      return [
        {
          id: row.id,
          slug: row.slug,
          name: row.name,
          description: row.description,
          category: row.category,
          mode: row.mode,
          visibility: row.visibility,
          joinPolicy: row.joinPolicy,
          city: row.city,
          coverImageUrl: this.cloudinary.coverUrl(row.coverImageKey),
          memberCount: countOf.get(row.id) ?? 0,
          owner,
          createdAt: row.createdAt.toISOString(),
          viewer: {
            role: active ? membership.role : null,
            status: membership?.status ?? null,
            canSeeContent: row.visibility === 'PUBLIC' || active || isStaff(user),
            actions,
          },
        },
      ];
    });
  }

  private async ownerId(communityId: string): Promise<string | null> {
    const owner = await this.prisma.communityMember.findFirst({
      where: { communityId, role: 'OWNER' },
      select: { userId: true },
    });
    return owner?.userId ?? null;
  }

  private async managerIds(tx: Tx, communityId: string, minRank: number): Promise<string[]> {
    const rows = await tx.communityMember.findMany({
      where: { communityId, status: 'ACTIVE' },
      select: { userId: true, role: true },
    });
    return rows.filter((row) => COMMUNITY_ROLE_RANK[row.role] >= minRank).map((row) => row.userId);
  }

  private async activeMember(tx: Tx, communityId: string, userId: string) {
    const target = await tx.communityMember.findUnique({
      where: { communityId_userId: { communityId, userId } },
      select: { role: true, status: true },
    });
    if (target?.status !== 'ACTIVE') throw new NotFoundException('This person is not a member');
    return target;
  }
}

function requireRank(access: Access, min: number, message: string): void {
  if (access.rank < min) {
    // Outsiders of a private community learn nothing more than its public card.
    if (!access.canSeeContent) throw membersOnly();
    throw new ForbiddenException(message);
  }
}

function membersOnly() {
  return new ForbiddenException('Only members can see this community');
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

async function usernameOf(tx: Tx, userId: string): Promise<string> {
  const row = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { username: true },
  });
  return row.username;
}

async function audit(
  tx: Tx,
  user: AuthUser,
  action: string,
  access: Access,
  requestId: string | undefined,
  metadata: Prisma.InputJsonObject,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorId: user.id,
      actorType: 'USER',
      action,
      entityType: 'community',
      entityId: access.community.id,
      metadata: { ...metadata, actorRole: access.role },
      requestId: requestId ?? null,
    },
  });
}
