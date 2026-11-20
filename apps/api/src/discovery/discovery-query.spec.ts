import { BadRequestException } from '@nestjs/common';
import { tripRuleIssues } from '@voyago/shared';
import {
  decodeOffsetCursor,
  encodeOffsetCursor,
  escapeLike,
  matchReasons,
  offsetPage,
  toPrefixTsQuery,
  wholeKm,
} from './discovery-query.js';

describe('discovery query helpers', () => {
  it('builds prefix tsqueries from letters and digits only', () => {
    expect(toPrefixTsQuery('Nandi hills')).toBe('nandi:* & hills:*');
    expect(toPrefixTsQuery("coorg'):* | !x")).toBe('coorg:* & x:*');
    expect(toPrefixTsQuery('ಮೈಸೂರು 2026')).toBe('ಮೈಸೂರು:* & 2026:*');
    expect(toPrefixTsQuery('&&& !!')).toBeNull();
    expect(toPrefixTsQuery('a a a')).toBe('a:*');
  });

  it('escapes LIKE wildcards', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });

  it('round-trips offset cursors and rejects bad ones', () => {
    expect(decodeOffsetCursor(undefined)).toBe(0);
    expect(decodeOffsetCursor(encodeOffsetCursor(40))).toBe(40);
    expect(() => decodeOffsetCursor('bm9wZQ')).toThrow(BadRequestException);
    expect(() => decodeOffsetCursor(encodeOffsetCursor(100_000))).toThrow(BadRequestException);
  });

  it('pages with a lookahead row', () => {
    expect(offsetPage([1, 2, 3], 0, 2)).toEqual({
      data: [1, 2],
      page: { hasMore: true, nextCursor: encodeOffsetCursor(2) },
    });
    expect(offsetPage([1, 2], 0, 2).page).toEqual({ hasMore: false, nextCursor: null });
  });

  it('never reports less than 1 km', () => {
    expect(wholeKm(120)).toBe(1);
    expect(wholeKm(12_600)).toBe(13);
  });

  it('explains the ranking in plain words', () => {
    const now = new Date('2026-11-20T00:00:00Z');
    expect(
      matchReasons({
        query: 'nandi',
        textRank: 0.4,
        distanceMeters: 4_200,
        departureAt: new Date('2026-11-23T01:00:00Z'),
        seatsLeft: 1,
        preferenceMatch: true,
        now,
      }),
    ).toEqual([
      'Matches "nandi"',
      'About 4 km away (straight line)',
      'Leaves in 3 days',
      '1 place left',
      'Fits your trip preferences',
    ]);
  });

  it('allows bike types on rides only', () => {
    const base = { departureAt: new Date(Date.now() + 86_400_000), maxParticipants: 4 };
    expect(
      tripRuleIssues({ ...base, mode: 'TRAVEL', activityType: 'TREK', bikeCategories: ['SPORT'] }),
    ).toContainEqual({ path: 'bikeCategories', message: 'Bike types apply to rides only' });
    expect(
      tripRuleIssues({
        ...base,
        mode: 'RIDE',
        activityType: 'MOTORCYCLE_RIDE',
        bikeCategories: ['SPORT'],
      }),
    ).toEqual([]);
  });
});
