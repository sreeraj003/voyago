import { describe, expect, it } from 'vitest';
import {
  ALWAYS_FREE,
  BulkJoinRequestsSchema,
  CreateSavedSearchSchema,
  ENTITLEMENTS_BY_TIER,
  EntitlementSchema,
  SubscribeSchema,
  tierFor,
  tierHas,
  UpdatePlanSchema,
  UpdateProfileStyleSchema,
} from './subscriptions.js';

describe('tiers', () => {
  it('gives the free tier no paid features and Organiser Pro everything', () => {
    expect(ENTITLEMENTS_BY_TIER.FREE).toEqual([]);
    expect([...ENTITLEMENTS_BY_TIER.ORGANISER_PRO].sort()).toEqual(
      [...EntitlementSchema.options].sort(),
    );
    for (const e of ENTITLEMENTS_BY_TIER.EXPLORER_PRO)
      expect(tierHas('ORGANISER_PRO', e)).toBe(true);
  });

  it('names the cheapest plan that includes a feature', () => {
    expect(tierFor('saved_searches')).toBe('EXPLORER_PRO');
    expect(tierFor('profile_style')).toBe('EXPLORER_PRO');
    expect(tierFor('organiser_insights')).toBe('ORGANISER_PRO');
    expect(tierFor('bulk_join_requests')).toBe('ORGANISER_PRO');
  });

  it('keeps safety and communication on the always-free list', () => {
    const text = ALWAYS_FREE.join(' ');
    expect(text).toMatch(/SOS/);
    expect(text).toMatch(/Blocking and reporting/);
    expect(text).toMatch(/Messages/);
  });
});

describe('schemas', () => {
  it('needs a real idempotency key to subscribe', () => {
    expect(SubscribeSchema.safeParse({ planCode: 'X', idempotencyKey: 'short' }).success).toBe(
      false,
    );
    expect(
      SubscribeSchema.safeParse({ planCode: 'X', idempotencyKey: 'a'.repeat(20) }).success,
    ).toBe(true);
  });

  it('defaults saved-search alerts to off', () => {
    expect(CreateSavedSearchSchema.parse({ name: 'Rides', query: { mode: 'RIDE' } }).alerts).toBe(
      false,
    );
  });

  it('limits bulk decisions to 50 requests', () => {
    const ids = Array.from({ length: 51 }, () => '00000000-0000-4000-8000-000000000000');
    expect(BulkJoinRequestsSchema.safeParse({ action: 'approve', requestIds: ids }).success).toBe(
      false,
    );
  });

  it('only allows palette colours and a short headline', () => {
    expect(UpdateProfileStyleSchema.safeParse({ accentColor: '#ff0000' }).success).toBe(false);
    expect(UpdateProfileStyleSchema.safeParse({ accentColor: null }).success).toBe(true);
    expect(UpdateProfileStyleSchema.safeParse({ headline: 'x'.repeat(121) }).success).toBe(false);
    expect(UpdateProfileStyleSchema.safeParse({}).success).toBe(false);
  });

  it('needs a reason for every plan change', () => {
    expect(UpdatePlanSchema.safeParse({ pricePaise: 14_900 }).success).toBe(false);
    expect(UpdatePlanSchema.safeParse({ pricePaise: 50, reason: 'Too cheap' }).success).toBe(false);
    expect(UpdatePlanSchema.safeParse({ pricePaise: 14_900, reason: 'New price' }).success).toBe(
      true,
    );
  });
});
