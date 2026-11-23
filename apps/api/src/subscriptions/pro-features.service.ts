import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  type BulkJoinRequestsSchema,
  type CreateSavedSearchSchema,
  DiscoverySearchQuerySchema,
  type OrganiserInsights,
  type PageResponse,
  type ProfileStyle,
  SAVED_SEARCHES_MAX,
  type SavedSearch,
  type TravelStats,
  type TripCard,
  type UpdateProfileStyleSchema,
  type UpdateSavedSearchSchema,
} from '@voyago/shared';
import { type z } from 'zod';
import { type AuthUser } from '../common/auth/current-user.decorator.js';
import { PrismaService } from '../database/prisma.service.js';
import { DiscoveryService } from '../discovery/discovery.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ParticipationService } from '../participation/participation.service.js';
import { EntitlementsService } from './entitlements.service.js';
import { JobMonitor } from '../observability/job-monitor.service.js';

const ALERT_SWEEP_MS = 60 * 60_000;
/** Saved queries never carry paging; it comes from the request that runs them. */
const PAGING_KEYS = new Set(['cursor', 'limit']);
type SavedQuery = Record<string, string | string[]>;

const savedSearchSelect = {
  id: true,
  name: true,
  query: true,
  alerts: true,
  lastAlertedAt: true,
  createdAt: true,
} as const satisfies Prisma.SavedSearchSelect;

