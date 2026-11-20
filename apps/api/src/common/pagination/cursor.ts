import { BadRequestException } from '@nestjs/common';
import { type PageInfo } from '@voyago/shared';
import { z } from 'zod';

/**
 * Keyset (cursor) pagination over (created_at DESC, id DESC).
 * The cursor is base64url JSON of the last row's sort key; clients treat it as opaque.
 */
const CursorPayloadSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });
export type CursorPayload = { createdAt: Date; id: string };

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }),
    'utf8',
  ).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): CursorPayload | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parsed = CursorPayloadSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    return { createdAt: new Date(parsed.createdAt), id: parsed.id };
  } catch {
    throw new BadRequestException({
      message: 'Validation failed',
      details: [{ path: 'query.cursor', message: 'Invalid cursor' }],
    });
  }
}

/**
 * Builds a page from rows fetched with `take: limit + 1`. The extra row only signals that
 * more results exist; it is not returned.
 */
export function toPage<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number,
): { data: T[]; page: PageInfo } {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.at(-1);
  return { data, page: { hasMore, nextCursor: hasMore && last ? encodeCursor(last) : null } };
}
