import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ACCOUNT_DELETION_ERASED,
  ACCOUNT_DELETION_KEPT,
  type AccountDeletionStatus,
  DELETE_RECENT_SIGN_IN_MINUTES,
  type DeleteAccountInput,
  type DeletionBlocker,
} from '@voyago/shared';
import { PasswordService } from '../auth/password.service.js';
import { RealtimeService } from '../chat/realtime.service.js';
import { type AuthUser } from '../common/auth/current-user.decorator.js';
import { PrismaService } from '../database/prisma.service.js';
import { AnalyticsService } from '../observability/analytics.service.js';
import { syncCapacityStatus } from '../trips/trips.service.js';

/** Upper bounds on what one export holds, newest first; the totals say if anything was left out. */
const EXPORT_LIMIT = 5_000;

const RUNNING_TRIP = ['PUBLISHED', 'FULL', 'IN_PROGRESS'] as const;
const LIVE_SUBSCRIPTION = ['PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE'] as const;

/**
 * Account deletion and data export (DPDP Act rights to erasure and access).
 *
 * Deletion keeps the `users` row, because bookings, payments, the ledger, messages and moderation
 * records point at it and some must be kept by law. Everything that identifies the member is
 * erased or deleted in one transaction, they are signed out everywhere, and the row is marked
 * deleted so it can never sign in or be found again.
 */
