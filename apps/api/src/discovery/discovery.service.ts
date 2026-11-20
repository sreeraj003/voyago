import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  type DestinationSummary,
  type DiscoveryDestinationsQuerySchema,
  type DiscoveryNearbyQuerySchema,
  type DiscoverySearchQuerySchema,
  type DiscoveryTrendingQuerySchema,
  type GeoPoint,
  type PageResponse,
  type TripCard,
} from '@voyago/shared';
import { type z } from 'zod';
import { type AuthUser } from '../common/auth/current-user.decorator.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { geographyPoint } from '../database/geo.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { CloudinaryService } from '../integrations/cloudinary.service.js';
import {
  decodeOffsetCursor,
  escapeLike,
  matchReasons,
  offsetPage,
  roundTo,
  toPrefixTsQuery,
  wholeKm,
} from './discovery-query.js';

type SearchQuery = z.output<typeof DiscoverySearchQuerySchema>;
type NearbyQuery = z.output<typeof DiscoveryNearbyQuerySchema>;
type TrendingQuery = z.output<typeof DiscoveryTrendingQuerySchema>;
type DestinationsQuery = z.output<typeof DiscoveryDestinationsQuerySchema>;

/**
 * Relevance ranking: a weighted sum of simple, explainable signals, each scaled to 0..1.
 * Nothing about the people on a trip (age, gender, religion, ...) is used.
 */
export const RANKING_WEIGHTS = {
  /** Full-text match of title, places and description (ts_rank_cd, normalised). */
  text: 3,
  /** 1 at the searched point, 0 at the edge of the radius. */
  proximity: 2,
  /** 1 departing now, 0 at 60 days or more. */
  soonness: 1,
  /** Share of places still open. */
  openPlaces: 1,
  /** Activity or mode matches the member's saved preferences. */
  preference: 1,
} as const;
const SOONNESS_HORIZON_SECONDS = 60 * 86_400;
const TRENDING_WINDOW_DAYS = 60;

type CardRow = {
  id: string;
  mode: 'RIDE' | 'TRAVEL';
  activity_type: TripCard['activityType'];
  status: TripCard['status'];
  title: string;
  cover_image_key: string | null;
  origin_name: string;
  destination_name: string;
  olat: number;
  olng: number;
  dlat: number | null;
  dlng: number | null;
  departure_at: Date;
  return_at: Date | null;
  max_participants: number;
  participant_count: number;
  estimated_budget_paise: number | null;
  currency: string;
  difficulty: TripCard['difficulty'];
  min_engine_cc: number | null;
  bike_categories: TripCard['bikeCategories'] | null;
  route_distance_meters: number | null;
  route_duration_seconds: number | null;
  route_travel_mode: 'TWO_WHEELER' | 'DRIVE' | null;
  organiser_username: string;
  organiser_display_name: string;
  distance_m: number | null;
  text_rank: number | null;
  pref_match: boolean;
  recent_joins?: number;
};

interface Near {
  point: GeoPoint;
  radiusMeters: number;
}

/**
 * Trip discovery over PostGIS and Postgres full-text search. Only public trips that are
 * published (or full), not yet departed, and run by active members who haven't blocked the
 * searcher (or been blocked by them) are ever returned.
 */
@Injectable()
export class DiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async search(user: AuthUser, query: SearchQuery): Promise<PageResponse<TripCard>> {
    const offset = decodeOffsetCursor(query.cursor);
    const near = this.near(query);
    const tsQuery = query.q ? toPrefixTsQuery(query.q) : null;
    const prefs = await this.preferences(user.id);
    const statuses = query.status ?? ['PUBLISHED'];

