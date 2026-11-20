import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  COMMUNITY_ROLE_RANK,
  type CreatePostSchema,
  type FeedItem,
  type PageResponse,
  type Post,
} from '@voyago/shared';
import { type z } from 'zod';
import { type AuthUser } from '../common/auth/current-user.decorator.js';
import { decodeCursor, encodeCursor, toPage } from '../common/pagination/cursor.js';
import { PrismaService } from '../database/prisma.service.js';
import { type Prisma } from '../generated/prisma/client.js';
import { CloudinaryService } from '../integrations/cloudinary.service.js';
import { blockedIds } from '../social/blocks.js';
import { isStaff } from '../trips/trip-view.js';
import { tripSummarySelect, toTripSummaries } from '../trips/trip-summary.js';

export const postInclude = {
  author: { select: { id: true, username: true, displayName: true } },
  community: { select: { id: true, slug: true, name: true } },
  trip: { select: { id: true, title: true, visibility: true, deletedAt: true } },
} as const;
type PostRow = Prisma.PostGetPayload<{ include: typeof postInclude }>;
type PageQuery = { limit: number; cursor?: string | undefined };

/** Trips that appear in the feed: announced (published) and not called off. */
const FEED_TRIP_STATUSES = ['PUBLISHED', 'FULL', 'IN_PROGRESS', 'COMPLETED'] as const;

/**
 * Posts (trip recaps, destination photos, community announcements) and the activity feed.
 * The feed is plain reverse-chronological: posts and published trips from people you follow,
 * your own, and your communities'. Blocked people are left out both ways.
 */
