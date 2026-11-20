import { describe, expect, it } from 'vitest';
import {
  canTransition,
  CreateTripSchema,
  isTripLive,
  LocationUpdateSchema,
  RaiseSosSchema,
  StartSharingSchema,
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

describe('live window and safety inputs', () => {
  const HOUR = 3_600_000;
  const now = Date.parse('2026-11-20T10:00:00Z');
  const at = (offset: number) => new Date(now + offset);

  it('is live from two hours before departure until the trip ends or would expire', () => {
    expect(isTripLive({ status: 'PUBLISHED', departureAt: at(3 * HOUR) }, now)).toBe(false);
    expect(isTripLive({ status: 'PUBLISHED', departureAt: at(2 * HOUR) }, now)).toBe(true);
    expect(isTripLive({ status: 'FULL', departureAt: at(-23 * HOUR) }, now)).toBe(true);
    expect(isTripLive({ status: 'PUBLISHED', departureAt: at(-25 * HOUR) }, now)).toBe(false);
    expect(isTripLive({ status: 'IN_PROGRESS', departureAt: at(-48 * HOUR) }, now)).toBe(true);
    for (const status of ['DRAFT', 'COMPLETED', 'CANCELLED', 'EXPIRED']) {
      expect(isTripLive({ status, departureAt: at(0) }, now)).toBe(false);
    }
  });

  it('requires consent, a bounded duration, valid coordinates and SOS confirmation', () => {
    expect(StartSharingSchema.safeParse({ durationMinutes: 60, consent: true }).success).toBe(true);
    expect(StartSharingSchema.safeParse({ durationMinutes: 60 }).success).toBe(false);
    expect(StartSharingSchema.safeParse({ durationMinutes: 1441, consent: true }).success).toBe(
      false,
    );
    const reading = { latitude: 13, longitude: 77, recordedAt: at(0).toISOString() };
    expect(LocationUpdateSchema.safeParse(reading).success).toBe(true);
    expect(LocationUpdateSchema.safeParse({ ...reading, latitude: 95 }).success).toBe(false);
    expect(LocationUpdateSchema.safeParse({ ...reading, longitude: -181 }).success).toBe(false);
    expect(RaiseSosSchema.safeParse({ confirm: true }).success).toBe(true);
    expect(RaiseSosSchema.safeParse({ confirm: false }).success).toBe(false);
  });
});
