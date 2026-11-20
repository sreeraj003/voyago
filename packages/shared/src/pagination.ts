import { z } from 'zod';

export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_PAGE_LIMIT = 20;

/**
 * Query parameters for cursor-paginated lists.
 * `cursor` is opaque: clients pass back `page.nextCursor` from the previous response.
 */
export const CursorPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  cursor: z
    .string()
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/, 'Invalid cursor')
    .optional(),
});
export type CursorPageQuery = z.infer<typeof CursorPageQuerySchema>;

export const PageInfoSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type PageInfo = z.infer<typeof PageInfoSchema>;