@Injectable()
export class PostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async create(user: AuthUser, input: z.output<typeof CreatePostSchema>): Promise<Post> {
    const imageIds = input.imageIds ?? [];
    if (input.type === 'PHOTO' && imageIds.length === 0) {
      throw invalid('imageIds', 'Add at least one photo');
    }
    let visibility = input.visibility;
    if (input.communityId) {
      if (visibility === 'FOLLOWERS') {
        throw invalid('visibility', 'Community posts are for the community or everyone');
      }
      const membership = await this.prisma.communityMember.findFirst({
        where: {
          communityId: input.communityId,
          userId: user.id,
          status: 'ACTIVE',
          community: { deletedAt: null },
        },
        select: { community: { select: { visibility: true } } },
      });
      if (!membership) throw invalid('communityId', 'Join this community before posting in it');
      // Posts in a private community never leave it.
      if (membership.community.visibility === 'PRIVATE') visibility = 'COMMUNITY';
    }
    if (input.tripId) {
      const trip = await this.prisma.trip.findFirst({
        where: { id: input.tripId, deletedAt: null },
        select: {
          status: true,
          organiserId: true,
          participants: { where: { userId: user.id }, select: { status: true } },
        },
      });
      const was = trip?.participants[0]?.status;
      const onTrip = trip?.organiserId === user.id || was === 'ACTIVE' || was === 'COMPLETED';
      if (!trip || !onTrip) throw invalid('tripId', 'Choose a trip you were on');
      if (input.type === 'TRIP_RECAP' && trip.status !== 'COMPLETED') {
        throw invalid('tripId', 'Recaps are for completed trips');
      }
    }
    for (const id of imageIds) {
      await this.cloudinary.assertOwnUpload(user.id, id, 'post-photo', 'imageIds');
    }
    const row = await this.prisma.post.create({
      data: {
        authorId: user.id,
        type: input.type,
        visibility,
        communityId: input.communityId ?? null,
        tripId: input.tripId ?? null,
        body: input.body || null,
        imageKeys: imageIds,
        placeName: input.placeName ?? null,
      },
      include: postInclude,
    });
    return (await this.toPosts(user, [row]))[0] as Post;
  }

  /** Authors delete their own posts; community moderators and staff any (audited). */
  async remove(user: AuthUser, id: string, requestId?: string): Promise<void> {
    const post = await this.prisma.post.findFirst({
      where: { id, deletedAt: null },
      select: { authorId: true, communityId: true },
    });
    if (!post) throw new NotFoundException('Post not found');
    const own = post.authorId === user.id;
    if (!own) {
      const rank = post.communityId ? await this.communityRank(user.id, post.communityId) : 0;
      if (rank < COMMUNITY_ROLE_RANK.MODERATOR && !isStaff(user)) {
        throw new ForbiddenException('You can only delete your own posts');
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.post.update({ where: { id }, data: { deletedAt: new Date() } });
      if (!own) {
        await tx.auditLog.create({
          data: {
            actorId: user.id,
            actorType: isStaff(user) ? 'ADMIN' : 'USER',
            action: 'post.moderate_delete',
            entityType: 'post',
            entityId: id,
            metadata: { authorId: post.authorId, communityId: post.communityId, role: user.role },
            requestId: requestId ?? null,
          },
        });
      }
    });
  }

  /** A community's posts. Call only after checking the viewer may see the community. */
  async listForCommunity(
    user: AuthUser,
    communityId: string,
    isMember: boolean,
    query: PageQuery,
  ): Promise<PageResponse<Post>> {
    const hidden = await blockedIds(this.prisma, user.id);
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.post.findMany({
      where: {
        communityId,
        deletedAt: null,
        authorId: { notIn: hidden },
        ...(isMember || isStaff(user) ? {} : { visibility: 'PUBLIC' }),
        ...keysetBefore(cursor),
      },
      include: postInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit);
    return { data: await this.toPosts(user, page.data), page: page.page };
  }

  async feed(user: AuthUser, query: PageQuery): Promise<PageResponse<FeedItem>> {
    const cursor = decodeCursor(query.cursor);
    const [hidden, following, memberships] = await Promise.all([
      blockedIds(this.prisma, user.id),
      this.prisma.follow.findMany({ where: { followerId: user.id }, select: { followeeId: true } }),
      this.prisma.communityMember.findMany({
        where: { userId: user.id, status: 'ACTIVE', community: { deletedAt: null } },
        select: { communityId: true },
      }),
    ]);
    const followed = following.map((row) => row.followeeId);
    const communities = memberships.map((row) => row.communityId);
    const liveAuthor = { status: 'ACTIVE', deletedAt: null } as const;
    const openCommunity = { OR: [{ communityId: null }, { community: { deletedAt: null } }] };

    const [posts, trips] = await Promise.all([
      this.prisma.post.findMany({
        where: {
          deletedAt: null,
          authorId: { notIn: hidden },
          author: liveAuthor,
          AND: [
            openCommunity,
            {
              OR: [
                { authorId: user.id },
                { communityId: { in: communities } },
                {
                  authorId: { in: followed },
                  visibility: { in: ['PUBLIC', 'FOLLOWERS'] },
                  OR: [{ communityId: null }, { community: { visibility: 'PUBLIC' } }],
                },
              ],
            },
            keysetBefore(cursor),
          ],
        },
        include: postInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
      this.prisma.trip.findMany({
        where: {
          deletedAt: null,
          hiddenAt: null,
          tripType: 'COMMUNITY_FREE',
          status: { in: [...FEED_TRIP_STATUSES] },
          publishedAt: { not: null },
          organiserId: { notIn: hidden },
          organiser: liveAuthor,
          AND: [
            {
              OR: [
                { organiserId: { in: [user.id, ...followed] }, visibility: 'PUBLIC' },
                {
                  communityId: { in: communities },
                  visibility: { in: ['PUBLIC', 'COMMUNITY'] },
                  community: { deletedAt: null },
                },
              ],
            },
            cursor
              ? {
                  OR: [
                    { publishedAt: { lt: cursor.createdAt } },
                    { publishedAt: cursor.createdAt, id: { lt: cursor.id } },
                  ],
                }
              : {},
          ],
        },
        select: tripSummarySelect,
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
    ]);

    type Entry =
      | { kind: 'post'; at: Date; id: string; row: PostRow }
      | { kind: 'trip'; at: Date; id: string; row: (typeof trips)[number] };
    const merged: Entry[] = [
      ...posts.map((row) => ({ kind: 'post' as const, at: row.createdAt, id: row.id, row })),
      ...trips.map((row) => ({
        kind: 'trip' as const,
        at: row.publishedAt ?? row.departureAt,
        id: row.id,
        row,
      })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const hasMore = merged.length > query.limit;
    const page = merged.slice(0, query.limit);
    const postViews = await this.toPosts(
      user,
      page.flatMap((entry) => (entry.kind === 'post' ? [entry.row] : [])),
    );
    const tripViews = await toTripSummaries(
      this.prisma,
      this.cloudinary,
      page.flatMap((entry) => (entry.kind === 'trip' ? [entry.row] : [])),
    );
    const postById = new Map(postViews.map((post) => [post.id, post]));
    const tripById = new Map(tripViews.map((trip) => [trip.id, trip]));
    const data: FeedItem[] = page.flatMap((entry): FeedItem[] => {
      const at = entry.at.toISOString();
      if (entry.kind === 'post') {
        const post = postById.get(entry.id);
        return post ? [{ kind: 'post', at, post }] : [];
      }
      const trip = tripById.get(entry.id);
      return trip ? [{ kind: 'trip', at, trip }] : [];
    });
    const last = page.at(-1);
    return {
      data,
      page: {
        hasMore,
        nextCursor: hasMore && last ? encodeCursor({ createdAt: last.at, id: last.id }) : null,
      },
    };
  }

  /** Builds post views; `canDelete` needs the viewer's rank in each post's community. */
  async toPosts(user: AuthUser, rows: PostRow[]): Promise<Post[]> {
    const communityIds = [
      ...new Set(rows.flatMap((row) => (row.communityId ? [row.communityId] : []))),
    ];
    const ranks = new Map(
      (communityIds.length === 0
        ? []
        : await this.prisma.communityMember.findMany({
            where: { userId: user.id, status: 'ACTIVE', communityId: { in: communityIds } },
            select: { communityId: true, role: true },
          })
      ).map((row) => [row.communityId, COMMUNITY_ROLE_RANK[row.role]]),
    );
    return rows.map((row) => {
      const own = row.authorId === user.id;
      const moderates =
        row.communityId !== null &&
        (ranks.get(row.communityId) ?? 0) >= COMMUNITY_ROLE_RANK.MODERATOR;
      // Only public trips are named, so a post never reveals a private trip's title.
      const showTrip =
        row.trip !== null &&
        row.trip.deletedAt === null &&
        (own || row.trip.visibility === 'PUBLIC');
      return {
        id: row.id,
        type: row.type,
        visibility: row.visibility,
        body: row.body,
        imageUrls: row.imageKeys.flatMap((key) => {
          const url = this.cloudinary.photoUrl(key);
          return url ? [url] : [];
        }),
        placeName: row.placeName,
        author: row.author,
        community: row.community ? { slug: row.community.slug, name: row.community.name } : null,
        trip: showTrip && row.trip ? { id: row.trip.id, title: row.trip.title } : null,
        createdAt: row.createdAt.toISOString(),
        canDelete: own || moderates || isStaff(user),
      };
    });
  }

  private async communityRank(userId: string, communityId: string): Promise<number> {
    const row = await this.prisma.communityMember.findFirst({
      where: { communityId, userId, status: 'ACTIVE' },
      select: { role: true },
    });
    return row ? COMMUNITY_ROLE_RANK[row.role] : 0;
  }
}

function keysetBefore(cursor: { createdAt: Date; id: string } | undefined) {
  return cursor
    ? {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      }
    : {};
}

function invalid(path: string, message: string) {
  return new BadRequestException({ message: 'Validation failed', details: [{ path, message }] });
}
