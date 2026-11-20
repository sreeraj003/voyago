import { BadRequestException } from '@nestjs/common';
import { DISCOVERY_MAX_OFFSET } from '@voyago/shared';
import { z } from 'zod';

/**
 * Pure helpers for discovery queries, kept apart from SQL so they can be unit tested.
 */

/**
 * Turns free text into a prefix-matching tsquery (`nandi:* & hills:*`). Only letters (with their combining marks, as in Kannada) and digits
 * survive, so the result is always valid tsquery syntax; returns null when nothing is left.
 */
export function toPrefixTsQuery(text: string): string | null {
  const tokens = text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  const unique = [...new Set(tokens)].slice(0, 8);
  return unique.length > 0 ? unique.map((token) => `${token}:*`).join(' & ') : null;
}

/** Escapes LIKE wildcards so user text matches literally (backslash is the default escape). */
export function escapeLike(text: string): string {
  return text.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Ranked results change as time passes (departure soonness, recent joins), so discovery pages by
 * position. The cursor is opaque base64url JSON; deep paging is capped.
 */
const OffsetCursorSchema = z.object({ o: z.number().int().min(1).max(DISCOVERY_MAX_OFFSET) });

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

export function decodeOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    return OffsetCursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
      .o;
  } catch {
    throw new BadRequestException({
      message: 'Validation failed',
      details: [{ path: 'query.cursor', message: 'Invalid cursor' }],
    });
  }
}

export function offsetPage<T>(rows: T[], offset: number, limit: number) {
  const hasMore = rows.length > limit && offset + limit < DISCOVERY_MAX_OFFSET;
  return {
    data: rows.slice(0, limit),
    page: { hasMore, nextCursor: hasMore ? encodeOffsetCursor(offset + limit) : null },
  };
}

/** Rounds to 2 decimals (about 1 km), the precision used for meeting points in public. */
export const roundTo = (value: number, decimals: number) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/** Straight-line distance in whole km; at least 1 so a meeting point can't be pinned down. */
export const wholeKm = (meters: number) => Math.max(1, Math.round(meters / 1000));

export interface ReasonInput {
  query?: string | undefined;
  textRank: number | null;
  distanceMeters: number | null;
  departureAt: Date;
  seatsLeft: number;
  preferenceMatch: boolean;
  recentJoins?: number;
  now: Date;
}

/** Plain-language reasons shown on each result, mirroring the ranking rules. */
export function matchReasons(input: ReasonInput): string[] {
  const reasons: string[] = [];
  if (input.recentJoins && input.recentJoins > 0) {
    reasons.push(`${input.recentJoins} joined this week`);
  }
  if (input.query && (input.textRank ?? 0) > 0) reasons.push(`Matches "${input.query}"`);
  if (input.distanceMeters !== null) {
    reasons.push(`About ${wholeKm(input.distanceMeters)} km away (straight line)`);
  }
  const days = Math.floor((input.departureAt.getTime() - input.now.getTime()) / 86_400_000);
  if (days <= 0) reasons.push('Leaves today');
  else if (days === 1) reasons.push('Leaves tomorrow');
  else if (days <= 7) reasons.push(`Leaves in ${days} days`);
  reasons.push(
    input.seatsLeft > 0
      ? `${input.seatsLeft} ${input.seatsLeft === 1 ? 'place' : 'places'} left`
      : 'Full',
  );
  if (input.preferenceMatch) reasons.push('Fits your trip preferences');
  return reasons;
}
