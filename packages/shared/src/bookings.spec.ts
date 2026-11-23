import { describe, expect, it } from 'vitest';
import {
  basisPoints,
  CreateBookingSchema,
  describeRefundTiers,
  proportional,
  refundPercentFor,
  RefundTiersSchema,
  splitBooking,
} from './bookings.js';

const TIERS = RefundTiersSchema.parse([
  { hoursBefore: 48, refundPercent: 50 },
  { hoursBefore: 168, refundPercent: 100 },
]);

describe('refund tiers', () => {
  it('sorts tiers from the earliest cut-off', () => {
    expect(TIERS.map((t) => t.hoursBefore)).toEqual([168, 48]);
  });

  it('refuses repeated hours, rising refunds, and out-of-range values', () => {
    for (const bad of [
      [
        { hoursBefore: 48, refundPercent: 50 },
        { hoursBefore: 48, refundPercent: 20 },
      ],
      [
        { hoursBefore: 168, refundPercent: 20 },
        { hoursBefore: 48, refundPercent: 50 },
      ],
      [{ hoursBefore: 48, refundPercent: 101 }],
      [{ hoursBefore: -1, refundPercent: 50 }],
      [{ hoursBefore: 2.5, refundPercent: 50 }],
      Array.from({ length: 7 }, (_, i) => ({ hoursBefore: (7 - i) * 24, refundPercent: 50 })),
    ]) {
      expect(RefundTiersSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('picks the tier still met at the time of cancelling', () => {
    expect(refundPercentFor(TIERS, 400)).toBe(100);
    expect(refundPercentFor(TIERS, 168)).toBe(100);
    expect(refundPercentFor(TIERS, 167.9)).toBe(50);
    expect(refundPercentFor(TIERS, 48)).toBe(50);
    expect(refundPercentFor(TIERS, 47)).toBe(0);
    expect(refundPercentFor(TIERS, 0)).toBe(0);
    expect(refundPercentFor(TIERS, -5)).toBe(0);
    expect(refundPercentFor([], 1000)).toBe(0);
  });

  it('describes the schedule in plain words', () => {
    expect(describeRefundTiers(TIERS)).toBe(
      'Full refund up to 7 days before the start; 50% back up to 2 days before the start; no refund after that',
    );
    expect(describeRefundTiers([{ hoursBefore: 0, refundPercent: 100 }])).toBe(
      'Full refund until the start',
    );
    expect(describeRefundTiers([])).toBe('No refunds');
  });
});

describe('money', () => {
  it('works in whole paise and rounds half up', () => {
    expect(basisPoints(500_000, 1000)).toBe(50_000);
    expect(basisPoints(5, 1000)).toBe(1); // 0.5 rounds up
    expect(basisPoints(4, 1000)).toBe(0);
    expect(() => basisPoints(10.5, 1000)).toThrow();
  });

  it('splits a booking so the parts always add up', () => {
    expect(splitBooking(750_000, 1000, 1800)).toEqual({
      totalPaise: 750_000,
      commissionPaise: 75_000,
      commissionTaxPaise: 13_500,
      operatorPayablePaise: 661_500,
    });
    for (const total of [1, 99, 349_900, 1_234_567, 99_999_999]) {
      const s = splitBooking(total, 1000, 1800);
      expect(s.commissionPaise + s.commissionTaxPaise + s.operatorPayablePaise).toBe(total);
      expect(Object.values(s).every(Number.isInteger)).toBe(true);
    }
  });

  it('reverses in steps that add up to the original once fully refunded', () => {
    const total = 1_049_700;
    const commission = 104_970;
    let reversed = 0;
    let refunded = 0;
    for (const step of [333_333, 300_000, 416_367]) {
      const before = proportional(commission, refunded, total);
      refunded += step;
      reversed += proportional(commission, refunded, total) - before;
    }
    expect(refunded).toBe(total);
    expect(reversed).toBe(commission);
    expect(proportional(10, 5, 0)).toBe(0);
  });
});

describe('booking requests', () => {
  it('needs whole seats within the limit and a strong idempotency key', () => {
    const key = 'a'.repeat(16);
    expect(CreateBookingSchema.safeParse({ seats: 1, idempotencyKey: key }).success).toBe(true);
    expect(CreateBookingSchema.safeParse({ seats: 0, idempotencyKey: key }).success).toBe(false);
    expect(CreateBookingSchema.safeParse({ seats: 11, idempotencyKey: key }).success).toBe(false);
    expect(CreateBookingSchema.safeParse({ seats: 1, idempotencyKey: 'short' }).success).toBe(
      false,
    );
    expect(CreateBookingSchema.safeParse({ seats: 1, idempotencyKey: `${key}!` }).success).toBe(
      false,
    );
  });
});