    const filters: Prisma.Sql[] = [Prisma.sql`t.status::text = ANY(${statuses})`];
    if (query.q) {
      // Text with no letters or digits matches nothing rather than everything.
      filters.push(
        tsQuery
          ? Prisma.sql`t.search_vector @@ to_tsquery('simple', ${tsQuery})`
          : Prisma.sql`false`,
      );
    }
    if (query.mode) filters.push(Prisma.sql`t.mode::text = ${query.mode}`);
    if (query.activityType)
      filters.push(Prisma.sql`t.activity_type::text = ANY(${query.activityType})`);
    if (query.from) {
      filters.push(Prisma.sql`lower(t.origin_name) LIKE ${`%${escapeLike(query.from)}%`}`);
    }
    if (query.to) {
      filters.push(Prisma.sql`lower(t.destination_name) LIKE ${`%${escapeLike(query.to)}%`}`);
    }
    if (query.departFrom) filters.push(Prisma.sql`t.departure_at >= ${new Date(query.departFrom)}`);
    if (query.departTo) filters.push(Prisma.sql`t.departure_at <= ${new Date(query.departTo)}`);
    if (query.budgetMinPaise !== undefined) {
      filters.push(Prisma.sql`t.estimated_budget_paise >= ${query.budgetMinPaise}`);
    }
    if (query.budgetMaxPaise !== undefined) {
      filters.push(Prisma.sql`t.estimated_budget_paise <= ${query.budgetMaxPaise}`);
    }
    if (query.minSeats !== undefined) {
      filters.push(Prisma.sql`t.max_participants - pc.n >= ${query.minSeats}`);
    }
    if (query.difficulty) filters.push(Prisma.sql`t.difficulty::text = ANY(${query.difficulty})`);
    if (query.bikeCategory) {
      filters.push(Prisma.sql`t.mode = 'RIDE' AND (coalesce(cardinality(t.bike_categories), 0) = 0
        OR ${query.bikeCategory}::"MotorcycleCategory" = ANY(t.bike_categories))`);
    }
    if (query.engineCc !== undefined) {
      filters.push(
        Prisma.sql`t.mode = 'RIDE' AND (t.min_engine_cc IS NULL OR t.min_engine_cc <= ${query.engineCc})`,
      );
    }
    if (near) filters.push(withinSql(near));

    const textRank = tsQuery
      ? Prisma.sql`ts_rank_cd(t.search_vector, to_tsquery('simple', ${tsQuery}), 32)`
      : Prisma.sql`NULL::float8`;
    const inner = this.cardSelect(user.id, filters, near, textRank, prefs);
    const w = RANKING_WEIGHTS;
    const order =
      query.sort === 'departure'
        ? Prisma.sql`s.departure_at ASC, s.id ASC`
        : query.sort === 'proximity'
          ? Prisma.sql`s.distance_m ASC, s.id ASC`
          : Prisma.sql`(
              ${w.text} * coalesce(s.text_rank, 0)
              + ${w.proximity} * ${near ? Prisma.sql`greatest(0, 1 - s.distance_m / ${near.radiusMeters})` : Prisma.sql`0`}
              + ${w.soonness} * greatest(0, 1 - extract(epoch FROM (s.departure_at - now())) / ${SOONNESS_HORIZON_SECONDS})
              + ${w.openPlaces} * (s.max_participants - s.participant_count)::float8 / s.max_participants
              + ${w.preference} * (CASE WHEN s.pref_match THEN 1 ELSE 0 END)
            ) DESC, s.departure_at ASC, s.id ASC`;

