import {
  canTransition,
  type GeoPoint,
  type JoinRequestStatus,
  type ParticipantStatus,
  type MotorcycleCategory,
  TERMINAL_TRIP_STATUSES,
  type Trip,
  type TripAction,
  TRIP_START_WINDOW_MS,
  type TripStatus,
} from '@voyago/shared';
import { type AuthUser } from '../common/auth/current-user.decorator.js';

/** A trip row with what the view needs, before privacy rules are applied. */
export interface TripRecord {
  id: string;
  organiserId: string;
  mode: Trip['mode'];
  activityType: Trip['activityType'];
  tripType: Trip['tripType'];
  visibility: Trip['visibility'];
  status: TripStatus;
  title: string;
  description: string | null;
  originName: string;
  destinationName: string;
  departureAt: Date;
  returnAt: Date | null;
  minParticipants: number;
  maxParticipants: number;
  estimatedBudgetPaise: number | null;
  currency: string;
  estimatedDistanceKm: number | null;
  estimatedDurationMinutes: number | null;
  difficulty: Trip['difficulty'];
  minEngineCc: number | null;
  bikeCategories: MotorcycleCategory[];
  approvalRequired: boolean;
  coverImageKey: string | null;
  routeDistanceMeters: number | null;
  routeDurationSeconds: number | null;
  routeTravelMode: string | null;
  routeComputedAt: Date | null;
  publishedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  organiser: { id: string; username: string; displayName: string };
  communityId: string | null;
  community: { id: string; slug: string; name: string } | null;
}

export interface TripGeo {
  origin: GeoPoint | null;
  destination: GeoPoint | null;
  stops: {
    id: string;
    position: number;
    name: string;
    point: GeoPoint;
    plannedArrivalAt: Date | null;
    notes: string | null;
  }[];
}

export interface ViewerContext {
  user: AuthUser;
  /** On the trip now (ACTIVE) or was when it finished (COMPLETED). */
  isParticipant: boolean;
  blocked: boolean;
  participantStatus?: ParticipantStatus | null;
  joinRequest?: { id: string; status: JoinRequestStatus } | null;
  pendingRequestCount?: number;
  /** An active co-organiser: helps run the trip. */
  isCoOrganiser?: boolean;
  /** The viewer's pending invitation, if any. Lets an invitee see a private trip. */
  invitationId?: string | null;
  /** Active member of the trip's community (for COMMUNITY trips). */
  communityMember?: boolean;
}

/** What the viewer has to do with the trip, for working out join and leave. */
export interface Membership {
  participantStatus: ParticipantStatus | null;
  hasPendingRequest: boolean;
  isCoOrganiser?: boolean;
}
const NO_MEMBERSHIP: Membership = { participantStatus: null, hasPendingRequest: false };

/** Organiser, active co-organiser or staff: may decide requests, invite and remove people. */
export function canManagePeople(trip: TripRecord, viewer: ViewerContext): boolean {
  return (
    trip.organiserId === viewer.user.id || viewer.isCoOrganiser === true || isStaff(viewer.user)
  );
}

export const isStaff = (user: AuthUser) => user.role === 'ADMIN' || user.role === 'MODERATOR';

/**
 * Who may see a trip: drafts only their organiser (and staff); private trips participants and
 * people invited; community trips that community's members; nobody on either side of a block.
 * Anyone else gets 404, so hidden trips are not confirmed.
 */
export function canView(trip: TripRecord, viewer: ViewerContext): boolean {
  if (isStaff(viewer.user) || trip.organiserId === viewer.user.id) return true;
  if (viewer.blocked) return false;
  if (trip.status === 'DRAFT') return false;
  if (trip.visibility === 'PUBLIC' || viewer.isParticipant || viewer.invitationId) return true;
  return trip.visibility === 'COMMUNITY' && viewer.communityMember === true;
}

/** True once the trip is underway: by status, or because departure time has passed. */
export function hasStarted(trip: Pick<TripRecord, 'status' | 'departureAt'>, now = Date.now()) {
  return trip.status === 'IN_PROGRESS' || trip.departureAt.getTime() <= now;
}