@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly realtime: RealtimeService,
    private readonly analytics: AnalyticsService,
  ) {}

  async deletionStatus(user: AuthUser): Promise<AccountDeletionStatus> {
    const [blockers, account] = await Promise.all([
      this.blockers(user),
      this.prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { passwordHash: true },
      }),
    ]);
    return {
      canDelete: blockers.length === 0,
      blockers,
      passwordRequired: account.passwordHash !== null,
      erased: [...ACCOUNT_DELETION_ERASED],
      kept: [...ACCOUNT_DELETION_KEPT],
    };
  }

  async deleteAccount(
    user: AuthUser,
    input: DeleteAccountInput,
    requestId: string | null,
  ): Promise<void> {
    await this.confirmIdentity(user, input.password);
    const blockers = await this.blockers(user);
    if (blockers.length > 0) {
      throw new ConflictException({
        message: 'Your account can’t be deleted yet',
        details: blockers.map((b) => ({ path: b.code, message: b.message })),
      });
    }

    const now = new Date();
    const id = user.id;
    await this.prisma.$transaction(async (tx) => {
      // Lock the row so a parallel request can't create something new meanwhile.
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const marked = await tx.user.updateMany({
        where: { id, deletedAt: null },
        data: {
          username: `deleted_${id.replace(/-/g, '').slice(0, 16)}`,
          displayName: 'Deleted member',
          email: null,
          phone: null,
          passwordHash: null,
          emailVerifiedAt: null,
          phoneVerifiedAt: null,
          bio: null,
          avatarKey: null,
          homeCity: null,
          languages: [],
          accentColor: null,
          profileHeadline: null,
          status: 'DEACTIVATED',
          deletedAt: now,
        },
      });
      if (marked.count !== 1) throw new ConflictException('This account is already deleted');

      // Places on trips that haven't ended are given up, as if the member had left.
      const places = await tx.tripParticipant.findMany({
        where: { userId: id, status: 'ACTIVE', trip: { status: { in: [...RUNNING_TRIP] } } },
        select: { tripId: true },
      });
      await tx.tripParticipant.updateMany({
        where: { userId: id, status: 'ACTIVE', tripId: { in: places.map((p) => p.tripId) } },
        data: { status: 'LEFT', leftAt: now },
      });
      for (const { tripId } of places) await syncCapacityStatus(tx, tripId);
      await tx.tripJoinRequest.updateMany({
        where: { userId: id, status: 'PENDING' },
        data: { status: 'WITHDRAWN', decidedAt: now },
      });
      await tx.tripInvitation.updateMany({
        where: { inviteeId: id, status: 'PENDING' },
        data: { status: 'DECLINED', respondedAt: now },
      });
      await tx.locationSession.updateMany({
        where: { userId: id, status: 'ACTIVE' },
        data: { status: 'ENDED', endedAt: now, endReason: 'account_deleted' },
      });
      await tx.post.updateMany({
        where: { authorId: id, deletedAt: null },
        data: { deletedAt: now },
      });

      await Promise.all([
        tx.authSession.deleteMany({ where: { userId: id } }),
        tx.authIdentity.deleteMany({ where: { userId: id } }),
        tx.verificationToken.deleteMany({ where: { userId: id } }),
        tx.pushToken.deleteMany({ where: { userId: id } }),
        tx.notification.deleteMany({ where: { userId: id } }),
        tx.emergencyContact.deleteMany({ where: { userId: id } }),
        tx.motorcycle.deleteMany({ where: { ownerId: id } }),
        tx.savedSearch.deleteMany({ where: { userId: id } }),
        tx.userPreference.deleteMany({ where: { userId: id } }),
        tx.follow.deleteMany({ where: { OR: [{ followerId: id }, { followeeId: id }] } }),
        tx.userBlock.deleteMany({ where: { OR: [{ blockerId: id }, { blockedId: id }] } }),
        tx.review.deleteMany({ where: { OR: [{ reviewerId: id }, { revieweeId: id }] } }),
        tx.communityMember.deleteMany({ where: { userId: id } }),
      ]);
      await tx.auditLog.create({
        data: {
          actorId: id,
          actorType: 'USER',
          action: 'user.self_delete',
          entityType: 'user',
          entityId: id,
          metadata: { tripsLeft: places.length },
          requestId,
        },
      });
    });
    await this.analytics.forget([id]);
    this.realtime.disconnectUser(id);
  }

  /** Everything Voyago holds about the member, as JSON they can keep. */
  async exportData(user: AuthUser) {
    const id = user.id;
    const take = EXPORT_LIMIT;
    const newest = { createdAt: 'desc' } as const;
    const db = this.prisma;
    const [
      profile,
      preferences,
      motorcycles,
      emergencyContacts,
      identities,
      sessions,
      organisedTrips,
      participations,
      joinRequests,
      invitations,
      communities,
      following,
      followers,
      blocked,
      posts,
      messages,
      messageCount,
      reviews,
      reports,
      bookings,
      payments,
      subscriptions,
      savedSearches,
      notifications,
      events,
    ] = await Promise.all([
      db.user.findUniqueOrThrow({
        where: { id },
        select: {
          id: true,
          username: true,
          displayName: true,
          email: true,
          emailVerifiedAt: true,
          phone: true,
          phoneVerifiedAt: true,
          bio: true,
          homeCity: true,
          country: true,
          languages: true,
          role: true,
          status: true,
          accentColor: true,
          profileHeadline: true,
          lastActiveAt: true,
          profileCompletedAt: true,
          createdAt: true,
        },
      }),
      db.userPreference.findUnique({
        where: { userId: id },
        omit: { userId: true },
      }),
      db.motorcycle.findMany({ where: { ownerId: id }, omit: { ownerId: true, photoKey: true } }),
      db.emergencyContact.findMany({ where: { userId: id }, omit: { userId: true } }),
      db.authIdentity.findMany({
        where: { userId: id },
        select: { provider: true, email: true, createdAt: true },
      }),
      db.authSession.findMany({
        where: { userId: id },
        select: {
          userAgent: true,
          createdAt: true,
          lastUsedAt: true,
          expiresAt: true,
          revokedAt: true,
        },
        orderBy: newest,
        take: 200,
      }),
      db.trip.findMany({
        where: { organiserId: id },
        select: {
          id: true,
          title: true,
          mode: true,
          activityType: true,
          status: true,
          originName: true,
          destinationName: true,
          departureAt: true,
          returnAt: true,
          createdAt: true,
        },
        orderBy: newest,
        take,
      }),
      db.tripParticipant.findMany({
        where: { userId: id },
        select: {
          role: true,
          status: true,
          joinedAt: true,
          leftAt: true,
          trip: { select: { id: true, title: true, departureAt: true, status: true } },
        },
        take,
      }),
      db.tripJoinRequest.findMany({
        where: { userId: id },
        select: { tripId: true, status: true, message: true, createdAt: true, decidedAt: true },
        orderBy: newest,
        take,
      }),
      db.tripInvitation.findMany({
        where: { inviteeId: id },
        select: { tripId: true, status: true, createdAt: true, respondedAt: true },
        take,
      }),
      db.communityMember.findMany({
        where: { userId: id },
        select: {
          role: true,
          status: true,
          joinedAt: true,
          community: { select: { slug: true, name: true } },
        },
      }),
      db.follow.findMany({
        where: { followerId: id },
        select: { createdAt: true, followee: { select: { username: true } } },
        take,
      }),
      db.follow.findMany({
        where: { followeeId: id },
        select: { createdAt: true, follower: { select: { username: true } } },
        take,
      }),
      db.userBlock.findMany({
        where: { blockerId: id },
        select: { createdAt: true, blocked: { select: { username: true } } },
      }),
      db.post.findMany({
        where: { authorId: id },
        select: {
          id: true,
          body: true,
          createdAt: true,
          deletedAt: true,
          communityId: true,
          tripId: true,
        },
        orderBy: newest,
        take,
      }),
      db.message.findMany({
        where: { senderId: id },
        select: { conversationId: true, body: true, createdAt: true, deletedAt: true },
        orderBy: newest,
        take,
      }),
      db.message.count({ where: { senderId: id } }),
      db.review.findMany({
        where: { reviewerId: id },
        omit: { reviewerId: true },
        take,
      }),
      db.report.findMany({
        // Reports they filed, as filed; moderators' notes and reports about them are not included.
        where: { reporterId: id },
        select: { targetType: true, reason: true, details: true, status: true, createdAt: true },
        orderBy: newest,
        take,
      }),
      db.booking.findMany({
        where: { userId: id },
        select: {
          id: true,
          status: true,
          seats: true,
          totalAmountPaise: true,
          refundedAmountPaise: true,
          currency: true,
          confirmedAt: true,
          cancelledAt: true,
          createdAt: true,
          package: { select: { title: true } },
        },
        orderBy: newest,
        take,
      }),
      db.payment.findMany({
        where: { userId: id },
        select: {
          id: true,
          amountPaise: true,
          refundedAmountPaise: true,
          currency: true,
          status: true,
          method: true,
          capturedAt: true,
          createdAt: true,
        },
        orderBy: newest,
        take,
      }),
      db.subscription.findMany({
        where: { userId: id },
        select: {
          status: true,
          pricePaise: true,
          currency: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          cancelledAt: true,
          createdAt: true,
          plan: { select: { name: true } },
        },
      }),
      db.savedSearch.findMany({
        where: { userId: id },
        select: { name: true, query: true, alerts: true, createdAt: true },
      }),
      db.notification.findMany({
        where: { userId: id },
        select: { type: true, title: true, body: true, createdAt: true, readAt: true },
        orderBy: newest,
        take: 500,
      }),
      db.analyticsEvent.findMany({
        where: { actorKey: this.analytics.actorKey(id) },
        select: { name: true, properties: true, occurredAt: true },
        orderBy: { occurredAt: 'desc' },
        take,
      }),
    ]);

    return {
      format: 'voyago-export-v1',
      exportedAt: new Date().toISOString(),
      notes: [
        `Lists hold up to ${EXPORT_LIMIT} items each, newest first.`,
        'Live location is never stored after sharing ends, so it is not included.',
        'Amounts are in paise (1 rupee = 100 paise).',
      ],
      profile,
      preferences,
      motorcycles,
      emergencyContacts,
      signInMethods: identities,
      sessions,
      trips: { organised: organisedTrips, joined: participations, joinRequests, invitations },
      communities,
      social: {
        following: following.map((f) => ({ username: f.followee.username, since: f.createdAt })),
        followers: followers.map((f) => ({ username: f.follower.username, since: f.createdAt })),
        blocked: blocked.map((b) => ({ username: b.blocked.username, since: b.createdAt })),
      },
      posts,
      messages: { total: messageCount, items: messages },
      reviews,
      reportsFiled: reports,
      bookings,
      payments,
      subscriptions,
      savedSearches,
      notifications,
      analyticsEvents: events,
    };
  }

  private async confirmIdentity(user: AuthUser, password: string | undefined): Promise<void> {
    const account = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    if (account.passwordHash) {
      if (!password || !(await this.passwords.verify(account.passwordHash, password))) {
        throw new UnauthorizedException('The password is not right');
      }
      return;
    }
    // No password (phone or Google/Apple sign-in): the sign-in must be recent.
    const signIn = await this.prisma.authSession.findFirst({
      where: { familyId: user.sessionFamilyId, userId: user.id },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    const since = Date.now() - DELETE_RECENT_SIGN_IN_MINUTES * 60_000;
    if (!signIn || signIn.createdAt.getTime() < since) {
      throw new ForbiddenException({
        message: `Sign in again, then delete your account within ${DELETE_RECENT_SIGN_IN_MINUTES} minutes`,
        details: [{ path: 'reauthenticate', message: 'A recent sign-in is required' }],
      });
    }
  }

  private async blockers(user: AuthUser): Promise<DeletionBlocker[]> {
    const id = user.id;
    const [trips, owned, operator, bookings, subscription] = await Promise.all([
      this.prisma.trip.count({
        where: { organiserId: id, deletedAt: null, status: { in: [...RUNNING_TRIP] } },
      }),
      this.prisma.communityMember.findMany({
        where: { userId: id, role: 'OWNER', status: 'ACTIVE', community: { deletedAt: null } },
        select: { community: { select: { name: true } } },
      }),
      this.prisma.commercialOperator.findUnique({
        where: { ownerUserId: id },
        select: { id: true },
      }),
      this.prisma.booking.count({
        where: { userId: id, status: { in: ['PENDING_PAYMENT', 'CONFIRMED'] } },
      }),
      this.prisma.subscription.findFirst({
        where: { userId: id, status: { in: [...LIVE_SUBSCRIPTION] }, cancelAtPeriodEnd: false },
        select: { id: true },
      }),
    ]);
    const blockers: DeletionBlocker[] = [];
    if (user.role !== 'USER') {
      blockers.push({
        code: 'STAFF_ACCOUNT',
        message: 'Staff accounts are closed by a super admin. Ask one to change your role first.',
      });
    }
    if (trips > 0) {
      blockers.push({
        code: 'ORGANISING_TRIPS',
        message: `Cancel or complete the ${trips === 1 ? 'trip' : `${trips} trips`} you organise first, so the people on ${trips === 1 ? 'it' : 'them'} are told.`,
      });
    }
    if (owned.length > 0) {
      blockers.push({
        code: 'COMMUNITY_OWNER',
        message: `You own ${owned.map((o) => o.community.name).join(', ')}. Delete ${owned.length === 1 ? 'it' : 'them'} first.`,
      });
    }
    if (operator) {
      blockers.push({
        code: 'BUSINESS_ACCOUNT',
        message:
          'You have a business account for paid experiences. Contact support to close it: its bookings and tax records must be settled first.',
      });
    }
    if (bookings > 0) {
      blockers.push({
        code: 'OPEN_BOOKINGS',
        message: 'Cancel your upcoming bookings first, so any refund can reach you.',
      });
    }
    if (subscription) {
      blockers.push({
        code: 'LIVE_SUBSCRIPTION',
        message: 'Cancel your paid plan first, so you are not charged again.',
      });
    }
    return blockers;
  }
}
