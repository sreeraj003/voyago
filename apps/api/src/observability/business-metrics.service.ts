import { Injectable } from '@nestjs/common';
import { type BusinessMetrics } from '@voyago/shared';
import { PrismaService } from '../database/prisma.service.js';
import { ANALYTICS_TIME_ZONE, indiaDay } from './analytics.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const pct = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
const n = (value: bigint | number | null | undefined) => Number(value ?? 0);

/**
 * Business metrics for the admin dashboard, computed from the source tables (money from the
 * ledger and payments, trips from trips) and from analytics events for activity. Aggregates only:
 * nothing here identifies a member. Definitions are in docs/ANALYTICS.md.
 */
@Injectable()
export class BusinessMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async metrics(days: number, now = new Date()): Promise<BusinessMetrics> {
    const from = new Date(now.getTime() - days * DAY_MS);
    const tz = ANALYTICS_TIME_ZONE;
    const db = this.prisma;
    const chartDays = Math.min(days, 90);
    const [
      northStar,
      active,
      daily,
      growth,
      retention,
      trips,
      repeat,
      money,
      subs,
      payments,
      events,
    ] = await Promise.all([
      db.$queryRaw<{ month: string; value: number }[]>`
        SELECT to_char(date_trunc('month', t.completed_at AT TIME ZONE ${tz}), 'YYYY-MM') AS month,
          count(*)::int AS value
        FROM "trips" t
        WHERE t.status = 'COMPLETED' AND t.deleted_at IS NULL
          AND t.completed_at >= (date_trunc('month', ${now}::timestamptz AT TIME ZONE ${tz}) - interval '5 months') AT TIME ZONE ${tz}
          AND (SELECT count(*) FROM "trip_participants" p
               WHERE p.trip_id = t.id AND p.status IN ('ACTIVE', 'COMPLETED')) >= 2
        GROUP BY 1`,
      db.$queryRaw<{ dau: number; mau: number }[]>`
        SELECT
          count(DISTINCT e.actor_key) FILTER (
            WHERE (e.occurred_at AT TIME ZONE ${tz})::date = (${now}::timestamptz AT TIME ZONE ${tz})::date)::int AS dau,
          count(DISTINCT e.actor_key)::int AS mau
        FROM "analytics_events" e
        WHERE e.name = 'user_active' AND e.occurred_at > ${new Date(now.getTime() - 30 * DAY_MS)}`,
      db.$queryRaw<{ date: string; active: number }[]>`
        SELECT to_char((e.occurred_at AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS date,
          count(DISTINCT e.actor_key)::int AS active
        FROM "analytics_events" e
        WHERE e.name = 'user_active' AND e.occurred_at > ${new Date(now.getTime() - chartDays * DAY_MS)}
        GROUP BY 1 ORDER BY 1`,
      db.$queryRaw<{ registrations: number; converted: number; completed: number }[]>`
        SELECT count(*)::int AS registrations,
          count(*) FILTER (WHERE
            EXISTS (SELECT 1 FROM "trips" t WHERE t.organiser_id = u.id
              AND t.created_at < u.created_at + interval '30 days')
            OR EXISTS (SELECT 1 FROM "trip_join_requests" r WHERE r.user_id = u.id
              AND r.created_at < u.created_at + interval '30 days'))::int AS converted,
          count(*) FILTER (WHERE u.profile_completed_at IS NOT NULL)::int AS completed
        FROM "users" u
        WHERE u.created_at >= ${from} AND u.role = 'USER'`,
      db.$queryRaw<{ cohort: number; retained: number }[]>`
        SELECT count(*)::int AS cohort,
          count(*) FILTER (WHERE u.last_active_at >= u.created_at + interval '30 days')::int AS retained
        FROM "users" u
        WHERE u.role = 'USER' AND u.deleted_at IS NULL
          AND u.created_at >= ${new Date(now.getTime() - 60 * DAY_MS)}
          AND u.created_at < ${new Date(now.getTime() - 30 * DAY_MS)}`,
      db.$queryRaw<
        {
          created: number;
          published: number;
          requested: number;
          ended: number;
          completed: number;
        }[]
      >`
        SELECT
          (SELECT count(*)::int FROM "trips" t WHERE t.deleted_at IS NULL AND t.created_at >= ${from}) AS created,
          (SELECT count(*)::int FROM "trips" t WHERE t.deleted_at IS NULL AND t.published_at >= ${from}) AS published,
          (SELECT count(*)::int FROM "trips" t WHERE t.deleted_at IS NULL AND t.published_at >= ${from}
            AND (EXISTS (SELECT 1 FROM "trip_join_requests" r WHERE r.trip_id = t.id)
              OR EXISTS (SELECT 1 FROM "trip_participants" p WHERE p.trip_id = t.id AND p.role <> 'ORGANISER'))) AS requested,
          (SELECT count(*)::int FROM "trips" t WHERE t.deleted_at IS NULL
            AND t.departure_at >= ${from} AND t.departure_at < ${now}
            AND t.status IN ('COMPLETED', 'CANCELLED', 'EXPIRED')) AS ended,
          (SELECT count(*)::int FROM "trips" t WHERE t.deleted_at IS NULL
            AND t.departure_at >= ${from} AND t.departure_at < ${now}
            AND t.status = 'COMPLETED') AS completed`,
      db.$queryRaw<{ organisers: number; repeat: number }[]>`
        WITH o AS (
          SELECT DISTINCT t.organiser_id FROM "trips" t
          WHERE t.deleted_at IS NULL AND t.published_at >= ${from})
        SELECT count(*)::int AS organisers,
          count(*) FILTER (WHERE (SELECT count(*) FROM "trips" t2
            WHERE t2.organiser_id = o.organiser_id AND t2.deleted_at IS NULL
              AND t2.published_at IS NOT NULL) >= 2)::int AS repeat
        FROM o`,
      db.$queryRaw<{ gmv: bigint; commission: bigint; fees: bigint }[]>`
        SELECT
          (SELECT coalesce(sum(b.total_amount_paise), 0) FROM "bookings" b
            WHERE b.confirmed_at >= ${from}) AS gmv,
          (SELECT coalesce(sum(l.amount_paise), 0) FROM "ledger_entries" l
            WHERE l.kind IN ('COMMISSION', 'COMMISSION_REVERSAL') AND l.created_at >= ${from}) AS commission,
          (SELECT coalesce(sum(l.amount_paise), 0) FROM "ledger_entries" l
            WHERE l.kind IN ('PROVIDER_FEE', 'PROVIDER_FEE_TAX') AND l.created_at >= ${from})
          + (SELECT coalesce(sum(coalesce(p.provider_fee_paise, 0)), 0) FROM "payments" p
            WHERE p.subscription_id IS NOT NULL AND p.captured_at >= ${from}) AS fees`,
      db.$queryRaw<{ mrr: bigint; revenue: bigint }[]>`
        SELECT
          (SELECT coalesce(sum(CASE WHEN sp.billing_interval = 'YEARLY' THEN s.price_paise / 12 ELSE s.price_paise END), 0)
            FROM "subscriptions" s JOIN "subscription_plans" sp ON sp.id = s.plan_id
            WHERE s.status IN ('ACTIVE', 'TRIALING', 'PAST_DUE') AND NOT s.cancel_at_period_end) AS mrr,
          (SELECT coalesce(sum(p.amount_paise - p.refunded_amount_paise), 0) FROM "payments" p
            WHERE p.subscription_id IS NOT NULL AND p.captured_at >= ${from}) AS revenue`,
      db.$queryRaw<{ captured: bigint; refunded: bigint; succeeded: number; failed: number }[]>`
        SELECT
          coalesce(sum(p.amount_paise) FILTER (WHERE p.captured_at >= ${from}), 0) AS captured,
          coalesce(sum(p.refunded_amount_paise) FILTER (WHERE p.captured_at >= ${from}), 0) AS refunded,
          count(*) FILTER (WHERE p.created_at >= ${from}
            AND p.status IN ('CAPTURED', 'REFUNDED', 'PARTIALLY_REFUNDED'))::int AS succeeded,
          count(*) FILTER (WHERE p.created_at >= ${from} AND p.status = 'FAILED')::int AS failed
        FROM "payments" p
        WHERE p.created_at >= ${from} OR p.captured_at >= ${from}`,
      db.$queryRaw<{ name: string; count: number }[]>`
        SELECT e.name::text AS name, count(*)::int AS count FROM "analytics_events" e
        WHERE e.occurred_at >= ${from} GROUP BY 1 ORDER BY 1`,
    ]);

