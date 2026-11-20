import { z } from 'zod';
import { PageInfoSchema } from './pagination.js';

/**
 * Success responses: a single resource is `{ data }`; a list is `{ data: [...], page }`.
 * Errors use ApiError. Health probes return their own small shapes for infrastructure tools.
 */
export const dataEnvelope = <T extends z.ZodType>(item: T) => z.object({ data: item });

export const pageEnvelope = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), page: PageInfoSchema });

export type DataResponse<T> = { data: T };
export type PageResponse<T> = { data: T[]; page: z.infer<typeof PageInfoSchema> };
