import { describe, expect, it } from 'vitest';
import {
  CreateOperatorSchema,
  CreatePackageSchema,
  formatPaise,
  GstinSchema,
  packageRuleIssues,
  PackagePriceSchema,
  UpdatePackageSchema,
} from './commercial.js';

const DAY = 86_400_000;
const now = Date.parse('2026-11-20T00:00:00Z');
const iso = (offset: number) => new Date(now + offset).toISOString();

describe('package prices', () => {
  it('takes whole paise between ₹1 and ₹10,00,000', () => {
    expect(PackagePriceSchema.safeParse(100).success).toBe(true);
    expect(PackagePriceSchema.safeParse(100_000_000).success).toBe(true);
    for (const bad of [0, 99, -500, 3499.5, 100_000_001, Number.NaN]) {
      expect(PackagePriceSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('formats paise as rupees', () => {
    expect(formatPaise(349_900)).toBe('₹3,499');
    expect(formatPaise(349_950)).toBe('₹3,499.50');
    expect(formatPaise(100_000_000)).toBe('₹10,00,000');
  });
});

describe('packageRuleIssues', () => {
  const base = {
    mode: 'TRAVEL' as const,
    activityType: 'TREK' as const,
    startsAt: iso(5 * DAY),
    endsAt: iso(6 * DAY),
  };

  it('accepts a sound package', () => {
    expect(packageRuleIssues(base, now)).toEqual([]);
  });

  it('keeps rides and travel apart', () => {
    expect(packageRuleIssues({ ...base, mode: 'RIDE' }, now).map((i) => i.path)).toEqual([
      'activityType',
    ]);
    expect(
      packageRuleIssues({ ...base, mode: 'RIDE', activityType: 'MOTORCYCLE_RIDE' }, now),
    ).toEqual([]);
  });

  it('checks the dates', () => {
    expect(packageRuleIssues({ ...base, endsAt: iso(4 * DAY) }, now)[0]?.path).toBe('endsAt');
    expect(packageRuleIssues({ ...base, endsAt: iso(70 * DAY) }, now)[0]?.message).toMatch(
      /60 days/,
    );
    expect(packageRuleIssues({ ...base, startsAt: iso(-DAY) }, now).map((i) => i.path)).toEqual([
      'startsAt',
    ]);
  });
});

describe('package input', () => {
  const input = {
    mode: 'TRAVEL',
    activityType: 'TREK',
    title: 'Kudremukh weekend trek',
    destination: { name: 'Kudremukh', point: { latitude: 13.13, longitude: 75.26 } },
    meetingPoint: { name: 'Mullodi', point: { latitude: 13.12, longitude: 75.27 } },
    startsAt: new Date(Date.now() + 5 * DAY).toISOString(),
    endsAt: new Date(Date.now() + 6 * DAY).toISOString(),
    pricePaise: 349_900,
    capacity: 12,
    inclusions: ['Guide'],
    cancellationPolicy: 'Full refund up to 7 days before the start.',
  };

  it('defaults currency, exclusions and photos', () => {
    expect(CreatePackageSchema.parse(input)).toMatchObject({
      currency: 'INR',
      exclusions: [],
      photoIds: [],
    });
  });

  it('needs inclusions, a real cancellation policy and a sane capacity', () => {
    for (const patch of [
      { inclusions: [] },
      { cancellationPolicy: 'No refunds' },
      { capacity: 0 },
      { capacity: 201 },
      { currency: 'USD' },
    ]) {
      expect(CreatePackageSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    }
  });

  it('needs at least one field to update', () => {
    expect(UpdatePackageSchema.safeParse({}).success).toBe(false);
    expect(UpdatePackageSchema.safeParse({ pricePaise: 200_000 }).success).toBe(true);
  });
});

describe('operator onboarding', () => {
  const operator = {
    displayName: 'Ghats Treks',
    legalName: 'Ghats Treks Private Limited',
    category: 'TREKKING',
    businessPhone: '+919876543210',
    address: { line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', postalCode: '560001' },
    acceptTerms: true,
  };

  it('needs the terms and a business contact', () => {
    expect(CreateOperatorSchema.safeParse(operator).success).toBe(true);
    expect(CreateOperatorSchema.safeParse({ ...operator, acceptTerms: false }).success).toBe(false);
    expect(CreateOperatorSchema.safeParse({ ...operator, businessPhone: undefined }).success).toBe(
      false,
    );
  });

  it('normalises and checks GSTINs', () => {
    expect(GstinSchema.parse(' 29abcde1234f1z5 ')).toBe('29ABCDE1234F1Z5');
    expect(GstinSchema.safeParse('29ABCDE1234F1Y5').success).toBe(false);
  });
});
