import { describe, expect, it } from 'vitest';
import { slugify } from './operators.service.js';
import { durationDays } from './packages.service.js';

describe('slugify', () => {
  it('makes readable, safe slugs', () => {
    expect(slugify('Western Ghats Treks')).toBe('western-ghats-treks');
    expect(slugify('  Café   Trails & Co. ')).toBe('cafe-trails-co');
    expect(slugify('A')).toBe('operator-a');
    expect(slugify('x'.repeat(80))).toHaveLength(60);
  });
});

describe('durationDays', () => {
  it('counts calendar days in India, both ends included', () => {
    // 06:00 to 22:00 IST on the same day.
    expect(durationDays(new Date('2026-12-05T00:30:00Z'), new Date('2026-12-05T16:30:00Z'))).toBe(
      1,
    );
    // Saturday 06:00 IST to Sunday 18:00 IST.
    expect(durationDays(new Date('2026-12-05T00:30:00Z'), new Date('2026-12-06T12:30:00Z'))).toBe(
      2,
    );
    // 23:00 IST to 01:00 IST the next day spans two dates.
    expect(durationDays(new Date('2026-12-05T17:30:00Z'), new Date('2026-12-05T19:30:00Z'))).toBe(
      2,
    );
  });
});
