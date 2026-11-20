import { z } from 'zod';
import { GeoPointSchema } from './geo.js';
import { CursorPageQuerySchema } from './pagination.js';
import { TripModeSchema } from './trip-mode.js';
import { TripDifficultySchema } from './trips.js';
import { ActivityTypeSchema, MotorcycleCategorySchema } from './users.js';

/**
 * Discovery contracts. Only public, published (or full) community trips that have not departed
 * are ever returned. Locations in results are approximate (about 1 km) for everyone; a searcher's
 * own coordinates are used for the query only and are never stored or logged.
 */

export const DISCOVERY_MAX_LIMIT = 50;
/** Results beyond this many are not paged; narrow the search instead. */
export const DISCOVERY_MAX_OFFSET = 500;
/** Hard limit; the server may configure a lower maximum (DISCOVERY_MAX_RADIUS_KM). */
export const DISCOVERY_RADIUS_HARD_MAX_KM = 500;

/** Accepts `a,b` or repeated `?x=a&x=b`. */
const list = <T extends z.ZodType>(item: T) =>
  z
    .preprocess(
      (value) =>
        typeof value === 'string'
          ? value
              .split(',')
              .map((part) => part.trim())
              .filter(Boolean)
          : value,
      z.array(item).min(1).max(12),
    )
    .optional();

const Latitude = z.coerce
  .number()
  .min(-90, 'Latitude must be between -90 and 90')
  .max(90, 'Latitude must be between -90 and 90');
const Longitude = z.coerce
  .number()
  .min(-180, 'Longitude must be between -180 and 180')
  .max(180, 'Longitude must be between -180 and 180');
const RadiusKm = z.coerce.number().min(1).max(DISCOVERY_RADIUS_HARD_MAX_KM);
const PlaceText = z.string().trim().min(2).max(80);
const IsoDateTime = z.iso.datetime({ offset: true });
const Paise = z.coerce.number().int().min(0).max(100_000_000);

const pageFields = {
  limit: z.coerce.number().int().min(1).max(DISCOVERY_MAX_LIMIT).default(20),
  cursor: CursorPageQuerySchema.shape.cursor,
};

const optionalPoint = {
  lat: Latitude.optional(),
  lng: Longitude.optional(),
  radiusKm: RadiusKm.optional(),
};

type PointQuery = {
  lat?: number | undefined;
  lng?: number | undefined;
  radiusKm?: number | undefined;
};

function checkPoint(value: PointQuery, ctx: z.RefinementCtx) {
  if ((value.lat === undefined) !== (value.lng === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['lat'], message: 'Send lat and lng together' });
  }
  if (value.radiusKm !== undefined && value.lat === undefined) {
    ctx.addIssue({ code: 'custom', path: ['radiusKm'], message: 'radiusKm needs lat and lng' });
  }
}

export const DiscoverySortSchema = z.enum(['relevance', 'departure', 'proximity']);
export type DiscoverySort = z.infer<typeof DiscoverySortSchema>;
export const DiscoverableStatusSchema = z.enum(['PUBLISHED', 'FULL']);

export const DiscoverySearchQuerySchema = z
  .object({
    ...pageFields,
    ...optionalPoint,
    q: z.string().trim().min(1).max(100).optional(),
    mode: TripModeSchema.optional(),
    activityType: list(ActivityTypeSchema),
    /** Part of the meeting point's name, e.g. "hebbal". */
    from: PlaceText.optional(),
    /** Part of the destination's name, e.g. "coorg". */
    to: PlaceText.optional(),
    departFrom: IsoDateTime.optional(),
    departTo: IsoDateTime.optional(),
    /** Trips without a budget estimate are excluded when a budget filter is set. */
    budgetMinPaise: Paise.optional(),
    budgetMaxPaise: Paise.optional(),
    /** Free places still open. */
    minSeats: z.coerce.number().int().min(1).max(100).optional(),
    /** PUBLISHED (default) has places left; add FULL to see full trips too. */
    status: list(DiscoverableStatusSchema),
    difficulty: list(TripDifficultySchema),
    /** Rides that welcome this bike type (or any bike). */
    bikeCategory: MotorcycleCategorySchema.optional(),
    /** Rides whose minimum engine size this bike meets. */
    engineCc: z.coerce.number().int().min(50).max(3000).optional(),
    sort: DiscoverySortSchema.default('relevance'),
  })
  .superRefine((value, ctx) => {
    checkPoint(value, ctx);
    if (value.sort === 'proximity' && value.lat === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['sort'],
        message: 'Sorting by distance needs lat and lng',
      });
    }
    if (value.departFrom && value.departTo && value.departTo < value.departFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['departTo'],
        message: 'departTo must be after departFrom',
      });
    }
    if (
      value.budgetMinPaise !== undefined &&
      value.budgetMaxPaise !== undefined &&
      value.budgetMaxPaise < value.budgetMinPaise
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['budgetMaxPaise'],
        message: 'Maximum is below minimum',
      });
    }
  });
