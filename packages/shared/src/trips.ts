import { z } from 'zod';
import { GeoPointSchema } from './geo.js';
import { CoverImageIdSchema } from './maps-media.js';
import { CursorPageQuerySchema } from './pagination.js';
import { TripModeSchema } from './trip-mode.js';
import { ActivityTypeSchema, MotorcycleCategorySchema } from './users.js';

/**
 * Trip contracts for both modes. Rides are always MOTORCYCLE_RIDE; travel trips use any other
 * activity. Community trips are free: members share their own costs, and Voyago never sells
 * seats, matches drivers or arranges paid passenger transport.
 */

export const TripStatusSchema = z.enum([
  'DRAFT',
  'PUBLISHED',
  'FULL',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
]);
export type TripStatus = z.infer<typeof TripStatusSchema>;

export const TripTypeSchema = z.enum(['COMMUNITY_FREE', 'COMMERCIAL_PAID']);
/** Visibility organisers can choose. COMMUNITY trips are seen by that community's members. */
export const TripVisibilityInputSchema = z.enum(['PUBLIC', 'PRIVATE', 'COMMUNITY']);
export const TripVisibilitySchema = z.enum(['PUBLIC', 'FOLLOWERS', 'COMMUNITY', 'PRIVATE']);
export const TripDifficultySchema = z.enum(['EASY', 'MODERATE', 'CHALLENGING']);

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Allowed status changes. FULL ⇄ PUBLISHED and → EXPIRED are made by the system (capacity
 * changes and the expiry job); the rest are organiser actions. The API enforces this table.
 */