    // Every month and day in range, with zeros where nothing happened.
    const months: { month: string; value: number }[] = [];
    const today = indiaDay(now);
    const [y, m] = today.split('-').map(Number) as [number, number];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(y, m - 1 - i, 1));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      months.push({ month: key, value: northStar.find((r) => r.month === key)?.value ?? 0 });
    }
    const dailySeries: { date: string; active: number }[] = [];
    for (let i = chartDays - 1; i >= 0; i--) {
      const date = indiaDay(new Date(now.getTime() - i * DAY_MS));
      dailySeries.push({ date, active: daily.find((r) => r.date === date)?.active ?? 0 });
    }

    const a = active[0] ?? { dau: 0, mau: 0 };
    const g = growth[0] ?? { registrations: 0, converted: 0, completed: 0 };
    const r = retention[0] ?? { cohort: 0, retained: 0 };
    const t = trips[0] ?? { created: 0, published: 0, requested: 0, ended: 0, completed: 0 };
    const o = repeat[0] ?? { organisers: 0, repeat: 0 };
    const mo = money[0];
    const s = subs[0];
    const p = payments[0];
    const commission = n(mo?.commission);
    const revenue = n(s?.revenue);
    const fees = n(mo?.fees);
    return {
      generatedAt: now.toISOString(),
      period: { from: from.toISOString(), to: now.toISOString(), days },
      northStar: { label: 'Completed group trips (2+ people) per month', months },
      engagement: {
        dau: a.dau,
        mau: a.mau,
        stickiness: pct(a.dau, a.mau),
        daily: dailySeries,
      },
      growth: {
        registrations: g.registrations,
        registrationConversion: pct(g.converted, g.registrations),
        profileCompletion: pct(g.completed, g.registrations),
        retention30: pct(r.retained, r.cohort),
      },
      trips: {
        created: t.created,
        published: t.published,
        withJoinRequests: pct(t.requested, t.published),
        completionRate: pct(t.completed, t.ended),
        repeatOrganiserRate: pct(o.repeat, o.organisers),
      },
      money: {
        currency: 'INR',
        gmvPaise: n(mo?.gmv),
        commissionPaise: commission,
        mrrPaise: n(s?.mrr),
        subscriptionRevenuePaise: revenue,
        refundRate: pct(n(p?.refunded), n(p?.captured)),
        paymentSuccessRate: pct(p?.succeeded ?? 0, (p?.succeeded ?? 0) + (p?.failed ?? 0)),
        contributionMarginPaise: commission + revenue - fees,
        providerFeesPaise: fees,
      },
      events,
    };
  }
}
