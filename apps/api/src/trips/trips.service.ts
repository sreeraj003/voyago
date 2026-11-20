import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  canTransition,
  type CreateTripSchema,
  departureIssue,
  type GeoPoint,
  type MyTripsQuerySchema,
  type PageResponse,
  type ParticipantStatus,
  type RuleIssue,
  TERMINAL_TRIP_STATUSES,
  type Trip,
  TRIP_START_WINDOW_MS,
  type TripStatus,
  type TripStopInputSchema,
  tripRuleIssues,
  type UpdateTripSchema,
} from '@voyago/shared';
import { type z } from 'zod';
import { type AuthUser } from '../common/auth/current-user.decorator.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { PrismaService } from '../database/prisma.service.js';
import { CloudinaryService } from '../integrations/cloudinary.service.js';
import { GoogleMapsService } from '../integrations/google-maps.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { geographyPoint, setPointSql } from '../database/geo.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  allowedActions,
  canView,
  hasStarted,
  isStaff,
  type TripGeo,
  type TripRecord,
  toTripView,
  type ViewerContext,
} from './trip-view.js';

type CreateInput = z.output<typeof CreateTripSchema>;
type UpdateInput = z.output<typeof UpdateTripSchema>;
type StopInput = z.output<typeof TripStopInputSchema>;
type Tx = Prisma.TransactionClient;

const tripInclude = {
  organiser: { select: { id: true, username: true, displayName: true } },
} as const;

/** Participant statuses that count as being on the trip (now, or when it finished). */
const ON_TRIP: ParticipantStatus[] = ['ACTIVE', 'COMPLETED'];
/** Edits to these fields are announced to everyone on the trip. */
const ANNOUNCED_FIELDS = [
  'departureAt',
  'returnAt',
  'origin',
  'destination',
  'stops',
  'title',
] as const;

/** Fields that may still change once a trip has started. */
const EDITABLE_AFTER_START = new Set(['description', 'coverImageId']);
/** Edits to these fields recompute the road route. */
const ROUTE_FIELDS = ['origin', 'destination', 'stops', 'mode'] as const;
/** Fields fixed once a trip is published: people joined a ride or a trek, not a later swap. */
const LOCKED_AFTER_PUBLISH = ['mode', 'activityType'] as const;

/**
 * The trip engine for community trips. Every rule is enforced here; the apps only mirror them.
 * Lifecycle: DRAFT → PUBLISHED ⇄ FULL → IN_PROGRESS → COMPLETED, with CANCELLED and EXPIRED as
 * the other terminal states (see TRIP_TRANSITIONS in @voyago/shared).
 */
