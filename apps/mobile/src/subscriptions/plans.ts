import {
  type ACCENT_COLORS,
  type DiscoverySearchQuery,
  type Entitlement,
  formatPaise,
  type PaidTier,
  PaidTierSchema,
  type Subscription,
  type SubscriptionStatus,
  UPGRADE_REQUIRED,
} from '@voyago/shared';
import { ApiRequestError } from '../api/http';

export const STATUS_LABELS: Record<SubscriptionStatus, string> = {
  PENDING: 'Waiting for payment',
  TRIALING: 'Trial',
  ACTIVE: 'Active',
  PAST_DUE: 'Renewal payment failed',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Ended',
};

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** One plain sentence on where the subscription stands. */
export function subscriptionNote(sub: Subscription): string {
  const price = formatPaise(sub.pricePaise);
  switch (sub.status) {
    case 'PENDING':
      return `Pay the first month (${price}) to switch it on. Nothing has been charged yet.`;
    case 'TRIALING':
    case 'ACTIVE':
      return sub.renewsAt
        ? `Renews on ${day(sub.renewsAt)} for ${price}. Cancel any time before then.`
        : `Runs until ${sub.currentPeriodEnd ? day(sub.currentPeriodEnd) : 'the end of the month'}.`;
    case 'PAST_DUE':
      return sub.entitled
        ? 'The renewal payment did not go through. The payment provider will try again; your plan keeps working for now.'
        : 'The renewal payment did not go through, so paid features are off.';
    case 'CANCELLED':
      return sub.entitled && sub.currentPeriodEnd
        ? `Cancelled. You keep it until ${day(sub.currentPeriodEnd)} and won't be charged again.`
        : 'Cancelled. You will not be charged again.';
    case 'EXPIRED':
      return 'Ended. You are on the free plan.';
  }
}

/** The plan that a refused paid feature needs, if that's why it was refused. */
export function upgradeTier(error: unknown): PaidTier | null {
  if (!(error instanceof ApiRequestError) || error.status !== 403) return null;
  return PaidTierSchema.safeParse(error.fieldErrors[UPGRADE_REQUIRED]).data ?? null;
}

/**
 * The parts of a discovery search worth saving. Location and dates are left out: a saved search
 * never stores where you were, and "this weekend" would otherwise freeze into one date.
 */
export function toSavedQuery(query: DiscoverySearchQuery): Record<string, string> {
  const skip = new Set(['lat', 'lng', 'radiusKm', 'departFrom', 'departTo', 'limit', 'cursor']);
  const saved: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (skip.has(key) || value === undefined || value === null || value === '') continue;
    if (key === 'sort' && value === 'proximity') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      saved[key] = String(value);
    } else if (Array.isArray(value)) {
      saved[key] = value.map(String).join(',');
    }
  }
  return saved;
}

/** A short name for a saved search from its filters. */
export function suggestName(query: Record<string, string>): string {
  const parts = [
    query.q ? `“${query.q}”` : null,
    query.mode === 'RIDE' ? 'Rides' : query.mode === 'TRAVEL' ? 'Trips' : null,
    query.difficulty ? query.difficulty.toLowerCase().replace(/,/g, ', ') : null,
  ].filter(Boolean);
  return (parts.join(' · ') || 'My search').slice(0, 60);
}

export const ACCENT_HEX: Record<(typeof ACCENT_COLORS)[number], string> = {
  teal: '#0f766e',
  indigo: '#4338ca',
  amber: '#b45309',
  rose: '#be123c',
  forest: '#166534',
  slate: '#334155',
  sunset: '#c2410c',
  ocean: '#0369a1',
};

export const ENTITLEMENT_LABELS: Record<Entitlement, string> = {
  saved_searches: 'Save searches and run them again',
  trip_alerts: 'Alerts when a new trip matches a saved search',
  travel_stats: 'Detailed travel statistics',
  profile_style: 'An accent colour on your profile',
  organiser_profile: 'An organiser headline on your profile',
  organiser_insights: 'Insights on how your trips do',
  bulk_join_requests: 'Approve or decline many join requests at once',
};
