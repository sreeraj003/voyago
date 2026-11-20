import {
  canTransition,
  type GeoPoint,
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
  approvalRequired: boolean;
  publishedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  organiser: { id: string; username: string; displayName: string };
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
  isParticipant: boolean;
  blocked: boolean;
}

export const isStaff = (user: AuthUser) => user.role === 'ADMIN' || user.role === 'MODERATOR';

/**
 * Who may see a trip: drafts only their organiser (and staff); private trips only participants;
 * nobody on either side of a block. Anyone else gets 404, so hidden trips are not confirmed.
 */
export function canView(trip: TripRecord, viewer: ViewerContext): boolean {
  if (isStaff(viewer.user) || trip.organiserId === viewer.user.id) return true;
  if (viewer.blocked) return false;
  if (trip.status === 'DRAFT') return false;
  return trip.visibility === 'PUBLIC' || viewer.isParticipant;
}

/** True once the trip is underway: by status, or because departure time has passed. */
export function hasStarted(trip: Pick<TripRecord, 'status' | 'departureAt'>, now = Date.now()) {
  return trip.status === 'IN_PROGRESS' || trip.departureAt.getTime() <= now;
}

export function allowedActions(trip: TripRecord, user: AuthUser, now = Date.now()): TripAction[] {
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
  if ((isOrganiser || isStaff(user)) && canTransition(trip.status, 'CANCELLED')) {
    actions.push('cancel');
  }
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
    coverImageUrl: null,
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
    difficulty: trip.difficulty,
    minEngineCc: trip.minEngineCc,
    approvalRequired: trip.approvalRequired,
    organiser: trip.organiser,
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
      actions: allowedActions(trip, viewer.user),
    },
  };
}