function toSavedSearch(
  row: Prisma.SavedSearchGetPayload<{ select: typeof savedSearchSelect }>,
): SavedSearch {
  return {
    id: row.id,
    name: row.name,
    query: row.query as SavedQuery,
    alerts: row.alerts,
    lastAlertedAt: row.lastAlertedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Checks a saved query exactly as a search would, and returns it without paging. */
function checkQuery(query: SavedQuery): SavedQuery {
  const clean: SavedQuery = {};
  for (const [key, value] of Object.entries(query)) {
    if (!PAGING_KEYS.has(key)) clean[key] = value;
  }
  const parsed = DiscoverySearchQuerySchema.safeParse(clean);
  if (!parsed.success) {
    throw new BadRequestException({
      message: 'This search has filters that are not valid',
      details: parsed.error.issues.map((i) => ({
        path: ['query', ...i.path].join('.'),
        message: i.message,
      })),
    });
  }
  return clean;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : null);

/**
 * The paid features. Each one asks EntitlementsService first, so a plan that lapsed stops working
 * at once; the free parts (basic stats, single approvals, every discovery filter) never do.
 */
@Injectable()
export class ProFeaturesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProFeaturesService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly discovery: DiscoveryService,
    private readonly participation: ParticipationService,
    private readonly notifications: NotificationsService,
    private readonly jobs: JobMonitor,
  ) {}

  onModuleInit(): void {
    this.timer = this.jobs.every(
      'saved-search-alerts',
      'Sends new-trip alerts for saved searches',
      ALERT_SWEEP_MS,
      () => this.sendAlerts(),
    );
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  // ── Saved searches (Explorer Pro) ─────────────────────────────────────────

  async listSavedSearches(userId: string): Promise<SavedSearch[]> {
    // Listing stays open after a plan ends, so members can see and delete what they saved.
    const rows = await this.prisma.savedSearch.findMany({
      where: { userId },
      select: savedSearchSelect,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toSavedSearch);
  }

  async createSavedSearch(
    userId: string,
    input: z.output<typeof CreateSavedSearchSchema>,
  ): Promise<SavedSearch> {
    await this.entitlements.require(userId, 'saved_searches');
    if (input.alerts) await this.entitlements.require(userId, 'trip_alerts');
    const query = checkQuery(input.query);
    const count = await this.prisma.savedSearch.count({ where: { userId } });
    if (count >= SAVED_SEARCHES_MAX) {
      throw new ConflictException(`You can keep up to ${SAVED_SEARCHES_MAX} saved searches`);
    }
    try {
      const row = await this.prisma.savedSearch.create({
        data: { userId, name: input.name, query, alerts: input.alerts, lastAlertedAt: new Date() },
        select: savedSearchSelect,
      });
      return toSavedSearch(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('You already have a saved search with this name');
      }
      // The database trigger that enforces the limit under concurrency.
      if (error instanceof Error && error.message.includes('saved_searches_max')) {
        throw new ConflictException(`You can keep up to ${SAVED_SEARCHES_MAX} saved searches`);
      }
      throw error;
    }
  }

  async updateSavedSearch(
    userId: string,
    id: string,
    input: z.output<typeof UpdateSavedSearchSchema>,
  ): Promise<SavedSearch> {
    await this.entitlements.require(userId, 'saved_searches');
    if (input.alerts) await this.entitlements.require(userId, 'trip_alerts');
    await this.ownSavedSearch(userId, id);
    try {
      const row = await this.prisma.savedSearch.update({
        where: { id },
        data: {
          ...input,
          // Turning alerts on starts from now, not from when the search was saved.
          ...(input.alerts ? { lastAlertedAt: new Date() } : {}),
        },
        select: savedSearchSelect,
      });
      return toSavedSearch(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('You already have a saved search with this name');
      }
      throw error;
    }
  }

  /** Free: anyone can delete what they saved, plan or not. */
  async deleteSavedSearch(userId: string, id: string): Promise<void> {
    await this.ownSavedSearch(userId, id);
    await this.prisma.savedSearch.delete({ where: { id } });
  }

  async runSavedSearch(
    user: AuthUser,
    id: string,
    page: { limit: number; cursor?: string | undefined },
  ): Promise<PageResponse<TripCard>> {
    await this.entitlements.require(user.id, 'saved_searches');
    const saved = await this.ownSavedSearch(user.id, id);
    const query = DiscoverySearchQuerySchema.parse({
      ...checkQuery(saved.query as SavedQuery),
      limit: page.limit,
      ...(page.cursor ? { cursor: page.cursor } : {}),
    });
    return this.discovery.search(user, query);
  }

  private async ownSavedSearch(userId: string, id: string) {
    const row = await this.prisma.savedSearch.findUnique({ where: { id } });
    if (!row || row.userId !== userId) throw new NotFoundException('Saved search not found');
    return row;
  }

  /**
   * New-trip alerts: one notification per saved search with trips published since the last
   * check. Only for members whose plan includes alerts at the time of the check.
   */
  async sendAlerts(now = new Date()): Promise<number> {
    const searches = await this.prisma.savedSearch.findMany({
      where: { alerts: true },
      select: {
        id: true,
        userId: true,
        name: true,
        query: true,
        lastAlertedAt: true,
        createdAt: true,
      },
      orderBy: { lastAlertedAt: { sort: 'asc', nulls: 'first' } },
      take: 500,
    });
    const entitled = new Map<string, boolean>();
    let sent = 0;
    for (const search of searches) {
      if (!entitled.has(search.userId)) {
        entitled.set(search.userId, await this.entitlements.has(search.userId, 'trip_alerts', now));
      }
      if (!entitled.get(search.userId)) continue;
      const user = await this.prisma.user.findUnique({
        where: { id: search.userId },
        select: { id: true, role: true, status: true, deletedAt: true },
      });
      if (!user || user.status !== 'ACTIVE' || user.deletedAt) continue;
      let found: PageResponse<TripCard>;
      try {
        const query = DiscoverySearchQuerySchema.parse({
          ...checkQuery(search.query as SavedQuery),
          limit: 20,
          sort: 'departure',
        });
        found = await this.discovery.search(
          { id: user.id, role: user.role, sessionFamilyId: '' },
          query,
          { publishedAfter: search.lastAlertedAt ?? search.createdAt },
        );
      } catch (error) {
        this.logger.warn(`Saved search ${search.id} could not run: ${(error as Error).message}`);
        continue;
      }
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.savedSearch.updateMany({
          where: { id: search.id, lastAlertedAt: search.lastAlertedAt },
          data: { lastAlertedAt: now },
        });
        if (claimed.count === 0 || found.data.length === 0) return;
        const first = found.data[0]!;
        const more = found.data.length > 1;
        await this.notifications.notify(tx, [search.userId], {
          type: 'SYSTEM',
          title: more
            ? `${found.data.length}${found.page.hasMore ? '+' : ''} new trips match “${search.name}”`
            : `New trip for “${search.name}”`,
          body: more ? `Including ${first.title}` : first.title,
          data: more
            ? { savedSearchId: search.id }
            : { savedSearchId: search.id, tripId: first.id },
        });
        sent += 1;
      });
    }
    return sent;
  }

  // ── Travel stats ──────────────────────────────────────────────────────────

  async travelStats(userId: string): Promise<TravelStats> {
    const now = new Date();
    const onTrip = {
      userId,
      status: { in: ['ACTIVE', 'COMPLETED'] as ('ACTIVE' | 'COMPLETED')[] },
    };
    const [tripsJoined, tripsOrganised, upcoming] = await Promise.all([
      this.prisma.tripParticipant.count({
        where: { ...onTrip, role: { not: 'ORGANISER' }, trip: { deletedAt: null } },
      }),
      this.prisma.trip.count({
        where: { organiserId: userId, deletedAt: null, status: { not: 'DRAFT' } },
      }),
      this.prisma.tripParticipant.count({
        where: {
          userId,
          status: 'ACTIVE',
          trip: {
            deletedAt: null,
            status: { in: ['PUBLISHED', 'FULL'] },
            departureAt: { gt: now },
          },
        },
      }),
    ]);
    const basic = { tripsJoined, tripsOrganised, upcoming };
    if (!(await this.entitlements.has(userId, 'travel_stats'))) return { basic, enhanced: null };

    // Completed trips the member was on to the end.
    const done = Prisma.sql`
      SELECT t.id, t.activity_type, t.destination_name, t.departure_at,
        coalesce(round(t.route_distance_meters / 1000.0), t.estimated_distance_km, 0)::int AS km
      FROM "trip_participants" p JOIN "trips" t ON t.id = p.trip_id
      WHERE p.user_id = ${userId}::uuid AND t.deleted_at IS NULL
        AND t.status = 'COMPLETED' AND p.status IN ('ACTIVE', 'COMPLETED')`;
    const [totals, byActivity, byMonth] = await Promise.all([
      this.prisma.$queryRaw<
        { completed: number; km: number; destinations: number; companions: number }[]
      >`
        WITH d AS (${done})
        SELECT count(*)::int AS completed,
          coalesce(sum(d.km), 0)::int AS km,
          count(DISTINCT lower(btrim(d.destination_name)))::int AS destinations,
          (SELECT count(DISTINCT o.user_id)::int FROM "trip_participants" o
            WHERE o.trip_id IN (SELECT id FROM d) AND o.user_id <> ${userId}::uuid
              AND o.status IN ('ACTIVE', 'COMPLETED')) AS companions
        FROM d`,
      this.prisma.$queryRaw<{ activity_type: string; trips: number }[]>`
        WITH d AS (${done})
        SELECT d.activity_type::text AS activity_type, count(*)::int AS trips
        FROM d GROUP BY 1 ORDER BY 2 DESC, 1`,
      this.prisma.$queryRaw<{ month: string; trips: number }[]>`
        WITH d AS (${done})
        SELECT to_char(d.departure_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS month,
          count(*)::int AS trips
        FROM d WHERE d.departure_at > now() - interval '12 months'
        GROUP BY 1 ORDER BY 1`,
    ]);
    const t = totals[0] ?? { completed: 0, km: 0, destinations: 0, companions: 0 };
    return {
      basic,
      enhanced: {
        completed: t.completed,
        byActivity: byActivity.map((r) => ({ activityType: r.activity_type, trips: r.trips })),
        distanceKm: t.km,
        destinations: t.destinations,
        byMonth,
        companions: t.companions,
      },
    };
  }

  // ── Organiser insights (Organiser Pro) ────────────────────────────────────

  async organiserInsights(userId: string): Promise<OrganiserInsights> {
    await this.entitlements.require(userId, 'organiser_insights');
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        title: string;
        status: string;
        departure_at: Date;
        capacity: number;
        participants: number;
        left_count: number;
        total: number;
        approved: number;
        rejected: number;
        pending: number;
        withdrawn: number;
        avg_hours: number | null;
      }[]
    >`
      SELECT t.id, t.title, t.status::text AS status, t.departure_at,
        t.max_participants::int AS capacity,
        (SELECT count(*)::int FROM "trip_participants" p
          WHERE p.trip_id = t.id AND p.status IN ('ACTIVE', 'COMPLETED')) AS participants,
        (SELECT count(*)::int FROM "trip_participants" p
          WHERE p.trip_id = t.id AND p.status = 'LEFT') AS left_count,
        count(r.id)::int AS total,
        count(r.id) FILTER (WHERE r.status = 'APPROVED')::int AS approved,
        count(r.id) FILTER (WHERE r.status = 'REJECTED')::int AS rejected,
        count(r.id) FILTER (WHERE r.status = 'PENDING')::int AS pending,
        count(r.id) FILTER (WHERE r.status = 'WITHDRAWN')::int AS withdrawn,
        (avg(extract(epoch FROM (r.decided_at - r.created_at)) / 3600)
          FILTER (WHERE r.status IN ('APPROVED', 'REJECTED') AND r.decided_at IS NOT NULL))::float8
          AS avg_hours
      FROM "trips" t
      LEFT JOIN "trip_join_requests" r ON r.trip_id = t.id
      WHERE t.organiser_id = ${userId}::uuid AND t.deleted_at IS NULL AND t.status <> 'DRAFT'
      GROUP BY t.id
      ORDER BY t.departure_at DESC
      LIMIT 50`;
    const trips = rows.map((r) => ({
      tripId: r.id,
      title: r.title,
      status: r.status,
      departureAt: r.departure_at.toISOString(),
      capacity: r.capacity,
      participants: r.participants,
      fillPercent: pct(r.participants, r.capacity) ?? 0,
      requests: {
        total: r.total,
        approved: r.approved,
        rejected: r.rejected,
        pending: r.pending,
        withdrawn: r.withdrawn,
      },
      avgDecisionHours: r.avg_hours === null ? null : Math.round(r.avg_hours * 10) / 10,
      left: r.left_count,
    }));
    const sum = (f: (t: (typeof trips)[number]) => number) => trips.reduce((a, t) => a + f(t), 0);
    const decided = sum((t) => t.requests.approved + t.requests.rejected);
    return {
      totals: {
        trips: trips.length,
        participants: sum((t) => t.participants),
        requests: sum((t) => t.requests.total),
        approvalPercent: pct(
          sum((t) => t.requests.approved),
          decided,
        ),
        avgFillPercent:
          trips.length > 0 ? Math.round(sum((t) => t.fillPercent) / trips.length) : null,
      },
      trips,
    };
  }

  /**
   * Decide many join requests on one trip. Each goes through the same checks as a single
   * decision (organiser rights, capacity, blocks); one failing doesn't stop the rest.
   */
  async bulkJoinRequests(
    user: AuthUser,
    tripId: string,
    input: z.output<typeof BulkJoinRequestsSchema>,
    auditRequestId?: string,
  ) {
    await this.entitlements.require(user.id, 'bulk_join_requests');
    const ids = [...new Set(input.requestIds)];
    const onTrip = new Set(
      (
        await this.prisma.tripJoinRequest.findMany({
          where: { id: { in: ids }, tripId },
          select: { id: true },
        })
      ).map((r) => r.id),
    );
    const done: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    for (const id of ids) {
      if (!onTrip.has(id)) {
        failed.push({ id, reason: 'Request not found' });
        continue;
      }
      try {
        if (input.action === 'approve') await this.participation.approve(user, id, auditRequestId);
        else await this.participation.reject(user, id, input.reason, auditRequestId);
        done.push(id);
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        failed.push({ id, reason: error.message });
      }
    }
    return { done, failed };
  }

  // ── Profile style ─────────────────────────────────────────────────────────

  async profileStyle(userId: string): Promise<ProfileStyle> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { accentColor: true, profileHeadline: true },
    });
    return {
      accentColor: user.accentColor as ProfileStyle['accentColor'],
      headline: user.profileHeadline,
    };
  }

  async updateProfileStyle(
    userId: string,
    input: z.output<typeof UpdateProfileStyleSchema>,
  ): Promise<ProfileStyle> {
    // Clearing is always allowed; setting needs the plan.
    if (input.accentColor) await this.entitlements.require(userId, 'profile_style');
    if (input.headline) await this.entitlements.require(userId, 'organiser_profile');
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.accentColor !== undefined ? { accentColor: input.accentColor } : {}),
        ...(input.headline !== undefined ? { profileHeadline: input.headline } : {}),
      },
    });
    return this.profileStyle(userId);
  }
}
