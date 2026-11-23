import { type Subscription } from '@voyago/shared';
import { ApiRequestError } from '../api/http';
import { routeFor } from '../notifications/route';
import { subscriptionNote, suggestName, toSavedQuery, upgradeTier } from '../subscriptions/plans';

const base: Subscription = {
  id: '00000000-0000-4000-8000-000000000001',
  status: 'ACTIVE',
  plan: { code: 'EXPLORER_PRO_MONTHLY', tier: 'EXPLORER_PRO', name: 'Explorer Pro' },
  pricePaise: 11_900,
  currency: 'INR',
  currentPeriodStart: '2026-11-01T00:00:00.000Z',
  currentPeriodEnd: '2026-12-01T00:00:00.000Z',
  cancelAtPeriodEnd: false,
  cancelledAt: null,
  renewsAt: '2026-12-01T00:00:00.000Z',
  entitled: true,
  payments: [],
  checkoutUrl: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  actions: ['cancel'],
};

describe('subscription notes', () => {
  it('says when it renews and for how much', () => {
    expect(subscriptionNote(base)).toMatch(/^Renews on .*2026 for ₹119\. Cancel any time/);
  });

  it('is clear that nothing was charged before the first payment', () => {
    expect(subscriptionNote({ ...base, status: 'PENDING', renewsAt: null })).toMatch(
      /Nothing has been charged/,
    );
  });

  it('keeps the plan to the end of the paid month after cancelling', () => {
    const note = subscriptionNote({
      ...base,
      status: 'CANCELLED',
      cancelAtPeriodEnd: true,
      renewsAt: null,
    });
    expect(note).toMatch(/You keep it until .* and won't be charged again/);
  });

  it('explains a failed renewal', () => {
    expect(subscriptionNote({ ...base, status: 'PAST_DUE' })).toMatch(/will try again/);
    expect(subscriptionNote({ ...base, status: 'PAST_DUE', entitled: false })).toMatch(
      /paid features are off/,
    );
  });
});

describe('upgrade prompts', () => {
  it('reads the plan a refused feature needs', () => {
    const refused = new ApiRequestError(403, 'This is part of Organiser Pro', {
      UPGRADE_REQUIRED: 'ORGANISER_PRO',
    });
    expect(upgradeTier(refused)).toBe('ORGANISER_PRO');
    expect(upgradeTier(new ApiRequestError(403, 'Only the organisers can decide'))).toBeNull();
    expect(upgradeTier(new Error('offline'))).toBeNull();
  });
});

describe('saved searches', () => {
  it('never saves the location, dates or paging', () => {
    expect(
      toSavedQuery({
        mode: 'RIDE',
        sort: 'proximity',
        q: 'Coorg',
        lat: 12.97,
        lng: 77.59,
        radiusKm: 50,
        departFrom: '2026-11-28T00:00:00.000Z',
        departTo: '2026-11-30T00:00:00.000Z',
        difficulty: 'EASY,MODERATE',
        limit: 20,
      }),
    ).toEqual({ mode: 'RIDE', q: 'Coorg', difficulty: 'EASY,MODERATE' });
  });

  it('suggests a name from the filters', () => {
    expect(suggestName({ mode: 'RIDE', q: 'Coorg' })).toBe('“Coorg” · Rides');
    expect(suggestName({})).toBe('My search');
  });

  it('opens the saved search or the plan from a notification', () => {
    const id = '00000000-0000-4000-8000-000000000002';
    expect(routeFor({ savedSearchId: id })).toBe(`/plans/saved-searches?id=${id}`);
    expect(routeFor({ savedSearchId: id, tripId: id })).toBe(`/trips/${id}`);
    expect(routeFor({ screen: 'subscription' })).toBe('/plans');
  });
});
