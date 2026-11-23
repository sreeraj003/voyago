import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_EVENTS,
  ClientErrorSchema,
  MetricsQuerySchema,
  MODERATION_SLA_HOURS,
} from './analytics.js';
import { PERMISSIONS_BY_ROLE } from './admin.js';

describe('event dictionary', () => {
  it('covers the product events and describes each one', () => {
    expect(ANALYTICS_EVENT_NAMES).toEqual(
      expect.arrayContaining([
        'account_registered',
        'profile_completed',
        'trip_created',
        'trip_published',
        'trip_viewed',
        'join_requested',
        'join_approved',
        'trip_started',
        'trip_completed',
        'trip_cancelled',
        'community_joined',
        'booking_started',
        'booking_confirmed',
        'subscription_started',
        'user_active',
      ]),
    );
    for (const name of ANALYTICS_EVENT_NAMES) {
      expect(ANALYTICS_EVENTS[name].description.length).toBeGreaterThan(5);
    }
  });

  it('never allows free text, ids or coordinates as properties', () => {
    const banned = /id$|name|email|phone|lat|lng|latitude|longitude|text|message|title|reason/i;
    for (const name of ANALYTICS_EVENT_NAMES) {
      for (const key of Object.keys(ANALYTICS_EVENTS[name].properties.shape)) {
        expect(key, `${name}.${key}`).not.toMatch(banned);
      }
    }
  });

  it('strips properties that are not in the dictionary', () => {
    const parsed = ANALYTICS_EVENTS.trip_viewed.properties.parse({
      mode: 'TRAVEL',
      participant: false,
      tripId: 'abc',
      latitude: 12.9,
    });
    expect(parsed).toEqual({ mode: 'TRAVEL', participant: false });
  });

  it('rejects out-of-range amounts', () => {
    expect(
      ANALYTICS_EVENTS.booking_started.properties.safeParse({ seats: 1, amountPaise: -5 }).success,
    ).toBe(false);
  });
});

describe('metrics and status schemas', () => {
  it('keeps the period between a week and a year', () => {
    expect(MetricsQuerySchema.parse({})).toEqual({ days: 30 });
    expect(MetricsQuerySchema.parse({ days: '90' })).toEqual({ days: 90 });
    expect(MetricsQuerySchema.safeParse({ days: 6 }).success).toBe(false);
    expect(MetricsQuerySchema.safeParse({ days: 400 }).success).toBe(false);
  });

  it('bounds crash reports', () => {
    expect(
      ClientErrorSchema.parse({ platform: 'ios', appVersion: '1.2.0', message: ' Boom ' }),
    ).toEqual({ platform: 'ios', appVersion: '1.2.0', message: 'Boom', fatal: false });
    expect(
      ClientErrorSchema.safeParse({ platform: 'ios', appVersion: '1', message: 'x'.repeat(501) })
        .success,
    ).toBe(false);
    expect(
      ClientErrorSchema.safeParse({ platform: 'desktop', appVersion: '1', message: 'x' }).success,
    ).toBe(false);
  });

  it('orders the moderation targets by severity', () => {
    const { CRITICAL, HIGH, MEDIUM, LOW } = MODERATION_SLA_HOURS;
    expect(CRITICAL < HIGH && HIGH < MEDIUM && MEDIUM < LOW).toBe(true);
  });

  it('gives metrics to operations and system status to support too', () => {
    expect(PERMISSIONS_BY_ROLE.OPERATIONS).toEqual(
      expect.arrayContaining(['metrics.read', 'system.read']),
    );
    expect(PERMISSIONS_BY_ROLE.SUPPORT).toContain('system.read');
    expect(PERMISSIONS_BY_ROLE.SUPPORT).not.toContain('metrics.read');
    expect(PERMISSIONS_BY_ROLE.MODERATOR).not.toContain('metrics.read');
  });
});