export type DiscoverySearchQuery = z.input<typeof DiscoverySearchQuerySchema>;

/** Nearby needs a point: the app sends it only after the member allowed location access. */
export const DiscoveryNearbyQuerySchema = z.object({
  ...pageFields,
  lat: Latitude,
  lng: Longitude,
  radiusKm: RadiusKm.optional(),
  mode: TripModeSchema.optional(),
});
export type DiscoveryNearbyQuery = z.input<typeof DiscoveryNearbyQuerySchema>;

export const DiscoveryTrendingQuerySchema = z
  .object({ ...pageFields, ...optionalPoint, mode: TripModeSchema.optional() })
  .superRefine(checkPoint);
export type DiscoveryTrendingQuery = z.input<typeof DiscoveryTrendingQuerySchema>;

export const DiscoveryDestinationsQuerySchema = z.object({
  ...pageFields,
  /** Start of a destination name. */
  q: z.string().trim().min(1).max(80).optional(),
  mode: TripModeSchema.optional(),
});
export type DiscoveryDestinationsQuery = z.input<typeof DiscoveryDestinationsQuerySchema>;

// ── Output ──────────────────────────────────────────────────────────────────

export const TripCardSchema = z.object({
  id: z.uuid(),
  mode: TripModeSchema,
  activityType: ActivityTypeSchema,
  status: DiscoverableStatusSchema,
  title: z.string(),
  coverImageUrl: z.string().nullable(),
  /** Always approximate in discovery (rounded to about 1 km). */
  origin: z.object({ name: z.string(), point: GeoPointSchema, approximate: z.literal(true) }),
  destination: z.object({ name: z.string(), point: GeoPointSchema.nullable() }),
  departureAt: z.string(),
  returnAt: z.string().nullable(),
  maxParticipants: z.number().int(),
  participantCount: z.number().int(),
  seatsLeft: z.number().int(),
  estimatedBudgetPaise: z.number().int().nullable(),
  currency: z.string(),
  difficulty: TripDifficultySchema.nullable(),
  minEngineCc: z.number().int().nullable(),
  bikeCategories: z.array(MotorcycleCategorySchema),
  /** Google road route, when one was computed. */
  route: z
    .object({
      distanceMeters: z.number().int(),
      durationSeconds: z.number().int(),
      travelMode: z.enum(['TWO_WHEELER', 'DRIVE']),
      source: z.literal('GOOGLE'),
    })
    .nullable(),
  organiser: z.object({ username: z.string(), displayName: z.string() }),
  /**
   * Straight-line distance in whole km from the searched point to the meeting area. Not a road
   * distance. null when the search had no point.
   */
  straightLineKm: z.number().int().nullable(),
  /** Why this trip ranks where it does, in plain words. */
  matchReasons: z.array(z.string()),
});
export type TripCard = z.infer<typeof TripCardSchema>;

export const DestinationSummarySchema = z.object({
  name: z.string(),
  /** Centre of the trips' destinations, rounded to about 100 m. */
  point: GeoPointSchema.nullable(),
  tripCount: z.number().int(),
  nextDepartureAt: z.string(),
});
export type DestinationSummary = z.infer<typeof DestinationSummarySchema>;
