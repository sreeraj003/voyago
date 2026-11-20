import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type JoinRequest,
  type MyInvitationsQuerySchema,
  type MyJoinRequestsQuerySchema,
  type PageResponse,
  type Participant,
  type TripInvitation,
  type TripJoinRequestsQuerySchema,
} from '@voyago/shared';
import { type z } from 'zod';
import { type AuthUser } from '../common/auth/current-user.decorator.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { canManagePeople, isStaff } from '../trips/trip-view.js';
import { syncCapacityStatus, TripsService } from '../trips/trips.service.js';

type Tx = Prisma.TransactionClient;

const requestInclude = {
  trip: { select: { id: true, title: true, departureAt: true, status: true } },
  user: { select: { id: true, username: true, displayName: true } },
} as const;
type RequestRow = Prisma.TripJoinRequestGetPayload<{ include: typeof requestInclude }>;

const person = { select: { id: true, username: true, displayName: true } } as const;
const invitationInclude = {
  trip: { select: { id: true, title: true, departureAt: true, status: true } },
  invitee: person,
  invitedBy: person,
} as const;
type InvitationRow = Prisma.TripInvitationGetPayload<{ include: typeof invitationInclude }>;

const FULL = 'This trip is full';
const NOT_TAKING_PEOPLE = 'This trip is not taking new people';

/**
 * Joining, leaving and managing the people on community trips. Capacity is checked with the
 * trip row locked (SELECT ... FOR UPDATE) and again by a database trigger, so concurrent
 * approvals can never overfill a trip.
 */
