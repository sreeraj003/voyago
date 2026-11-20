import { BadRequestException } from '@nestjs/common';
import { decodeCursor, encodeCursor, toPage } from './cursor.js';

const row = (n: number) => ({
  id: `5eed0000-0000-4000-8000-${n.toString().padStart(12, '0')}`,
  createdAt: new Date(Date.UTC(2026, 10, 20, 0, 0, 60 - n)),
});

describe('cursor pagination', () => {
  it('round-trips a cursor', () => {
    const cursor = encodeCursor(row(1));
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual(row(1));
  });

  it('rejects a tampered cursor with a 400', () => {
    expect(() => decodeCursor('bm90LWpzb24')).toThrow(BadRequestException);
    expect(decodeCursor(undefined)).toBeUndefined();
  });

  it('returns a next cursor only when more rows exist', () => {
    const rows = [row(1), row(2), row(3)];
    const page = toPage(rows, 2);
    expect(page.data).toHaveLength(2);
    expect(page.page.hasMore).toBe(true);
    expect(decodeCursor(page.page.nextCursor ?? undefined)?.id).toBe(row(2).id);

    expect(toPage(rows, 5).page).toEqual({ hasMore: false, nextCursor: null });
  });
});