export function allowedActions(
  trip: TripRecord,
  user: AuthUser,
  membership: Membership = NO_MEMBERSHIP,
  now = Date.now(),
): TripAction[] {
  const isOrganiser = trip.organiserId === user.id;
  const terminal = TERMINAL_TRIP_STATUSES.includes(trip.status);
  const actions: TripAction[] = [];
  // Commercial departures are managed through their package (later milestone).
  if (trip.tripType !== 'COMMUNITY_FREE') return actions;
  if (isOrganiser) {
    if (!terminal) actions.push('edit');
    if (trip.status === 'DRAFT') actions.push('publish', 'delete');
    if (
      canTransition(trip.status, 'IN_PROGRESS') &&
      now >= trip.departureAt.getTime() - TRIP_START_WINDOW_MS
    ) {
      actions.push('start');
    }
    if (trip.status === 'IN_PROGRESS') actions.push('complete');
  }
  if ((isOrganiser || membership.isCoOrganiser) && !terminal && trip.status !== 'DRAFT') {
    actions.push('manage_people');
  }
  if ((isOrganiser || isStaff(user)) && canTransition(trip.status, 'CANCELLED')) {
    actions.push('cancel');
  }
  if (!isOrganiser) {
    const status = membership.participantStatus;
    // Removed members can't ask again; the organiser made that call.
    const canAsk = status === null || status === 'LEFT';
    // Private trips are joined by accepting an invitation, not by asking.
    if (
      canAsk &&
      trip.visibility !== 'PRIVATE' &&
      !membership.hasPendingRequest &&
      trip.status === 'PUBLISHED' &&
      trip.departureAt.getTime() > now
    ) {
      actions.push('join');
    }
    if (status === 'ACTIVE' && !terminal) actions.push('leave');
  }
  // The trip's group chat: everyone on it, and those who finished it.
  const onTrip =
    membership.participantStatus === 'ACTIVE' || membership.participantStatus === 'COMPLETED';
  if ((isOrganiser || onTrip) && trip.status !== 'DRAFT') actions.push('chat');
  return actions;
}

/** Rounds to 2 decimal places (about 1 km), so the exact meeting point is not revealed. */
const approximate = (point: GeoPoint): GeoPoint => ({
  latitude: Math.round(point.latitude * 100) / 100,
  longitude: Math.round(point.longitude * 100) / 100,
});

export function toTripView(
  trip: TripRecord,
  geo: TripGeo,
  viewer: ViewerContext,
  participantCount: number,
  coverImageUrl: string | null = null,
): Trip {
  const isOrganiser = trip.organiserId === viewer.user.id;
  const exactOrigin = isOrganiser || viewer.isParticipant || isStaff(viewer.user);
  const iso = (date: Date | null) => date?.toISOString() ?? null;
  return {
    id: trip.id,
    mode: trip.mode,
    activityType: trip.activityType,
    tripType: trip.tripType,
    visibility: trip.visibility,
    status: trip.status,
    title: trip.title,
    description: trip.description,
    coverImageUrl,
    origin: {
      name: trip.originName,
      point: geo.origin ? (exactOrigin ? geo.origin : approximate(geo.origin)) : null,
      approximate: !exactOrigin,
    },
    destination: { name: trip.destinationName, point: geo.destination },
    stops: geo.stops.map((stop) => ({ ...stop, plannedArrivalAt: iso(stop.plannedArrivalAt) })),
    departureAt: trip.departureAt.toISOString(),
    returnAt: iso(trip.returnAt),
    minParticipants: trip.minParticipants,
    maxParticipants: trip.maxParticipants,
    participantCount,
    estimatedBudgetPaise: trip.estimatedBudgetPaise,
    currency: trip.currency,
    estimatedDistanceKm: trip.estimatedDistanceKm,
    estimatedDurationMinutes: trip.estimatedDurationMinutes,
    estimatesSource: 'ORGANISER',
    route:
      trip.routeDistanceMeters !== null &&
      trip.routeDurationSeconds !== null &&
      trip.routeComputedAt !== null &&
      (trip.routeTravelMode === 'TWO_WHEELER' || trip.routeTravelMode === 'DRIVE')
        ? {
            distanceMeters: trip.routeDistanceMeters,
            durationSeconds: trip.routeDurationSeconds,
            travelMode: trip.routeTravelMode,
            source: 'GOOGLE',
            computedAt: trip.routeComputedAt.toISOString(),
          }
        : null,
    difficulty: trip.difficulty,
    minEngineCc: trip.minEngineCc,
    bikeCategories: trip.bikeCategories,
    approvalRequired: trip.approvalRequired,
    organiser: trip.organiser,
    community: trip.community,
    publishedAt: iso(trip.publishedAt),
    startedAt: iso(trip.startedAt),
    completedAt: iso(trip.completedAt),
    cancelledAt: iso(trip.cancelledAt),
    cancellationReason: trip.cancellationReason,
    createdAt: trip.createdAt.toISOString(),
    updatedAt: trip.updatedAt.toISOString(),
    viewer: {
      isOrganiser,
      isParticipant: viewer.isParticipant,
      isCoOrganiser: viewer.isCoOrganiser ?? false,
      invitationId: viewer.invitationId ?? null,
      participantStatus: viewer.participantStatus ?? null,
      joinRequest: viewer.joinRequest ?? null,
      pendingRequestCount: viewer.pendingRequestCount ?? 0,
      actions: allowedActions(trip, viewer.user, {
        participantStatus: viewer.participantStatus ?? null,
        hasPendingRequest: viewer.joinRequest?.status === 'PENDING',
        isCoOrganiser: viewer.isCoOrganiser ?? false,
      }),
    },
  };
}