@Injectable()
export class ParticipationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trips: TripsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Ask to join; trips that don't need approval are joined at once. */
  async requestToJoin(user: AuthUser, tripId: string, message?: string): Promise<JoinRequest> {
    // 404 for private trips (without an invitation), drafts and blocked organisers.
    const { trip, viewer } = await this.trips.loadVisible(user, tripId);
    if (trip.organiserId === user.id) throw new ConflictException('You organise this trip');
    if (trip.tripType !== 'COMMUNITY_FREE') {
      throw new ConflictException('Commercial departures are booked through their package');
    }
    if (viewer.participantStatus === 'ACTIVE' || viewer.participantStatus === 'COMPLETED') {
      throw new ConflictException('You are already on this trip');
    }
    if (viewer.participantStatus === 'REMOVED') {
      throw new ForbiddenException('The organiser removed you from this trip');
    }
    if (viewer.joinRequest?.status === 'PENDING') {
      throw new ConflictException('You already asked to join this trip');
    }
    if (trip.visibility === 'PRIVATE') {
      throw new ConflictException(
        viewer.invitationId
          ? 'You are invited: accept the invitation to join'
          : 'Private trips are joined by invitation',
      );
    }
    assertTakingPeople(trip);

    const requestId = await this.prisma.$transaction(async (tx) => {
      const created = await tx.tripJoinRequest.create({
        data: { tripId, userId: user.id, message: message?.trim() || null },
        select: { id: true },
      });
      if (trip.approvalRequired) {
        await this.notifications.notify(tx, [trip.organiserId], {
          type: 'JOIN_REQUEST_RECEIVED',
          title: `New request for ${trip.title}`,
          body: `@${await usernameOf(tx, user.id)} asked to join.`,
          data: { tripId, joinRequestId: created.id },
        });
      } else {
        await this.admit(tx, created.id, null);
        await this.notifications.notify(tx, [trip.organiserId], {
          type: 'JOIN_REQUEST_RECEIVED',
          title: `Someone joined ${trip.title}`,
          body: `@${await usernameOf(tx, user.id)} joined your trip.`,
          data: { tripId, joinRequestId: created.id },
        });
      }
      return created.id;
    });
    return this.getRequest(requestId);
  }

  async approve(user: AuthUser, requestId: string, auditRequestId?: string): Promise<JoinRequest> {
    const request = await this.loadForDecision(user, requestId);
    await this.prisma.$transaction(async (tx) => {
      await this.admit(tx, requestId, user.id);
      if (request.trip.organiserId !== user.id) {
        await audit(tx, user, 'trip.join_request_approve', request.tripId, auditRequestId, {
          joinRequestId: requestId,
        });
      }
    });
    return this.getRequest(requestId);
  }

  async reject(
    user: AuthUser,
    requestId: string,
    reason: string | undefined,
    auditRequestId?: string,
  ): Promise<JoinRequest> {
    const request = await this.loadForDecision(user, requestId);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.tripJoinRequest.updateMany({
        where: { id: requestId, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          decidedById: user.id,
          decidedAt: new Date(),
          rejectionReason: reason ?? null,
        },
      });
      if (updated.count !== 1) throw notPending();
      await this.notifications.notify(tx, [request.userId], {
        type: 'JOIN_REQUEST_REJECTED',
        title: `Your request for ${request.trip.title} was declined`,
        body: reason ? `The organiser said: ${reason}` : null,
        data: { tripId: request.tripId, joinRequestId: requestId },
      });
      if (request.trip.organiserId !== user.id) {
        await audit(tx, user, 'trip.join_request_reject', request.tripId, auditRequestId, {
          joinRequestId: requestId,
          reason: reason ?? null,
        });
      }
    });
    return this.getRequest(requestId);
  }

  async withdraw(user: AuthUser, requestId: string): Promise<JoinRequest> {
    const request = await this.prisma.tripJoinRequest.findUnique({ where: { id: requestId } });
    if (!request || request.userId !== user.id) throw new NotFoundException('Request not found');
    const updated = await this.prisma.tripJoinRequest.updateMany({
      where: { id: requestId, status: 'PENDING' },
      data: { status: 'WITHDRAWN', decidedAt: new Date() },
    });
    if (updated.count !== 1) throw notPending();
    return this.getRequest(requestId);
  }

  async listForTrip(
    user: AuthUser,
    tripId: string,
    query: z.output<typeof TripJoinRequestsQuerySchema>,
  ): Promise<PageResponse<JoinRequest>> {
    const { trip, viewer } = await this.trips.loadVisible(user, tripId);
    if (!canManagePeople(trip, viewer)) {
      throw new ForbiddenException('Only the organisers can see join requests');
    }
    return this.page({ tripId, status: query.status }, query);
  }

  listMine(
    user: AuthUser,
    query: z.output<typeof MyJoinRequestsQuerySchema>,
  ): Promise<PageResponse<JoinRequest>> {
    return this.page({ userId: user.id, ...(query.status ? { status: query.status } : {}) }, query);
  }

  /** People on the trip, organiser first. Visible to participants, the organiser and staff. */
  async participants(user: AuthUser, tripId: string): Promise<Participant[]> {
    const { trip, viewer } = await this.trips.loadVisible(user, tripId);
    if (trip.organiserId !== user.id && !viewer.isParticipant && !isStaff(user)) {
      throw new ForbiddenException('Only people on this trip can see who is going');
    }
    const rows = await this.prisma.tripParticipant.findMany({
      where: { tripId, status: { in: ['ACTIVE', 'COMPLETED'] } },
      include: { user: { select: { id: true, username: true, displayName: true } } },
      orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    });
    return rows
      .map((row) => ({
        user: row.user,
        role: row.role,
        status: row.status,
        joinedAt: row.joinedAt.toISOString(),
      }))
      .sort((a, b) => Number(b.role === 'ORGANISER') - Number(a.role === 'ORGANISER'));
  }

  /**
   * Organiser, co-organiser or staff removes someone. Co-organisers can remove participants but
   * not each other. Always written to the audit log.
   */
  async remove(
    user: AuthUser,
    tripId: string,
    memberId: string,
    reason: string | undefined,
    auditRequestId?: string,
  ): Promise<void> {
    const { trip, viewer } = await this.trips.loadVisible(user, tripId);
    if (!canManagePeople(trip, viewer)) {
      throw new ForbiddenException('Only the organisers can remove people');
    }
    if (memberId === trip.organiserId) {
      throw new ConflictException('The organiser cannot be removed; cancel the trip instead');
    }
    if (memberId === user.id) throw new ConflictException('Leave the trip instead');
    if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(trip.status)) {
      throw new ConflictException('This trip has ended');
    }
    const onlyParticipants = trip.organiserId !== user.id && !isStaff(user);
    await this.prisma.$transaction(async (tx) => {
      const target = await tx.tripParticipant.findUnique({
        where: { tripId_userId: { tripId, userId: memberId } },
        select: { role: true, status: true },
      });
      if (target?.status !== 'ACTIVE')
        throw new NotFoundException('This person is not on the trip');
      if (onlyParticipants && target.role !== 'PARTICIPANT') {
        throw new ForbiddenException('Only the organiser can remove a co-organiser');
      }
      const updated = await tx.tripParticipant.updateMany({
        where: { tripId, userId: memberId, status: 'ACTIVE' },
        data: {
          status: 'REMOVED',
          leftAt: new Date(),
          removedById: user.id,
          removalReason: reason ?? null,
        },
      });
      if (updated.count !== 1) throw new NotFoundException('This person is not on the trip');
      await syncCapacityStatus(tx, tripId);
      await audit(tx, user, 'trip.participant_remove', tripId, auditRequestId, {
        removedUserId: memberId,
        reason: reason ?? null,
        byOrganiser: trip.organiserId === user.id,
      });
      await this.notifications.notify(tx, [memberId], {
        type: 'PARTICIPANT_REMOVED',
        title: `You were removed from ${trip.title}`,
        body: reason ? `The organisers said: ${reason}` : null,
        data: { tripId },
      });
    });
  }

  async leave(user: AuthUser, tripId: string): Promise<void> {
    const { trip } = await this.trips.loadVisible(user, tripId);
    if (trip.organiserId === user.id) {
      throw new ConflictException('Organisers cancel the trip instead of leaving it');
    }
    if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(trip.status)) {
      throw new ConflictException('This trip has ended');
    }
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.tripParticipant.updateMany({
        where: { tripId, userId: user.id, status: 'ACTIVE' },
        data: { status: 'LEFT', leftAt: new Date() },
      });
      if (updated.count !== 1) throw new ConflictException('You are not on this trip');
      await syncCapacityStatus(tx, tripId);
    });
  }

  /** The organiser makes a participant a co-organiser, or back. */
  async setRole(
    user: AuthUser,
    tripId: string,
    memberId: string,
    role: 'CO_ORGANISER' | 'PARTICIPANT',
  ): Promise<Participant[]> {
    const { trip } = await this.trips.loadVisible(user, tripId);
    if (trip.organiserId !== user.id) {
      throw new ForbiddenException('Only the organiser can choose co-organisers');
    }
    if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(trip.status)) {
      throw new ConflictException('This trip has ended');
    }
    if (memberId === user.id) throw new ConflictException('You organise this trip');
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.tripParticipant.updateMany({
        where: { tripId, userId: memberId, status: 'ACTIVE', role: { not: 'ORGANISER' } },
        data: { role },
      });
      if (updated.count !== 1) throw new NotFoundException('This person is not on the trip');
      if (role === 'CO_ORGANISER') {
        await this.notifications.notify(tx, [memberId], {
          type: 'TRIP_UPDATED',
          title: `You're a co-organiser of ${trip.title}`,
          body: 'You can now review requests, invite people and remove participants.',
          data: { tripId },
        });
      }
    });
    return this.participants(user, tripId);
  }

  // ── Invitations ───────────────────────────────────────────────────────────

  /**
   * Organisers and co-organisers invite someone by username. Invitations are how people join
   * private trips; on other trips accepting one skips the approval step.
   */
  async invite(user: AuthUser, tripId: string, username: string): Promise<TripInvitation> {
    const { trip, viewer } = await this.trips.loadVisible(user, tripId);
    if (!canManagePeople(trip, viewer)) {
      throw new ForbiddenException('Only the organisers can invite people');
    }
    if (trip.tripType !== 'COMMUNITY_FREE') {
      throw new ConflictException('Commercial departures are booked through their package');
    }
    assertTakingPeople(trip);
    const invitee = await this.prisma.user.findFirst({
      where: { username, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    // A block either way with the inviter or the organiser looks the same as no such member.
    const notFound = new NotFoundException('No member with that username');
    if (!invitee) throw notFound;
    if (invitee.id === user.id || invitee.id === trip.organiserId) {
      throw new ConflictException('You are already on this trip');
    }
    const blocked = await this.prisma.userBlock.findFirst({
      where: {
        OR: [user.id, trip.organiserId].flatMap((id) => [
          { blockerId: id, blockedId: invitee.id },
          { blockerId: invitee.id, blockedId: id },
        ]),
      },
      select: { blockerId: true },
    });
    if (blocked) throw notFound;
    const membership = await this.prisma.tripParticipant.findUnique({
      where: { tripId_userId: { tripId, userId: invitee.id } },
      select: { status: true },
    });
    if (membership?.status === 'ACTIVE') {
      throw new ConflictException('This person is already on the trip');
    }
    if (membership?.status === 'REMOVED') {
      throw new ConflictException('This person was removed from the trip');
    }

    const id = await this.prisma.$transaction(async (tx) => {
      let created: { id: string };
      try {
        created = await tx.tripInvitation.create({
          data: { tripId, inviteeId: invitee.id, invitedById: user.id },
          select: { id: true },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException('This person already has an invitation');
        }
        throw error;
      }
      await this.notifications.notify(tx, [invitee.id], {
        type: 'TRIP_INVITE',
        title: `You're invited to ${trip.title}`,
        body: `@${await usernameOf(tx, user.id)} invited you.`,
        data: { tripId, invitationId: created.id },
      });
      return created.id;
    });
    return this.getInvitation(id);
  }

  async listInvitationsForTrip(
    user: AuthUser,
    tripId: string,
    query: z.output<typeof MyInvitationsQuerySchema>,
  ): Promise<PageResponse<TripInvitation>> {
    const { trip, viewer } = await this.trips.loadVisible(user, tripId);
    if (!canManagePeople(trip, viewer)) {
      throw new ForbiddenException('Only the organisers can see invitations');
    }
    return this.invitationPage({ tripId, status: query.status }, query);
  }

  listMyInvitations(
    user: AuthUser,
    query: z.output<typeof MyInvitationsQuerySchema>,
  ): Promise<PageResponse<TripInvitation>> {
    return this.invitationPage(
      { inviteeId: user.id, status: query.status, trip: { deletedAt: null } },
      query,
    );
  }

  /** Accept: joins at once, with the same locked capacity check as approvals. */
  async acceptInvitation(user: AuthUser, invitationId: string): Promise<TripInvitation> {
    const invitation = await this.loadOwnInvitation(user, invitationId);
    // Blocks and deleted trips: same rules as seeing the trip.
    const { trip } = await this.trips.loadVisible(user, invitation.tripId);
    await this.prisma.$transaction(async (tx) => {
      await this.lockForAdmission(tx, invitation.tripId);
      const updated = await tx.tripInvitation.updateMany({
        where: { id: invitationId, status: 'PENDING' },
        data: { status: 'ACCEPTED', respondedAt: new Date() },
      });
      if (updated.count !== 1) throw notPendingInvitation();
      await this.addParticipant(tx, invitation.tripId, user.id);
      // A request they had open is settled by the invitation.
      await tx.tripJoinRequest.updateMany({
        where: { tripId: invitation.tripId, userId: user.id, status: 'PENDING' },
        data: {
          status: 'APPROVED',
          decidedById: invitation.invitedById,
          decidedAt: new Date(),
        },
      });
      await this.notifications.notify(
        tx,
        [trip.organiserId, ...(invitation.invitedById ? [invitation.invitedById] : [])],
        {
          type: 'JOIN_REQUEST_APPROVED',
          title: `@${await usernameOf(tx, user.id)} joined ${trip.title}`,
          body: 'They accepted your invitation.',
          data: { tripId: invitation.tripId, invitationId },
        },
      );
    });
    return this.getInvitation(invitationId);
  }

  async declineInvitation(user: AuthUser, invitationId: string): Promise<TripInvitation> {
    await this.loadOwnInvitation(user, invitationId);
    await this.closeInvitation(invitationId, 'DECLINED');
    return this.getInvitation(invitationId);
  }

  async revokeInvitation(user: AuthUser, invitationId: string): Promise<TripInvitation> {
    const invitation = await this.prisma.tripInvitation.findUnique({
      where: { id: invitationId },
      select: { tripId: true },
    });
    if (!invitation) throw new NotFoundException('Invitation not found');
    const { trip, viewer } = await this.trips.loadVisible(user, invitation.tripId);
    if (!canManagePeople(trip, viewer)) {
      throw new ForbiddenException('Only the organisers can withdraw invitations');
    }
    await this.closeInvitation(invitationId, 'REVOKED');
    return this.getInvitation(invitationId);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async loadOwnInvitation(user: AuthUser, invitationId: string) {
    const invitation = await this.prisma.tripInvitation.findUnique({
      where: { id: invitationId },
      select: { tripId: true, inviteeId: true, invitedById: true, status: true },
    });
    if (!invitation || invitation.inviteeId !== user.id) {
      throw new NotFoundException('Invitation not found');
    }
    if (invitation.status !== 'PENDING') throw notPendingInvitation();
    return invitation;
  }

  private async closeInvitation(id: string, status: 'DECLINED' | 'REVOKED'): Promise<void> {
    const updated = await this.prisma.tripInvitation.updateMany({
      where: { id, status: 'PENDING' },
      data: { status, respondedAt: new Date() },
    });
    if (updated.count !== 1) throw notPendingInvitation();
  }

  private async getInvitation(id: string): Promise<TripInvitation> {
    const row = await this.prisma.tripInvitation.findUniqueOrThrow({
      where: { id },
      include: invitationInclude,
    });
    return toInvitation(row);
  }

  private async invitationPage(
    where: Prisma.TripInvitationWhereInput,
    query: { limit: number; cursor?: string | undefined },
  ): Promise<PageResponse<TripInvitation>> {
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.tripInvitation.findMany({
      where: {
        ...where,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      include: invitationInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toInvitation), page: page.page };
  }

  /**
   * Approves a pending request and adds the member, with the trip row locked so the capacity
   * check and the insert see the same count. `deciderId` is null for open trips.
   */
  private async admit(tx: Tx, requestId: string, deciderId: string | null): Promise<void> {
    const request = await tx.tripJoinRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: { tripId: true, userId: true },
    });
    const title = await this.lockForAdmission(tx, request.tripId);
    const updated = await tx.tripJoinRequest.updateMany({
      where: { id: requestId, status: 'PENDING' },
      data: { status: 'APPROVED', decidedById: deciderId, decidedAt: new Date() },
    });
    if (updated.count !== 1) throw notPending();
    await this.addParticipant(tx, request.tripId, request.userId);
    await this.notifications.notify(tx, [request.userId], {
      type: 'JOIN_REQUEST_APPROVED',
      title: `You're in: ${title}`,
      body: 'The exact meeting point is now on the trip page.',
      data: { tripId: request.tripId, joinRequestId: requestId },
    });
  }

  /**
   * Locks the trip row (SELECT ... FOR UPDATE) and checks it can take one more person.
   * Returns the trip title.
   */
  private async lockForAdmission(tx: Tx, tripId: string): Promise<string> {
    const [locked] = await tx.$queryRaw<
      { status: string; max_participants: number; departure_at: Date; title: string }[]
    >`SELECT "status"::text AS status, "max_participants", "departure_at", "title"
      FROM "trips" WHERE "id" = ${tripId}::uuid AND "deleted_at" IS NULL FOR UPDATE`;
    if (!locked) throw new NotFoundException('Trip not found');
    if (locked.status === 'FULL') throw new ConflictException(FULL);
    if (locked.status !== 'PUBLISHED' || locked.departure_at.getTime() <= Date.now()) {
      throw new ConflictException(NOT_TAKING_PEOPLE);
    }
    const active = await tx.tripParticipant.count({ where: { tripId, status: 'ACTIVE' } });
    if (active >= locked.max_participants) throw new ConflictException(FULL);
    return locked.title;
  }

  /** Adds (or re-adds, after leaving) a participant. Call with the trip locked. */
  private async addParticipant(tx: Tx, tripId: string, userId: string): Promise<void> {
    const existing = await tx.tripParticipant.findUnique({
      where: { tripId_userId: { tripId, userId } },
      select: { status: true },
    });
    if (existing?.status === 'REMOVED') {
      throw new ForbiddenException('This person was removed from the trip');
    }
    if (existing?.status === 'ACTIVE') throw new ConflictException('Already on this trip');
    if (existing) {
      // Someone who left earlier and is coming back.
      await tx.tripParticipant.update({
        where: { tripId_userId: { tripId, userId } },
        data: { status: 'ACTIVE', role: 'PARTICIPANT', leftAt: null, joinedAt: new Date() },
      });
    } else {
      await tx.tripParticipant.create({ data: { tripId, userId } });
    }
    await syncCapacityStatus(tx, tripId);
  }

  /** A pending request the user may decide: organiser or staff, never their own. */
  private async loadForDecision(user: AuthUser, requestId: string) {
    const request = await this.prisma.tripJoinRequest.findUnique({
      where: { id: requestId },
      include: { trip: { select: { organiserId: true, title: true } } },
    });
    if (!request) throw new NotFoundException('Request not found');
    if (request.userId === user.id) {
      throw new ForbiddenException('You cannot decide your own request');
    }
    // Same visibility rules as the trip itself (blocks, drafts), then who runs it.
    const { trip, viewer } = await this.trips.loadVisible(user, request.tripId);
    if (!canManagePeople(trip, viewer)) {
      throw new ForbiddenException('Only the organisers can decide join requests');
    }
    if (request.status !== 'PENDING') throw notPending();
    return request;
  }

  private async getRequest(id: string): Promise<JoinRequest> {
    const row = await this.prisma.tripJoinRequest.findUniqueOrThrow({
      where: { id },
      include: requestInclude,
    });
    return toJoinRequest(row);
  }

  private async page(
    where: Prisma.TripJoinRequestWhereInput,
    query: { limit: number; cursor?: string | undefined },
  ): Promise<PageResponse<JoinRequest>> {
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.tripJoinRequest.findMany({
      where: {
        ...where,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      include: requestInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toJoinRequest), page: page.page };
  }
}

function assertTakingPeople(trip: { status: string; departureAt: Date }): void {
  if (trip.status === 'FULL') throw new ConflictException(FULL);
  if (trip.status !== 'PUBLISHED' || trip.departureAt.getTime() <= Date.now()) {
    throw new ConflictException(NOT_TAKING_PEOPLE);
  }
}

function notPendingInvitation() {
  return new ConflictException('This invitation has already been answered or withdrawn');
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function toInvitation(row: InvitationRow): TripInvitation {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    respondedAt: row.respondedAt?.toISOString() ?? null,
    trip: {
      id: row.trip.id,
      title: row.trip.title,
      departureAt: row.trip.departureAt.toISOString(),
      status: row.trip.status,
    },
    invitee: row.invitee,
    invitedBy: row.invitedBy,
  };
}

function notPending() {
  return new ConflictException('This request has already been decided or withdrawn');
}

async function usernameOf(tx: Tx, userId: string): Promise<string> {
  const user = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { username: true },
  });
  return user.username;
}

async function audit(
  tx: Tx,
  user: AuthUser,
  action: string,
  tripId: string,
  requestId: string | undefined,
  metadata: Prisma.InputJsonObject,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorId: user.id,
      actorType: isStaff(user) ? 'ADMIN' : 'USER',
      action,
      entityType: 'trip',
      entityId: tripId,
      metadata: { ...metadata, role: user.role },
      requestId: requestId ?? null,
    },
  });
}

function toJoinRequest(row: RequestRow): JoinRequest {
  return {
    id: row.id,
    status: row.status,
    message: row.message,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    trip: {
      id: row.trip.id,
      title: row.trip.title,
      departureAt: row.trip.departureAt.toISOString(),
      status: row.trip.status,
    },
    requester: row.user,
  };
}
