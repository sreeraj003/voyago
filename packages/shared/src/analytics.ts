import { z } from 'zod';
import { TripModeSchema } from './trip-mode.js';
import { ActivityTypeSchema } from './users.js';

/**
 * Product analytics: the event dictionary. Events are first-party (stored in Voyago's own
 * database), carry a pseudonymous actor key instead of a user id, and only the properties listed
 * here: never names, contact details, free text, ids of other people, or coordinates. Anything a
 * call site passes that is not in an event's schema is dropped.
 */

const tripProps = { mode: TripModeSchema, activityType: ActivityTypeSchema };
const TripTypeSchema = z.enum(['COMMUNITY_FREE', 'COMMERCIAL_PAID']);
const Count = z.number().int().min(0).max(100_000);
const Paise = z.number().int().min(0).max(100_000_000);

export const ANALYTICS_EVENTS = {
  /** A new account. `method` is how they signed up. */
  account_registered: {
    description: 'A new account was created.',
    properties: z.object({ method: z.enum(['email', 'phone', 'google', 'apple']) }),
  },
  /** First time the profile has a bio, home city, a language and an interest. */
  profile_completed: {
    description: 'The profile was filled in for the first time.',
    properties: z.object({}),
  },
  trip_created: {
    description: 'A trip was created (as a draft).',
    properties: z.object({ ...tripProps, tripType: TripTypeSchema }),
  },
  trip_published: {
    description: 'A trip was published and can be found.',
    properties: z.object({ ...tripProps, tripType: TripTypeSchema }),
  },
  /** At most once per member, trip and day; organisers viewing their own trips are not counted. */
  trip_viewed: {
    description: 'Someone other than its organisers opened a trip.',
    properties: z.object({ mode: TripModeSchema, participant: z.boolean() }),
  },
  join_requested: {
    description: 'A member asked to join a trip (or joined one that needs no approval).',
    properties: z.object({ mode: TripModeSchema, approvalRequired: z.boolean() }),
  },
  join_approved: {
    description: 'A join request was approved (or a member joined without approval).',
    properties: z.object({ mode: TripModeSchema, automatic: z.boolean() }),
  },
  trip_started: {
    description: 'A trip started.',
    properties: z.object({ ...tripProps, participants: Count }),
  },
  trip_completed: {
    description: 'A trip was completed.',
    properties: z.object({ ...tripProps, participants: Count }),
  },
  trip_cancelled: {
    description: 'A trip was cancelled.',
    properties: z.object({ mode: TripModeSchema, by: z.enum(['organiser', 'staff']) }),
  },
  community_joined: {
    description: 'A member joined a community (or asked to, for a private one).',
    properties: z.object({ pending: z.boolean() }),
  },
  booking_started: {
    description: 'Places on a paid experience were held and payment started.',
    properties: z.object({ seats: Count, amountPaise: Paise }),
  },
  booking_confirmed: {
    description: 'A booking was paid and confirmed.',
    properties: z.object({ seats: Count, amountPaise: Paise }),
  },
  subscription_started: {
    description: 'A paid plan was switched on after its first payment.',
    properties: z.object({ tier: z.enum(['EXPLORER_PRO', 'ORGANISER_PRO']), pricePaise: Paise }),
  },
  /** Recorded once per member per day (India time) on their first signed-in request. */
  user_active: {
    description: 'A signed-in member used the app that day.',
    properties: z.object({}),
  },
} as const satisfies Record<string, { description: string; properties: z.ZodObject }>;

export type AnalyticsEventName = keyof typeof ANALYTICS_EVENTS;
export const ANALYTICS_EVENT_NAMES = Object.keys(ANALYTICS_EVENTS) as AnalyticsEventName[];
export type AnalyticsProps<N extends AnalyticsEventName> = z.input<
  (typeof ANALYTICS_EVENTS)[N]['properties']
>;

// ── Admin metrics ───────────────────────────────────────────────────────────

export const MetricsQuerySchema = z.object({
  /** Days back from today (India time), 7 to 365. */
  days: z.coerce.number().int().min(7).max(365).default(30),
});
export type MetricsQuery = z.input<typeof MetricsQuerySchema>;

const Rate = z.number().nullable();