export const TRIP_TRANSITIONS: Readonly<Record<TripStatus, readonly TripStatus[]>> = {
  DRAFT: ['PUBLISHED', 'CANCELLED'],
  PUBLISHED: ['FULL', 'IN_PROGRESS', 'CANCELLED', 'EXPIRED'],
  FULL: ['PUBLISHED', 'IN_PROGRESS', 'CANCELLED', 'EXPIRED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export function canTransition(from: TripStatus, to: TripStatus): boolean {
  return TRIP_TRANSITIONS[from].includes(to);
}

export const TERMINAL_TRIP_STATUSES: readonly TripStatus[] = ['COMPLETED', 'CANCELLED', 'EXPIRED'];

/** A trip can be started from this long before departure. */
export const TRIP_START_WINDOW_MS = 2 * 60 * 60 * 1000;
export const MAX_TRIP_STOPS = 25;
export const MAX_TRIP_LENGTH_DAYS = 60;
export const MAX_DEPARTURE_AHEAD_DAYS = 730;

// ── Input ───────────────────────────────────────────────────────────────────

const PlaceName = z.string().trim().min(2).max(160);
const IsoDateTime = z.iso.datetime({ offset: true });

export const NamedPlaceSchema = z.object({ name: PlaceName, point: GeoPointSchema });

export const TripStopInputSchema = z.object({
  name: PlaceName,
  point: GeoPointSchema,
  plannedArrivalAt: IsoDateTime.nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});
export type TripStopInput = z.input<typeof TripStopInputSchema>;

const tripFields = {
  mode: TripModeSchema,
  activityType: ActivityTypeSchema,
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(5000).nullable().optional(),
  origin: NamedPlaceSchema,
  destination: NamedPlaceSchema,
  stops: z.array(TripStopInputSchema).max(MAX_TRIP_STOPS).optional(),
  departureAt: IsoDateTime,
  returnAt: IsoDateTime.nullable().optional(),
  /** Everyone on the trip, organiser included. */
  minParticipants: z.number().int().min(1).max(500).optional(),
  maxParticipants: z.number().int().min(2).max(500),
  /** Per-person cost-sharing estimate in paise. Not a price: nothing is charged. */
  estimatedBudgetPaise: z.number().int().min(0).max(100_000_000).nullable().optional(),
  currency: z.literal('INR').optional(),
  /** Organiser's own estimates; the road route from Google is reported separately. */
  estimatedDistanceKm: z.number().int().min(1).max(20_000).nullable().optional(),
  estimatedDurationMinutes: z.number().int().min(1).max(86_400).nullable().optional(),
  difficulty: TripDifficultySchema.nullable().optional(),
  /** Rides only. */
  minEngineCc: z.number().int().min(50).max(3000).nullable().optional(),
  /** Rides only: bike types the ride suits. Empty means any bike. */
  bikeCategories: z
    .array(MotorcycleCategorySchema)
    .max(8)
    .refine((list) => new Set(list).size === list.length, 'List each bike type once')
    .optional(),
  visibility: TripVisibilityInputSchema.optional(),
  /** Post the trip in a community you belong to (required for COMMUNITY visibility). */
  communityId: z.uuid().nullable().optional(),
  approvalRequired: z.boolean().optional(),
  /** From an upload signature (`/uploads/cover-signature`). null removes the cover. */
  coverImageId: CoverImageIdSchema.nullable().optional(),
};

/** Fields that relate to each other; checked on create and again after merging an edit. */
export interface TripRuleInput {
  mode: 'RIDE' | 'TRAVEL';
  activityType: string;
  departureAt: string | Date;
  returnAt?: string | Date | null;
  minParticipants?: number;
  maxParticipants: number;
  minEngineCc?: number | null;
  bikeCategories?: readonly string[];
  visibility?: string;
  communityId?: string | null;
  stops?: { plannedArrivalAt?: string | Date | null }[];
}

export interface RuleIssue {
  path: string;
  message: string;
}

/** Cross-field rules shared by the apps (instant feedback) and the API (enforcement). */
export function tripRuleIssues(trip: TripRuleInput): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const isRide = trip.mode === 'RIDE';
  if (isRide !== (trip.activityType === 'MOTORCYCLE_RIDE')) {
    issues.push({
      path: 'activityType',
      message: isRide
        ? 'Rides must use the motorcycle ride activity'
        : 'Motorcycle rides belong in Ride mode',
    });
  }
  if (!isRide && trip.minEngineCc != null) {
    issues.push({ path: 'minEngineCc', message: 'Engine size applies to rides only' });
  }
  if (trip.visibility === 'COMMUNITY' && !trip.communityId) {
    issues.push({ path: 'communityId', message: 'Choose the community that can see this trip' });
  }
  if (!isRide && (trip.bikeCategories?.length ?? 0) > 0) {
    issues.push({ path: 'bikeCategories', message: 'Bike types apply to rides only' });
  }
  if ((trip.minParticipants ?? 1) > trip.maxParticipants) {
    issues.push({ path: 'minParticipants', message: 'Minimum cannot exceed maximum participants' });
  }
  const departure = new Date(trip.departureAt).getTime();
  if (trip.returnAt != null) {
    const back = new Date(trip.returnAt).getTime();
    if (back < departure) {
      issues.push({ path: 'returnAt', message: 'Return must be after departure' });
    } else if (back - departure > MAX_TRIP_LENGTH_DAYS * 86_400_000) {
      issues.push({
        path: 'returnAt',
        message: `Trips can last at most ${MAX_TRIP_LENGTH_DAYS} days`,
      });
    }
  }
  trip.stops?.forEach((stop, index) => {
    if (stop.plannedArrivalAt != null && new Date(stop.plannedArrivalAt).getTime() < departure) {
      issues.push({
        path: `stops.${index}.plannedArrivalAt`,
        message: 'Stop time is before departure',
      });
    }
  });
  return issues;
}

/** Departure must be in the future (and not absurdly far) whenever it is set or published. */
export function departureIssue(departureAt: string | Date, now = Date.now()): RuleIssue | null {
  const departure = new Date(departureAt).getTime();
  if (departure <= now) return { path: 'departureAt', message: 'Departure must be in the future' };
  if (departure - now > MAX_DEPARTURE_AHEAD_DAYS * 86_400_000) {
    return { path: 'departureAt', message: 'Departure must be within 2 years' };
  }
  return null;
}

export const CreateTripSchema = z.object(tripFields).superRefine((trip, ctx) => {
  for (const issue of tripRuleIssues(trip)) {
    ctx.addIssue({ code: 'custom', path: issue.path.split('.'), message: issue.message });
  }
});
export type CreateTripInput = z.input<typeof CreateTripSchema>;

