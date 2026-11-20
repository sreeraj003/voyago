import { type SosAlert, type TripSafety } from '@voyago/shared';
import { routeFor } from '../notifications/route';
import {
  durationLabel,
  freshness,
  mapsLink,
  timeLeft,
  withAlert,
  withLocation,
  withoutSharer,
} from '../safety/live';

const tripId = '00000000-0000-4000-8000-000000000001';
const asha = { id: '00000000-0000-4000-8000-0000000000a1', username: 'asha', displayName: 'Asha' };
const ravi = { id: '00000000-0000-4000-8000-0000000000a2', username: 'ravi', displayName: 'Ravi' };
const base: TripSafety = {
  tripId,
  live: true,
  mySession: null,
  sharers: [],
  checkIns: [],
  alerts: [],
  emergencyNumber: '112',
  smsAvailable: true,
};
const reading = (recordedAt: string, latitude = 13.1) => ({
  tripId,
  user: asha,
  expiresAt: '2026-11-20T12:00:00.000Z',
  latitude,
  longitude: 77.6,
  accuracyMeters: 10,
  heading: null,
  speedMps: null,
  recordedAt,
});

describe('live location state', () => {
  it('adds and moves sharers, ignoring older readings and other trips', () => {
    const one = withLocation(base, reading('2026-11-20T10:00:00.000Z'));
    expect(one?.sharers).toHaveLength(1);
    const moved = withLocation(one, reading('2026-11-20T10:00:10.000Z', 13.2));
    expect(moved?.sharers[0]?.location?.latitude).toBe(13.2);
    expect(withLocation(moved, reading('2026-11-20T10:00:05.000Z', 13.0))).toBe(moved);
    expect(withLocation(moved, { ...reading('2026-11-20T10:01:00.000Z'), tripId: 'other' })).toBe(
      moved,
    );
    expect(withoutSharer(moved, tripId, asha.id)?.sharers).toHaveLength(0);
    expect(withLocation(undefined, reading('2026-11-20T10:00:00.000Z'))).toBeUndefined();
  });

  it('adds alerts and replaces them when they are resolved', () => {
    const alert: SosAlert = {
      id: '00000000-0000-4000-8000-0000000000f1',
      tripId,
      user: ravi,
      status: 'ACTIVE',
      message: null,
      location: { latitude: 13, longitude: 77, recordedAt: '2026-11-20T10:00:00.000Z' },
      createdAt: '2026-11-20T10:00:00.000Z',
      resolvedAt: null,
      resolvedBy: null,
    };
    const raised = withAlert(base, alert);
    expect(raised?.alerts).toEqual([alert]);
    const resolved = withAlert(raised, { ...alert, status: 'RESOLVED', location: null });
    expect(resolved?.alerts).toHaveLength(1);
    expect(resolved?.alerts[0]?.status).toBe('RESOLVED');
  });

  it('labels freshness, time left and durations', () => {
    const now = Date.parse('2026-11-20T10:05:00.000Z');
    expect(freshness('2026-11-20T10:04:30.000Z', now)).toEqual({
      label: 'Updated 30 s ago',
      stale: false,
    });
    expect(freshness('2026-11-20T10:00:00.000Z', now)).toEqual({
      label: 'Updated 5 min ago',
      stale: true,
    });
    expect(timeLeft('2026-11-20T10:50:00.000Z', now)).toBe('45 min left');
    expect(timeLeft('2026-11-20T13:15:00.000Z', now)).toBe('3 h 10 min left');
    expect(timeLeft('2026-11-20T09:00:00.000Z', now)).toBe('0 min left');
    expect(durationLabel(240)).toBe('4 h');
    expect(mapsLink({ latitude: 13.123456, longitude: 77.6 })).toBe(
      'https://maps.google.com/?q=13.12346,77.60000',
    );
  });

  it('opens the safety page from an SOS notification', () => {
    expect(routeFor({ tripId, screen: 'safety' })).toBe(`/trips/${tripId}/safety`);
    expect(routeFor({ tripId })).toBe(`/trips/${tripId}`);
  });
});
