import { z } from 'zod';
import { PageInfoSchema } from './pagination.js';

/**
 * Subscriptions. The server decides what a member may use (entitlements), from the subscription
 * it holds and the time now; the app only shows it. Safety, blocking, reporting, messaging,
 * creating and joining free trips, and basic discovery are free for everyone, always.
 */

// ── Tiers and entitlements ──────────────────────────────────────────────────

export const TierSchema = z.enum(['FREE', 'EXPLORER_PRO', 'ORGANISER_PRO']);
export type Tier = z.infer<typeof TierSchema>;
export const PaidTierSchema = z.enum(['EXPLORER_PRO', 'ORGANISER_PRO']);
export type PaidTier = z.infer<typeof PaidTierSchema>;

export const EntitlementSchema = z.enum([
  /** Save discovery searches and run them again. */
  'saved_searches',
  /** Get a notification when a new trip matches a saved search. */
  'trip_alerts',
  /** Activity, distance and monthly travel statistics. */
  'travel_stats',
  /** An accent colour on your profile. */
  'profile_style',
  /** A headline on your profile as an organiser. */
  'organiser_profile',
  /** How your trips perform: requests, approvals, fill rate, cancellations. */
  'organiser_insights',
  /** Approve or decline many join requests at once. */
  'bulk_join_requests',
]);
export type Entitlement = z.infer<typeof EntitlementSchema>;

const EXPLORER: readonly Entitlement[] = [
  'saved_searches',
  'trip_alerts',
  'travel_stats',
  'profile_style',
];

/** Organiser Pro includes everything in Explorer Pro. */
export const ENTITLEMENTS_BY_TIER: Record<Tier, readonly Entitlement[]> = {
  FREE: [],
  EXPLORER_PRO: EXPLORER,
  ORGANISER_PRO: [...EXPLORER, 'organiser_profile', 'organiser_insights', 'bulk_join_requests'],
};

export const tierHas = (tier: Tier, entitlement: Entitlement) =>
  ENTITLEMENTS_BY_TIER[tier].includes(entitlement);

/** The cheapest tier that includes an entitlement. */
export const tierFor = (entitlement: Entitlement): PaidTier =>
  tierHas('EXPLORER_PRO', entitlement) ? 'EXPLORER_PRO' : 'ORGANISER_PRO';

export const TIER_NAMES: Record<Tier, string> = {
  FREE: 'Free',
  EXPLORER_PRO: 'Explorer Pro',
  ORGANISER_PRO: 'Organiser Pro',
};

/** Always free: listed on the plans page so nobody wonders whether safety costs money. */
export const ALWAYS_FREE = [
  'Create and join free community trips',
  'Discovery with every filter',
  'Your profile, following and communities',
  'Messages and trip chats',
  'Live location sharing, SOS and emergency contacts',
  'Blocking and reporting',
] as const;

export const SAVED_SEARCHES_MAX = 10;
/** A paid tier keeps working this long past the period end while a renewal charge is retried. */
export const RENEWAL_GRACE_HOURS = 24;
/** Members get a reminder this many days before a renewal. */
export const RENEWAL_REMINDER_DAYS = 3;
/** Ask for a full refund of a renewal you didn't mean within this many days. */
export const RENEWAL_REFUND_DAYS = 7;

/** The terms shown on the plans page and before paying. */
export const SUBSCRIPTION_TERMS = [
  'Billed monthly until you cancel. We remind you 3 days before each renewal.',
  'Cancel any time in the app. You keep the plan until the end of the month you paid for and are not charged again.',
  'No partial-month refunds when you cancel. If a renewal charged you by mistake, ask support within 7 days for a full refund.',
  'If a renewal payment fails, the provider retries for a few days; paid features stop at the end of the paid month.',
  'Price changes apply to new subscriptions only, never to one you already have.',
] as const;

// ── Plans ───────────────────────────────────────────────────────────────────

export const PlanSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  tier: PaidTierSchema,
  name: z.string(),
  description: z.string().nullable(),
  pricePaise: z.number().int(),
  currency: z.string(),
  interval: z.enum(['MONTHLY', 'YEARLY']),
  entitlements: z.array(EntitlementSchema),
  /** Whether it can be bought right now (plan active and payments set up). */
  available: z.boolean(),
});
export type Plan = z.infer<typeof PlanSchema>;

