import { describe, expect, it } from 'vitest';
import { ApiErrorSchema, HealthResponseSchema, TripModeSchema } from './index.js';

describe('shared schemas', () => {
  it('accepts the two trip modes only', () => {
    expect(TripModeSchema.parse('RIDE')).toBe('RIDE');
    expect(TripModeSchema.safeParse('TAXI').success).toBe(false);
  });

  it('validates a health response', () => {
    const parsed = HealthResponseSchema.safeParse({
      status: 'ok',
      version: '0.1.0',
      uptimeSeconds: 3,
      timestamp: new Date().toISOString(),
      checks: { database: 'up', postgis: 'up', redis: 'up' },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an error payload without a status code', () => {
    expect(ApiErrorSchema.safeParse({ error: 'Bad Request', message: 'x' }).success).toBe(false);
  });
});