    const rows = await this.prisma.$queryRaw<CardRow[]>`
      SELECT * FROM (${inner}) s ORDER BY ${order} LIMIT ${query.limit + 1} OFFSET ${offset}`;
    return this.toCards(rows, offset, query.limit, query.q);
  }

  /** Trips whose meeting point is near the given point, closest first. */
  async nearby(user: AuthUser, query: NearbyQuery): Promise<PageResponse<TripCard>> {
    return this.search(user, {
      lat: query.lat,
      lng: query.lng,
      radiusKm: query.radiusKm,
      mode: query.mode,
      limit: query.limit,
      cursor: query.cursor,
      sort: 'proximity',
    });
  }

  /**
   * Upcoming open trips (next 60 days) ordered by people who joined in the last 7 days, then by
   * how full they are, then by departure.
   */
  async trending(user: AuthUser, query: TrendingQuery): Promise<PageResponse<TripCard>> {
    const offset = decodeOffsetCursor(query.cursor);
    const near = this.near(query);
    const prefs = await this.preferences(user.id);
    const filters: Prisma.Sql[] = [
      Prisma.sql`t.status = 'PUBLISHED'`,
      Prisma.sql`t.departure_at <= now() + make_interval(days => ${TRENDING_WINDOW_DAYS})`,
    ];
    if (query.mode) filters.push(Prisma.sql`t.mode::text = ${query.mode}`);
    if (near) filters.push(withinSql(near));
    const inner = this.cardSelect(user.id, filters, near, Prisma.sql`NULL::float8`, prefs);
    const rows = await this.prisma.$queryRaw<CardRow[]>`
      SELECT s.*, (
          SELECT count(*)::int FROM "trip_participants" p
          WHERE p.trip_id = s.id AND p.status = 'ACTIVE' AND p.role <> 'ORGANISER'
            AND p.joined_at > now() - interval '7 days'
        ) AS recent_joins
      FROM (${inner}) s
      ORDER BY recent_joins DESC,
        s.participant_count::float8 / s.max_participants DESC,
        s.departure_at ASC, s.id ASC
      LIMIT ${query.limit + 1} OFFSET ${offset}`;
    return this.toCards(rows, offset, query.limit);
  }

  /** Destinations of upcoming open trips, most trips first. Grouped by name, ignoring case. */
  async destinations(
    user: AuthUser,
    query: DestinationsQuery,
  ): Promise<PageResponse<DestinationSummary>> {
    const offset = decodeOffsetCursor(query.cursor);
    const filters: Prisma.Sql[] = [
      Prisma.sql`t.status = 'PUBLISHED'`,
      Prisma.sql`t.destination IS NOT NULL`,
    ];
    if (query.mode) filters.push(Prisma.sql`t.mode::text = ${query.mode}`);
    if (query.q)
      filters.push(Prisma.sql`lower(t.destination_name) LIKE ${`${escapeLike(query.q)}%`}`);
    const rows = await this.prisma.$queryRaw<
      { name: string; lat: number; lng: number; trip_count: number; next_departure_at: Date }[]
    >`
      SELECT mode() WITHIN GROUP (ORDER BY t.destination_name) AS name,
        ST_Y(ST_Centroid(ST_Collect(t.destination::geometry))) AS lat,
        ST_X(ST_Centroid(ST_Collect(t.destination::geometry))) AS lng,
        count(*)::int AS trip_count,
        min(t.departure_at) AS next_departure_at
      ${this.discoverableFrom(user.id)}
        AND ${Prisma.join(filters, ' AND ')}
      GROUP BY lower(btrim(t.destination_name))
      ORDER BY trip_count DESC, next_departure_at ASC, lower(btrim(t.destination_name)) ASC
      LIMIT ${query.limit + 1} OFFSET ${offset}`;
    const page = offsetPage(rows, offset, query.limit);
    return {
      data: page.data.map((row) => ({
        name: row.name,
        point: { latitude: roundTo(row.lat, 3), longitude: roundTo(row.lng, 3) },
        tripCount: row.trip_count,
        nextDepartureAt: row.next_departure_at.toISOString(),
      })),
      page: page.page,
    };
  }

  // ── SQL building ──────────────────────────────────────────────────────────

  /**
   * FROM/WHERE shared by every discovery query. The literal status and visibility predicates
   * match the partial indexes from migration 20261120110000_discovery.
   */
  private discoverableFrom(userId: string): Prisma.Sql {
    return Prisma.sql`
      FROM "trips" t
      JOIN "users" o ON o.id = t.organiser_id
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS n FROM "trip_participants" p
        WHERE p.trip_id = t.id AND p.status = 'ACTIVE'
      ) pc
      WHERE t.deleted_at IS NULL
        AND t.visibility = 'PUBLIC'
        AND t.status IN ('PUBLISHED', 'FULL')
        AND t.trip_type = 'COMMUNITY_FREE'
        AND t.departure_at > now()
        AND t.origin IS NOT NULL
        AND o.status = 'ACTIVE' AND o.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "user_blocks" b
          WHERE (b.blocker_id = t.organiser_id AND b.blocked_id = ${userId}::uuid)
             OR (b.blocker_id = ${userId}::uuid AND b.blocked_id = t.organiser_id)
        )`;
  }

  private cardSelect(
    userId: string,
    filters: Prisma.Sql[],
    near: Near | null,
    textRank: Prisma.Sql,
    prefs: { activities: string[]; mode: string | null },
  ): Prisma.Sql {
    const distance = near
      ? Prisma.sql`ST_Distance(t.origin, ${geographyPoint(near.point)})`
      : Prisma.sql`NULL::float8`;
    return Prisma.sql`
      SELECT t.id, t.mode::text AS mode, t.activity_type::text AS activity_type,
        t.status::text AS status, t.title, t.cover_image_key, t.origin_name, t.destination_name,
        ST_Y(t.origin::geometry) AS olat, ST_X(t.origin::geometry) AS olng,
        ST_Y(t.destination::geometry) AS dlat, ST_X(t.destination::geometry) AS dlng,
        t.departure_at, t.return_at, t.max_participants::int AS max_participants,
        pc.n AS participant_count, t.estimated_budget_paise, t.currency,
        t.difficulty::text AS difficulty, t.min_engine_cc::int AS min_engine_cc,
        t.bike_categories::text[] AS bike_categories,
        t.route_distance_meters, t.route_duration_seconds, t.route_travel_mode,
        o.username::text AS organiser_username, o.display_name AS organiser_display_name,
        ${distance} AS distance_m,
        ${textRank} AS text_rank,
        (t.activity_type::text = ANY(${prefs.activities}::text[])
          OR t.mode::text = ${prefs.mode}::text) IS TRUE AS pref_match
      ${this.discoverableFrom(userId)}
        AND ${Prisma.join(filters, ' AND ')}`;
  }

  private near(query: {
    lat?: number | undefined;
    lng?: number | undefined;
    radiusKm?: number | undefined;
  }): Near | null {
    if (query.lat === undefined || query.lng === undefined) return null;
    const radiusKm = query.radiusKm ?? this.config.DISCOVERY_DEFAULT_RADIUS_KM;
    if (radiusKm > this.config.DISCOVERY_MAX_RADIUS_KM) {
      throw new BadRequestException({
        message: 'Validation failed',
        details: [
          {
            path: 'query.radiusKm',
            message: `Search within ${this.config.DISCOVERY_MAX_RADIUS_KM} km or less`,
          },
        ],
      });
    }
    return { point: { latitude: query.lat, longitude: query.lng }, radiusMeters: radiusKm * 1000 };
  }

  private async preferences(userId: string) {
    const prefs = await this.prisma.userPreference.findUnique({
      where: { userId },
      select: { preferredActivities: true, preferredMode: true },
    });
    return { activities: prefs?.preferredActivities ?? [], mode: prefs?.preferredMode ?? null };
  }

  private toCards(
    rows: CardRow[],
    offset: number,
    limit: number,
    query?: string,
  ): PageResponse<TripCard> {
    const page = offsetPage(rows, offset, limit);
    const now = new Date();
    return {
      data: page.data.map((row) => {
        const seatsLeft = Math.max(0, row.max_participants - row.participant_count);
        return {
          id: row.id,
          mode: row.mode,
          activityType: row.activity_type,
          status: row.status,
          title: row.title,
          coverImageUrl: this.cloudinary.coverUrl(row.cover_image_key),
          origin: {
            name: row.origin_name,
            point: { latitude: roundTo(row.olat, 2), longitude: roundTo(row.olng, 2) },
            approximate: true,
          },
          destination: {
            name: row.destination_name,
            point:
              row.dlat === null || row.dlng === null
                ? null
                : { latitude: row.dlat, longitude: row.dlng },
          },
          departureAt: row.departure_at.toISOString(),
          returnAt: row.return_at?.toISOString() ?? null,
          maxParticipants: row.max_participants,
          participantCount: row.participant_count,
          seatsLeft,
          estimatedBudgetPaise: row.estimated_budget_paise,
          currency: row.currency,
          difficulty: row.difficulty,
          minEngineCc: row.min_engine_cc,
          bikeCategories: row.bike_categories ?? [],
          route:
            row.route_distance_meters !== null &&
            row.route_duration_seconds !== null &&
            row.route_travel_mode !== null
              ? {
                  distanceMeters: row.route_distance_meters,
                  durationSeconds: row.route_duration_seconds,
                  travelMode: row.route_travel_mode,
                  source: 'GOOGLE' as const,
                }
              : null,
          organiser: {
            username: row.organiser_username,
            displayName: row.organiser_display_name,
          },
          straightLineKm: row.distance_m === null ? null : wholeKm(row.distance_m),
          matchReasons: matchReasons({
            query,
            textRank: row.text_rank,
            distanceMeters: row.distance_m,
            departureAt: row.departure_at,
            seatsLeft,
            preferenceMatch: row.pref_match,
            recentJoins: row.recent_joins,
            now,
          }),
        };
      }),
      page: page.page,
    };
  }
}

function withinSql(near: Near): Prisma.Sql {
  return Prisma.sql`ST_DWithin(t.origin, ${geographyPoint(near.point)}, ${near.radiusMeters})`;
}