/** Partial edit. `stops`, when sent, replaces the whole list. Rules are checked after merging. */
export const UpdateTripSchema = z
  .object(tripFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');
export type UpdateTripInput = z.input<typeof UpdateTripSchema>;

export const CancelTripSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const MyTripsQuerySchema = CursorPageQuerySchema.extend({
  role: z.enum(['organising', 'joined', 'all']).default('all'),
  status: TripStatusSchema.optional(),
});

// ── Output ──────────────────────────────────────────────────────────────────

export const TripActionSchema = z.enum([
  'edit',
  'publish',
  'start',
  'complete',
  'cancel',
  'delete',
  /** Ask to join (or join at once when the trip doesn't need approval). */
  'join',
  'leave',
  /** Organiser and co-organisers: review requests, invite, remove participants. */
  'manage_people',
  /** Open the trip's group chat (people on the trip). */
  'chat',
  /** Live location, check-ins and SOS: people on the trip during its live window. */
  'safety',
]);
export type TripAction = z.infer<typeof TripActionSchema>;

export const TripSchema = z.object({
  id: z.uuid(),
  mode: TripModeSchema,
  activityType: ActivityTypeSchema,
  tripType: TripTypeSchema,
  visibility: TripVisibilitySchema,
  status: TripStatusSchema,
  title: z.string(),
  description: z.string().nullable(),
  coverImageUrl: z.string().nullable(),
  origin: z.object({
    name: z.string(),
    point: GeoPointSchema.nullable(),
    /** True when the exact meeting point is hidden and `point` is rounded to about 1 km. */
    approximate: z.boolean(),
  }),
  destination: z.object({ name: z.string(), point: GeoPointSchema.nullable() }),
  stops: z.array(
    z.object({
      id: z.uuid(),
      position: z.number().int(),
      name: z.string(),
      point: GeoPointSchema,
      plannedArrivalAt: z.string().nullable(),
      notes: z.string().nullable(),
    }),
  ),
  departureAt: z.string(),
  returnAt: z.string().nullable(),
  minParticipants: z.number().int(),
  maxParticipants: z.number().int(),
  participantCount: z.number().int(),
  estimatedBudgetPaise: z.number().int().nullable(),
  currency: z.string(),
  estimatedDistanceKm: z.number().int().nullable(),
  estimatedDurationMinutes: z.number().int().nullable(),
  /** `estimatedDistanceKm` / `estimatedDurationMinutes` are always the organiser's own. */
  estimatesSource: z.literal('ORGANISER'),
  /**
   * Road route through the stops, computed by Google Routes when the trip is published or its
   * places change. null when routing is not configured or no route was found.
   */
  route: z
    .object({
      distanceMeters: z.number().int(),
      durationSeconds: z.number().int(),
      travelMode: z.enum(['TWO_WHEELER', 'DRIVE']),
      source: z.literal('GOOGLE'),
      computedAt: z.string(),
    })
    .nullable(),
  difficulty: TripDifficultySchema.nullable(),
  minEngineCc: z.number().int().nullable(),
  bikeCategories: z.array(MotorcycleCategorySchema),
  approvalRequired: z.boolean(),
  organiser: z.object({ id: z.uuid(), username: z.string(), displayName: z.string() }),
  community: z.object({ id: z.uuid(), slug: z.string(), name: z.string() }).nullable(),
  publishedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  /** Set when Voyago moderators hid the trip from discovery; shown to the organiser only. */
  hiddenReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  viewer: z.object({
    isOrganiser: z.boolean(),
    isParticipant: z.boolean(),
    /** Co-organisers help run the trip: they decide requests, invite and remove participants. */
    isCoOrganiser: z.boolean(),
    /** A pending invitation for the viewer (private trips need one to join). */
    invitationId: z.uuid().nullable(),
    /** ACTIVE / COMPLETED while on the trip; LEFT or REMOVED afterwards; null if never. */
    participantStatus: z.enum(['ACTIVE', 'COMPLETED', 'LEFT', 'REMOVED']).nullable(),
    /** The member's latest join request for this trip, if any. */
    joinRequest: z
      .object({
        id: z.uuid(),
        status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLED']),
      })
      .nullable(),
    /** Pending requests waiting for the organiser (organiser and staff only, else 0). */
    pendingRequestCount: z.number().int(),
    /** What the signed-in member may do now. The API checks again on every action. */
    actions: z.array(TripActionSchema),
  }),
});
export type Trip = z.infer<typeof TripSchema>;
