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

describe('pagination and ids', () => {
  it('applies the default page limit and caps it', async () => {
    const { CursorPageQuerySchema } = await import('./index.js');
    expect(CursorPageQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(CursorPageQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(CursorPageQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
    expect(CursorPageQuerySchema.safeParse({ cursor: 'abc$%' }).success).toBe(false);
  });

  it('accepts only valid UUIDs', async () => {
    const { UuidSchema } = await import('./index.js');
    expect(UuidSchema.safeParse('5eed0000-0000-4000-8000-000000000001').success).toBe(true);
    expect(UuidSchema.safeParse('not-a-uuid').success).toBe(false);
  });
});
