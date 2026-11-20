import { describe, expect, it } from 'vitest';
import {
  canTransition,
  CreateTripSchema,
  departureIssue,
  TRIP_TRANSITIONS,
  tripRuleIssues,
} from './index.js';

describe('trip lifecycle', () => {
  it('allows only the documented transitions', () => {
    expect(canTransition('DRAFT', 'PUBLISHED')).toBe(true);
    expect(canTransition('PUBLISHED', 'FULL')).toBe(true);
    expect(canTransition('FULL', 'IN_PROGRESS')).toBe(true);
    expect(canTransition('IN_PROGRESS', 'COMPLETED')).toBe(true);
    expect(canTransition('DRAFT', 'IN_PROGRESS')).toBe(false);
    expect(canTransition('DRAFT', 'COMPLETED')).toBe(false);
    expect(canTransition('COMPLETED', 'CANCELLED')).toBe(false);
    for (const terminal of ['COMPLETED', 'CANCELLED', 'EXPIRED'] as const) {
      expect(TRIP_TRANSITIONS[terminal]).toEqual([]);
    }
  });
});

describe('trip rules', () => {
  const base = {
    mode: 'RIDE' as const,
    activityType: 'MOTORCYCLE_RIDE',
    departureAt: '2030-01-01T00:00:00Z',
    maxParticipants: 6,
  };

  it('checks mode/activity, capacity, return date and stop times', () => {
    expect(tripRuleIssues(base)).toEqual([]);
    const paths = tripRuleIssues({
      ...base,
      activityType: 'TREK',
      minParticipants: 7,
      returnAt: '2029-12-31T00:00:00Z',
      stops: [{ plannedArrivalAt: '2029-12-31T00:00:00Z' }],
    }).map((issue) => issue.path);
    expect(paths).toEqual([
      'activityType',
      'minParticipants',
      'returnAt',
      'stops.0.plannedArrivalAt',
    ]);
    expect(
      tripRuleIssues({ ...base, mode: 'TRAVEL', activityType: 'TREK', minEngineCc: 200 })[0]?.path,
    ).toBe('minEngineCc');
  });

  it('requires a future departure within 2 years', () => {
    const now = Date.parse('2026-11-20T00:00:00Z');
    expect(departureIssue('2026-11-19T00:00:00Z', now)?.path).toBe('departureAt');
    expect(departureIssue('2026-11-21T00:00:00Z', now)).toBeNull();
    expect(departureIssue('2029-01-01T00:00:00Z', now)?.message).toContain('2 years');
  });

  it('accepts only PUBLIC or PRIVATE visibility and INR budgets', () => {
    const trip = {
      ...base,
      title: 'Ride',
      origin: { name: 'Hebbal', point: { latitude: 13, longitude: 77 } },
      destination: { name: 'Nandi', point: { latitude: 13.3, longitude: 77.6 } },
    };
    expect(CreateTripSchema.safeParse(trip).success).toBe(true);
    expect(CreateTripSchema.safeParse({ ...trip, visibility: 'FOLLOWERS' }).success).toBe(false);
    expect(CreateTripSchema.safeParse({ ...trip, currency: 'USD' }).success).toBe(false);
  });
});