export const BusinessMetricsSchema = z.object({
  generatedAt: z.string(),
  period: z.object({ from: z.string(), to: z.string(), days: z.number().int() }),
  northStar: z.object({
    /** Completed trips with at least two people on them, per calendar month (India time). */
    label: z.string(),
    months: z.array(z.object({ month: z.string(), value: z.number().int() })),
  }),
  engagement: z.object({
    dau: z.number().int(),
    mau: z.number().int(),
    /** Percent; null with no monthly actives. */
    stickiness: Rate,
    daily: z.array(z.object({ date: z.string(), active: z.number().int() })),
  }),
  growth: z.object({
    registrations: z.number().int(),
    /** Percent of those registrations that requested to join or created a trip within 30 days. */
    registrationConversion: Rate,
    /** Percent of those registrations that completed their profile. */
    profileCompletion: Rate,
    /** Percent of members registered 30 to 60 days ago who were active 30+ days after joining. */
    retention30: Rate,
  }),
  trips: z.object({
    created: z.number().int(),
    published: z.number().int(),
    /** Percent of trips published in the period that got at least one join request. */
    withJoinRequests: Rate,
    /** Percent of trips that departed in the period and were completed, of those that ended. */
    completionRate: Rate,
    /** Percent of organisers with a published trip in the period who have published before. */
    repeatOrganiserRate: Rate,
  }),
  money: z.object({
    currency: z.literal('INR'),
    /** Confirmed bookings by confirmation date, before refunds. */
    gmvPaise: z.number().int(),
    /** Commission and its reversals from the ledger (tax on commission excluded). */
    commissionPaise: z.number().int(),
    /** Monthly recurring revenue of subscriptions that will renew. */
    mrrPaise: z.number().int(),
    subscriptionRevenuePaise: z.number().int(),
    /** Percent of captured money refunded (bookings and subscriptions). */
    refundRate: Rate,
    /** Percent of payment attempts that were captured. */
    paymentSuccessRate: Rate,
    /** Commission + subscription revenue (net of its refunds) − provider fees and their tax. */
    contributionMarginPaise: z.number().int(),
    providerFeesPaise: z.number().int(),
  }),
  /** How many events of each kind were recorded in the period (privacy-safe counts). */
  events: z.array(z.object({ name: z.string(), count: z.number().int() })),
});
export type BusinessMetrics = z.infer<typeof BusinessMetricsSchema>;

export const JobStatusSchema = z.object({
  name: z.string(),
  description: z.string(),
  intervalSeconds: z.number().int(),
  lastStartedAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  runs: z.number().int(),
  failures: z.number().int(),
  /** No success for three intervals, or failing now. */
  healthy: z.boolean(),
});
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const SystemStatusSchema = z.object({
  generatedAt: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().int(),
  dependencies: z.array(
    z.object({ name: z.string(), up: z.boolean(), latencyMs: z.number().int().nullable() }),
  ),
  http: z.object({
    /** Since the process started. */
    requests: z.number().int(),
    serverErrors: z.number().int(),
    p50Ms: z.number().nullable(),
    p95Ms: z.number().nullable(),
    slowest: z.array(
      z.object({ route: z.string(), count: z.number().int(), p95Ms: z.number().nullable() }),
    ),
  }),
  jobs: z.array(JobStatusSchema),
  payments: z.object({
    /** Provider events received but not applied for over 10 minutes. */
    stuckWebhooks: z.number().int(),
    invalidSignatures24h: z.number().int(),
    failedRefunds: z.number().int(),
    amountMismatches: z.number().int(),
  }),
  moderation: z.object({
    open: z.number().int(),
    /** Reports past their response target (see the moderation SLA). */
    overdue: z.number().int(),
    oldestOpenHours: z.number().nullable(),
  }),
  clientErrors24h: z.number().int(),
});
export type SystemStatus = z.infer<typeof SystemStatusSchema>;

/** Hours to the first response on a report, by severity (docs/OPERATIONS.md). */
export const MODERATION_SLA_HOURS = { CRITICAL: 1, HIGH: 4, MEDIUM: 24, LOW: 72 } as const;

/** A crash or unhandled error from the apps. No personal data, no screen contents. */
export const ClientErrorSchema = z.object({
  platform: z.enum(['ios', 'android', 'web', 'admin']),
  appVersion: z.string().trim().max(40),
  /** The error's class and message, trimmed. */
  message: z.string().trim().min(1).max(500),
  /** Up to 30 stack lines of code locations. */
  stack: z.string().max(4000).optional(),
  fatal: z.boolean().default(false),
  /** The screen's route pattern, e.g. /trips/[id] (never the filled-in path). */
  route: z.string().max(120).optional(),
});
export type ClientErrorInput = z.input<typeof ClientErrorSchema>;