export const PlansResponseSchema = z.object({
  plans: z.array(PlanSchema),
  alwaysFree: z.array(z.string()),
  terms: z.array(z.string()),
  /** Why plans can't be bought now, if they can't. */
  unavailableReason: z.string().nullable(),
});
export type PlansResponse = z.infer<typeof PlansResponseSchema>;

// ── A member's subscription ─────────────────────────────────────────────────

export const SubscriptionStatusSchema = z.enum([
  'PENDING',
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'CANCELLED',
  'EXPIRED',
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

export const SubscriptionPaymentSchema = z.object({
  id: z.uuid(),
  amountPaise: z.number().int(),
  refundedAmountPaise: z.number().int(),
  currency: z.string(),
  status: z.string(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  capturedAt: z.string().nullable(),
});

export const SubscriptionSchema = z.object({
  id: z.uuid(),
  status: SubscriptionStatusSchema,
  plan: z.object({ code: z.string(), tier: PaidTierSchema, name: z.string() }),
  pricePaise: z.number().int(),
  currency: z.string(),
  currentPeriodStart: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  /** No more charges: the plan ends at `currentPeriodEnd`. */
  cancelAtPeriodEnd: z.boolean(),
  cancelledAt: z.string().nullable(),
  /** The next charge, if one is due. */
  renewsAt: z.string().nullable(),
  /** Whether its paid features work right now. */
  entitled: z.boolean(),
  payments: z.array(SubscriptionPaymentSchema),
  /** The payment page while the first payment is due. */
  checkoutUrl: z.string().nullable(),
  createdAt: z.string(),
  actions: z.array(z.enum(['pay', 'cancel'])),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

export const MySubscriptionSchema = z.object({
  tier: TierSchema,
  entitlements: z.array(EntitlementSchema),
  /** The most recent subscription (live or not); null if never subscribed. */
  subscription: SubscriptionSchema.nullable(),
});
export type MySubscription = z.infer<typeof MySubscriptionSchema>;

export const SubscribeSchema = z.object({
  planCode: z.string().trim().min(1).max(60),
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,100}$/, 'Use 16 to 100 letters, digits, _ or -'),
  returnUrl: z.string().max(500).optional(),
});
export type SubscribeInput = z.input<typeof SubscribeSchema>;

export const CancelSubscriptionSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const SubscriptionViewQuerySchema = z.object({
  returnUrl: z.string().max(500).optional(),
});

/**
 * A paid feature used without the plan answers 403 with a detail whose `path` is this and whose
 * `message` is the tier that includes it.
 */
export const UPGRADE_REQUIRED = 'UPGRADE_REQUIRED';

// ── Saved searches ──────────────────────────────────────────────────────────

export const CreateSavedSearchSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** Discovery query string values, as the search screen sends them (checked like a search). */
  query: z.record(z.string(), z.union([z.string().max(200), z.array(z.string().max(60)).max(12)])),
  alerts: z.boolean().default(false),
});
export type CreateSavedSearchInput = z.input<typeof CreateSavedSearchSchema>;

export const UpdateSavedSearchSchema = z
  .object({ name: z.string().trim().min(1).max(60), alerts: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

export const SavedSearchSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  query: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  alerts: z.boolean(),
  lastAlertedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type SavedSearch = z.infer<typeof SavedSearchSchema>;

// ── Stats and insights ──────────────────────────────────────────────────────

export const TravelStatsSchema = z.object({
  /** Free for everyone. */
  basic: z.object({
    tripsJoined: z.number().int(),
    tripsOrganised: z.number().int(),
    upcoming: z.number().int(),
  }),
  /** Explorer Pro and up; null otherwise. */
  enhanced: z
    .object({
      completed: z.number().int(),
      byActivity: z.array(z.object({ activityType: z.string(), trips: z.number().int() })),
      /** Planned route distance of completed trips, in kilometres. */
      distanceKm: z.number().int(),
      destinations: z.number().int(),
      byMonth: z.array(z.object({ month: z.string(), trips: z.number().int() })),
      companions: z.number().int(),
    })
    .nullable(),
});
export type TravelStats = z.infer<typeof TravelStatsSchema>;

export const TripInsightSchema = z.object({
  tripId: z.uuid(),
  title: z.string(),
  status: z.string(),
  departureAt: z.string(),
  capacity: z.number().int(),
  participants: z.number().int(),
  fillPercent: z.number().int(),
  requests: z.object({
    total: z.number().int(),
    approved: z.number().int(),
    rejected: z.number().int(),
    pending: z.number().int(),
    withdrawn: z.number().int(),
  }),
  /** Hours from a request to the decision, on average; null with no decisions. */
  avgDecisionHours: z.number().nullable(),
  left: z.number().int(),
});

export const OrganiserInsightsSchema = z.object({
  totals: z.object({
    trips: z.number().int(),
    participants: z.number().int(),
    requests: z.number().int(),
    approvalPercent: z.number().int().nullable(),
    avgFillPercent: z.number().int().nullable(),
  }),
  trips: z.array(TripInsightSchema),
});
export type OrganiserInsights = z.infer<typeof OrganiserInsightsSchema>;

export const BulkJoinRequestsSchema = z.object({
  action: z.enum(['approve', 'reject']),
  requestIds: z.array(z.uuid()).min(1).max(50),
  reason: z.string().trim().max(300).optional(),
});
export type BulkJoinRequestsInput = z.input<typeof BulkJoinRequestsSchema>;

export const BulkJoinResultSchema = z.object({
  done: z.array(z.uuid()),
  failed: z.array(z.object({ id: z.uuid(), reason: z.string() })),
});

// ── Profile style ───────────────────────────────────────────────────────────

export const ACCENT_COLORS = [
  'teal',
  'indigo',
  'amber',
  'rose',
  'forest',
  'slate',
  'sunset',
  'ocean',
] as const;
export const AccentColorSchema = z.enum(ACCENT_COLORS);

export const ProfileStyleSchema = z.object({
  accentColor: AccentColorSchema.nullable(),
  headline: z.string().nullable(),
});
export type ProfileStyle = z.infer<typeof ProfileStyleSchema>;

export const UpdateProfileStyleSchema = z
  .object({
    accentColor: AccentColorSchema.nullable(),
    headline: z.string().trim().min(3).max(120).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

// ── Admin ───────────────────────────────────────────────────────────────────

export const AdminPlanSchema = PlanSchema.extend({
  isActive: z.boolean(),
  providerPlanId: z.string().nullable(),
  subscribers: z.number().int(),
});
export type AdminPlan = z.infer<typeof AdminPlanSchema>;

export const UpdatePlanSchema = z
  .object({
    pricePaise: z.number().int().min(100).max(10_000_000),
    isActive: z.boolean(),
    description: z.string().trim().max(1000).nullable(),
    reason: z.string().trim().min(5).max(500),
  })
  .partial({ pricePaise: true, isActive: true, description: true });
export type UpdatePlanInput = z.input<typeof UpdatePlanSchema>;

export const AdminSubscriptionSchema = SubscriptionSchema.omit({
  checkoutUrl: true,
  actions: true,
}).extend({
  user: z.object({ id: z.uuid(), username: z.string(), displayName: z.string() }),
  provider: z.string().nullable(),
  providerSubscriptionId: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  actions: z.array(z.enum(['reconcile', 'cancel_now', 'refund_last'])),
});
export type AdminSubscription = z.infer<typeof AdminSubscriptionSchema>;

export const AdminSubscriptionPageSchema = z.object({
  data: z.array(AdminSubscriptionSchema),
  page: PageInfoSchema,
});

export const AdminSubscriptionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z
    .string()
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  status: SubscriptionStatusSchema.optional(),
  q: z.string().trim().max(100).optional(),
});
export type AdminSubscriptionsQuery = z.input<typeof AdminSubscriptionsQuerySchema>;

export const AdminEndSubscriptionSchema = z.object({
  /** Also refund the most recent payment in full. */
  refundLast: z.boolean().default(false),
  reason: z.string().trim().min(5).max(500),
});
export type AdminEndSubscriptionInput = z.input<typeof AdminEndSubscriptionSchema>;