@Injectable()
export class TripsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly maps: GoogleMapsService,
    private readonly cloudinary: CloudinaryService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(user: AuthUser, input: CreateInput): Promise<Trip> {
    assertNoIssues([departureIssue(input.departureAt)]);
    if (input.coverImageId)
      await this.cloudinary.assertOwnUploadedCover(user.id, input.coverImageId);
    const id = await this.prisma.$transaction(async (tx) => {
      const trip = await tx.trip.create({
        data: {
          organiserId: user.id,
          tripType: 'COMMUNITY_FREE',
          status: 'DRAFT',
          mode: input.mode,
          activityType: input.activityType,
          title: input.title,
          description: input.description ?? null,
          originName: input.origin.name,
          destinationName: input.destination.name,
          departureAt: new Date(input.departureAt),
          returnAt: input.returnAt ? new Date(input.returnAt) : null,
          minParticipants: input.minParticipants ?? 1,
          maxParticipants: input.maxParticipants,
          estimatedBudgetPaise: input.estimatedBudgetPaise ?? null,
          currency: input.currency ?? 'INR',
          estimatedDistanceKm: input.estimatedDistanceKm ?? null,
          estimatedDurationMinutes: input.estimatedDurationMinutes ?? null,
          difficulty: input.difficulty ?? null,
          minEngineCc: input.minEngineCc ?? null,
          bikeCategories: input.bikeCategories ?? [],
          visibility: input.visibility ?? 'PUBLIC',
          approvalRequired: input.approvalRequired ?? true,
          coverImageKey: input.coverImageId ?? null,
          // The organiser is the first participant.
          participants: { create: { userId: user.id, role: 'ORGANISER' } },
        },
        select: { id: true },
      });
      await tx.$executeRaw(setPointSql('trips', 'origin', trip.id, input.origin.point));
      await tx.$executeRaw(setPointSql('trips', 'destination', trip.id, input.destination.point));
      await replaceStops(tx, trip.id, input.stops ?? []);
      return trip.id;
    });
    await this.refreshRoute(id);
    return this.get(user, id);
  }

  async get(user: AuthUser, id: string): Promise<Trip> {
    const { trip, viewer, participantCount } = await this.loadVisible(user, id);
    const [geo] = await this.loadGeo([trip.id]);
    return toTripView(
      trip,
      geo ?? emptyGeo,
      viewer,
      participantCount,
      this.cloudinary.coverUrl(trip.coverImageKey),
    );
  }

  async update(user: AuthUser, id: string, input: UpdateInput): Promise<Trip> {
    const { trip, participantCount } = await this.loadForOrganiser(user, id);
    if (TERMINAL_TRIP_STATUSES.includes(trip.status)) {
      throw new ConflictException('This trip has ended and can no longer be edited');
    }
    const changed = Object.keys(input);
    if (hasStarted(trip)) {
      const blocked = changed.filter((key) => !EDITABLE_AFTER_START.has(key));
      if (blocked.length > 0) {
        throw new ConflictException({
          message: 'The trip has started; only the description can change now',
          details: blocked.map((path) => ({ path, message: 'Locked after the trip starts' })),
        });
      }
    }
    if (trip.status !== 'DRAFT') {
      const locked = LOCKED_AFTER_PUBLISH.filter(
        (key) => input[key] !== undefined && input[key] !== trip[key],
      );
      if (locked.length > 0) {
        throw new ConflictException({
          message: 'Mode and activity cannot change after publishing',
          details: locked.map((path) => ({ path, message: 'Locked after publishing' })),
        });
      }
    }

    const issues: (RuleIssue | null)[] = [];
    if (input.departureAt) issues.push(departureIssue(input.departureAt));
    if (input.maxParticipants !== undefined && input.maxParticipants < participantCount) {
      issues.push({
        path: 'maxParticipants',
        message: `${participantCount} people are already on this trip`,
      });
    }
    issues.push(
      ...tripRuleIssues({
        mode: input.mode ?? trip.mode,
        activityType: input.activityType ?? trip.activityType,
        departureAt: input.departureAt ?? trip.departureAt,
        returnAt: input.returnAt !== undefined ? input.returnAt : trip.returnAt,
        minParticipants: input.minParticipants ?? trip.minParticipants,
        maxParticipants: input.maxParticipants ?? trip.maxParticipants,
        minEngineCc: input.minEngineCc !== undefined ? input.minEngineCc : trip.minEngineCc,
        bikeCategories: input.bikeCategories ?? trip.bikeCategories,
        stops: input.stops,
      }),
    );
    assertNoIssues(issues);
    if (input.coverImageId)
      await this.cloudinary.assertOwnUploadedCover(user.id, input.coverImageId);

    await this.prisma.$transaction(async (tx) => {
      const { origin, destination, stops, departureAt, returnAt, coverImageId, ...scalars } = input;
      const updated = await tx.trip.updateMany({
        // Guard against a concurrent status change between the read above and this write.
        where: { id, status: trip.status, deletedAt: null },
        data: {
          ...scalars,
          ...(departureAt ? { departureAt: new Date(departureAt) } : {}),
          ...(returnAt !== undefined ? { returnAt: returnAt ? new Date(returnAt) : null } : {}),
          ...(origin ? { originName: origin.name } : {}),
          ...(destination ? { destinationName: destination.name } : {}),
          ...(coverImageId !== undefined ? { coverImageKey: coverImageId } : {}),
        },
      });
      if (updated.count !== 1) throw staleError();
      if (origin) await tx.$executeRaw(setPointSql('trips', 'origin', id, origin.point));
      if (destination) {
        await tx.$executeRaw(setPointSql('trips', 'destination', id, destination.point));
      }
      if (stops) await replaceStops(tx, id, stops);
      await syncCapacityStatus(tx, id);
    });
    if (ROUTE_FIELDS.some((key) => input[key] !== undefined)) await this.refreshRoute(id);
    const announced = ANNOUNCED_FIELDS.filter((key) => input[key] !== undefined);
    if (announced.length > 0 && trip.status !== 'DRAFT') {
      await this.notifications.notify(this.prisma, await this.otherMembers(id, user.id), {
        type: 'TRIP_UPDATED',
        title: `${trip.title} was updated`,
        body: `The organiser changed ${describeChanges(announced)}. Check the latest plan.`,
        data: { tripId: id },
      });
    }
    return this.get(user, id);
  }

  async publish(user: AuthUser, id: string): Promise<Trip> {
    const { trip } = await this.loadForOrganiser(user, id);
    this.assertAction(trip, user, 'publish');
    const [geo] = await this.loadGeo([id]);
    const issues: (RuleIssue | null)[] = [departureIssue(trip.departureAt)];
    if (!geo?.origin) issues.push({ path: 'origin', message: 'Add the meeting point' });
    if (!geo?.destination) issues.push({ path: 'destination', message: 'Add the destination' });
    issues.push(...tripRuleIssues({ ...trip, stops: geo?.stops ?? [] }));
    assertNoIssues(issues);

    await this.prisma.$transaction(async (tx) => {
      await transition(tx, trip, 'PUBLISHED', { publishedAt: new Date() });
      await syncCapacityStatus(tx, id);
    });
    if (trip.routeComputedAt === null) await this.refreshRoute(id);
    return this.get(user, id);
  }

  async start(user: AuthUser, id: string): Promise<Trip> {
    const { trip } = await this.loadForOrganiser(user, id);
    if (!canTransition(trip.status, 'IN_PROGRESS')) throw invalidTransition(trip.status, 'start');
    if (Date.now() < trip.departureAt.getTime() - TRIP_START_WINDOW_MS) {
      throw new ConflictException('A trip can be started from 2 hours before departure');
    }
    await this.prisma.$transaction(async (tx) => {
      await transition(tx, trip, 'IN_PROGRESS', { startedAt: new Date() });
      await closePendingRequests(tx, id);
    });
    return this.get(user, id);
  }

  async complete(user: AuthUser, id: string): Promise<Trip> {
    const { trip } = await this.loadForOrganiser(user, id);
    this.assertAction(trip, user, 'complete');
    await this.prisma.$transaction(async (tx) => {
      await transition(tx, trip, 'COMPLETED', { completedAt: new Date() });
      await tx.tripParticipant.updateMany({
        where: { tripId: id, status: 'ACTIVE' },
        data: { status: 'COMPLETED' },
      });
    });
    return this.get(user, id);
  }

  /** Organisers cancel their own trips; moderators and admins can cancel any (audited). */
  async cancel(user: AuthUser, id: string, reason: string, requestId?: string): Promise<Trip> {
    const { trip } = await this.loadVisible(user, id);
    const isOrganiser = trip.organiserId === user.id;
    if (!isOrganiser && !isStaff(user)) {
      throw new ForbiddenException('Only the organiser can cancel this trip');
    }
    this.assertCommunity(trip);
    if (!canTransition(trip.status, 'CANCELLED')) throw invalidTransition(trip.status, 'cancel');

    await this.prisma.$transaction(async (tx) => {
      await transition(tx, trip, 'CANCELLED', {
        cancelledAt: new Date(),
        cancellationReason: reason,
      });
      const requesters = await closePendingRequests(tx, id);
      const members = await tx.tripParticipant.findMany({
        where: { tripId: id, status: 'ACTIVE', userId: { not: user.id } },
        select: { userId: true },
      });
      await this.notifications.notify(tx, [...members.map((m) => m.userId), ...requesters], {
        type: 'TRIP_CANCELLED',
        title: `${trip.title} was cancelled`,
        body: `Reason: ${reason}`,
        data: { tripId: id },
      });
      if (!isOrganiser) {
        await tx.auditLog.create({
          data: {
            actorId: user.id,
            actorType: 'ADMIN',
            action: 'trip.moderate_cancel',
            entityType: 'trip',
            entityId: id,
            metadata: { reason, previousStatus: trip.status, role: user.role },
            requestId: requestId ?? null,
          },
        });
      }
    });
    return this.get(user, id);
  }

  /** Drafts can be deleted; anything published is cancelled instead, so history is kept. */
  async deleteDraft(user: AuthUser, id: string): Promise<void> {
    const { trip } = await this.loadForOrganiser(user, id);
    this.assertAction(trip, user, 'delete');
    const deleted = await this.prisma.trip.updateMany({
      where: { id, status: 'DRAFT', deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (deleted.count !== 1) throw staleError();
  }

  async listMine(
    user: AuthUser,
    query: z.output<typeof MyTripsQuerySchema>,
  ): Promise<PageResponse<Trip>> {
    const cursor = decodeCursor(query.cursor);
    const asParticipant = {
      participants: { some: { userId: user.id, status: { in: ON_TRIP } } },
    };
    const where: Prisma.TripWhereInput = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.role === 'organising'
        ? { organiserId: user.id }
        : query.role === 'joined'
          ? { ...asParticipant, organiserId: { not: user.id } }
          : { OR: [{ organiserId: user.id }, asParticipant] }),
      ...(cursor
        ? {
            AND: [
              {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.trip.findMany({
      where,
      include: tripInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit);
    const ids = page.data.map((trip) => trip.id);
    const [geos, counts, mine] = await Promise.all([
      this.loadGeo(ids),
      this.countParticipants(ids),
      this.prisma.tripParticipant.findMany({
        where: { tripId: { in: ids }, userId: user.id },
        select: { tripId: true, status: true },
      }),
    ]);
    const statusOf = new Map(mine.map((row) => [row.tripId, row.status]));
    return {
      data: page.data.map((trip, index) =>
        toTripView(
          trip,
          geos[index] ?? emptyGeo,
          {
            user,
            isParticipant: true,
            blocked: false,
            participantStatus: statusOf.get(trip.id) ?? null,
          },
          counts.get(trip.id) ?? 0,
          this.cloudinary.coverUrl(trip.coverImageKey),
        ),
      ),
      page: page.page,
    };
  }

  /**
   * Recomputes the road route (origin → stops → destination) with Google Routes. Best effort:
   * if routing is off or fails, the stored route is cleared rather than left stale.
   */
  private async refreshRoute(id: string): Promise<void> {
    const trip = await this.prisma.trip.findUniqueOrThrow({
      where: { id },
      select: { mode: true },
    });
    const [geo] = await this.loadGeo([id]);
    const points =
      geo?.origin && geo.destination
        ? [geo.origin, ...geo.stops.map((stop) => stop.point), geo.destination]
        : [];
    const route = await this.maps.computeRoute(points, trip.mode);
    await this.prisma.trip.update({
      where: { id },
      data: route
        ? {
            routeDistanceMeters: route.distanceMeters,
            routeDurationSeconds: route.durationSeconds,
            routeTravelMode: route.travelMode,
            routeComputedAt: new Date(),
          }
        : {
            routeDistanceMeters: null,
            routeDurationSeconds: null,
            routeTravelMode: null,
            routeComputedAt: null,
          },
    });
  }

  // ── Loading and access ────────────────────────────────────────────────────

  /** The trip if the user may see it (404 otherwise), with what they have to do with it. */
  async loadVisible(user: AuthUser, id: string) {
    const trip = await this.prisma.trip.findFirst({
      where: { id, deletedAt: null },
      include: tripInclude,
    });
    const notFound = new NotFoundException('Trip not found');
    if (!trip) throw notFound;
    const manages = trip.organiserId === user.id || isStaff(user);
    const [participant, block, counts, joinRequest, pendingRequestCount] = await Promise.all([
      this.prisma.tripParticipant.findUnique({
        where: { tripId_userId: { tripId: id, userId: user.id } },
        select: { status: true },
      }),
      trip.organiserId === user.id
        ? null
        : this.prisma.userBlock.findFirst({
            where: {
              OR: [
                { blockerId: trip.organiserId, blockedId: user.id },
                { blockerId: user.id, blockedId: trip.organiserId },
              ],
            },
            select: { blockerId: true },
          }),
      this.countParticipants([id]),
      this.prisma.tripJoinRequest.findFirst({
        where: { tripId: id, userId: user.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true },
      }),
      manages ? this.prisma.tripJoinRequest.count({ where: { tripId: id, status: 'PENDING' } }) : 0,
    ]);
    const viewer: ViewerContext = {
      user,
      isParticipant: participant !== null && ON_TRIP.includes(participant.status),
      blocked: block !== null,
      participantStatus: participant?.status ?? null,
      joinRequest,
      pendingRequestCount,
    };
    if (!canView(trip, viewer)) throw notFound;
    return { trip: trip as TripRecord, viewer, participantCount: counts.get(id) ?? 0 };
  }

  /** Visible trip that the user organises; 403 for someone else's visible trip. */
  private async loadForOrganiser(user: AuthUser, id: string) {
    const loaded = await this.loadVisible(user, id);
    if (loaded.trip.organiserId !== user.id) {
      throw new ForbiddenException('Only the organiser can change this trip');
    }
    this.assertCommunity(loaded.trip);
    return loaded;
  }

  private assertCommunity(trip: TripRecord): void {
    if (trip.tripType !== 'COMMUNITY_FREE') {
      throw new ConflictException('Commercial departures are managed from their package');
    }
  }

  private assertAction(
    trip: TripRecord,
    user: AuthUser,
    action: 'publish' | 'complete' | 'delete',
  ) {
    if (!allowedActions(trip, user).includes(action)) throw invalidTransition(trip.status, action);
  }

  /** Active participants other than `exceptUserId`. */
  private async otherMembers(tripId: string, exceptUserId: string): Promise<string[]> {
    const rows = await this.prisma.tripParticipant.findMany({
      where: { tripId, status: 'ACTIVE', userId: { not: exceptUserId } },
      select: { userId: true },
    });
    return rows.map((row) => row.userId);
  }

  private async countParticipants(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const groups = await this.prisma.tripParticipant.groupBy({
      by: ['tripId'],
      where: { tripId: { in: ids }, status: { in: ON_TRIP } },
      _count: { _all: true },
    });
    return new Map(groups.map((group) => [group.tripId, group._count._all]));
  }

  /** Reads geography columns, which Prisma cannot select, for several trips at once. */
  private async loadGeo(ids: string[]): Promise<TripGeo[]> {
    if (ids.length === 0) return [];
    const [points, stops] = await Promise.all([
      this.prisma.$queryRaw<
        {
          id: string;
          olat: number | null;
          olng: number | null;
          dlat: number | null;
          dlng: number | null;
        }[]
      >`SELECT "id",
          ST_Y("origin"::geometry) AS olat, ST_X("origin"::geometry) AS olng,
          ST_Y("destination"::geometry) AS dlat, ST_X("destination"::geometry) AS dlng
        FROM "trips" WHERE "id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})`,
      this.prisma.$queryRaw<
        {
          id: string;
          trip_id: string;
          position: number;
          name: string;
          lat: number;
          lng: number;
          planned_arrival_at: Date | null;
          notes: string | null;
        }[]
      >`SELECT "id", "trip_id", "position", "name", "planned_arrival_at", "notes",
          ST_Y("location"::geometry) AS lat, ST_X("location"::geometry) AS lng
        FROM "trip_stops" WHERE "trip_id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
        ORDER BY "position"`,
    ]);
    const point = (lat: number | null, lng: number | null): GeoPoint | null =>
      lat === null || lng === null ? null : { latitude: lat, longitude: lng };
    return ids.map((id) => {
      const row = points.find((p) => p.id === id);
      return {
        origin: row ? point(row.olat, row.olng) : null,
        destination: row ? point(row.dlat, row.dlng) : null,
        stops: stops
          .filter((stop) => stop.trip_id === id)
          .map((stop) => ({
            id: stop.id,
            position: stop.position,
            name: stop.name,
            point: { latitude: stop.lat, longitude: stop.lng },
            plannedArrivalAt: stop.planned_arrival_at,
            notes: stop.notes,
          })),
      };
    });
  }
}

const emptyGeo: TripGeo = { origin: null, destination: null, stops: [] };

async function replaceStops(tx: Tx, tripId: string, stops: StopInput[]): Promise<void> {
  await tx.tripStop.deleteMany({ where: { tripId } });
  for (const [index, stop] of stops.entries()) {
    await tx.$executeRaw`
      INSERT INTO "trip_stops" ("trip_id", "position", "name", "location", "planned_arrival_at", "notes", "updated_at")
      VALUES (${tripId}::uuid, ${index + 1}, ${stop.name}, ${geographyPoint(stop.point)},
              ${stop.plannedArrivalAt ? new Date(stop.plannedArrivalAt) : null}, ${stop.notes ?? null}, NOW())`;
  }
}

/** Conditional update: fails with 409 if the status changed since it was read. */
async function transition(
  client: Tx,
  trip: TripRecord,
  to: TripStatus,
  data: Prisma.TripUpdateManyMutationInput,
): Promise<void> {
  if (!canTransition(trip.status, to)) throw invalidTransition(trip.status, to);
  const updated = await client.trip.updateMany({
    where: { id: trip.id, status: trip.status, deletedAt: null },
    data: { ...data, status: to },
  });
  if (updated.count !== 1) throw staleError();
}

/** PUBLISHED ⇄ FULL follows capacity: called after every join, leave and removal. */
export async function syncCapacityStatus(tx: Tx, tripId: string): Promise<void> {
  const trip = await tx.trip.findUniqueOrThrow({
    where: { id: tripId },
    select: { status: true, maxParticipants: true },
  });
  if (trip.status !== 'PUBLISHED' && trip.status !== 'FULL') return;
  const count = await tx.tripParticipant.count({ where: { tripId, status: 'ACTIVE' } });
  const next = count >= trip.maxParticipants ? 'FULL' : 'PUBLISHED';
  if (next !== trip.status) {
    await tx.trip.updateMany({
      where: { id: tripId, status: trip.status },
      data: { status: next },
    });
  }
}

/**
 * Closes pending join requests when a trip stops taking people (cancelled, started, expired).
 * Returns the requesters, so they can be told.
 */
export async function closePendingRequests(tx: Tx, tripId: string): Promise<string[]> {
  const pending = await tx.tripJoinRequest.findMany({
    where: { tripId, status: 'PENDING' },
    select: { userId: true },
  });
  if (pending.length > 0) {
    await tx.tripJoinRequest.updateMany({
      where: { tripId, status: 'PENDING' },
      data: { status: 'CANCELLED', decidedAt: new Date() },
    });
  }
  return pending.map((row) => row.userId);
}

const CHANGE_NAMES: Record<(typeof ANNOUNCED_FIELDS)[number], string> = {
  departureAt: 'the departure time',
  returnAt: 'the return time',
  origin: 'the meeting point',
  destination: 'the destination',
  stops: 'the stops',
  title: 'the title',
};

function describeChanges(fields: readonly (typeof ANNOUNCED_FIELDS)[number][]): string {
  const names = fields.map((field) => CHANGE_NAMES[field]);
  return names.length === 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

function assertNoIssues(issues: (RuleIssue | null)[]): void {
  const found = issues.filter((issue): issue is RuleIssue => issue !== null);
  if (found.length > 0)
    throw new BadRequestException({ message: 'Validation failed', details: found });
}

function invalidTransition(from: TripStatus, action: string) {
  return new ConflictException(
    `Cannot ${action.toLowerCase()} a trip that is ${from.toLowerCase().replace('_', ' ')}`,
  );
}

function staleError() {
  return new ConflictException('This trip was changed by someone else. Reload and try again.');
}
