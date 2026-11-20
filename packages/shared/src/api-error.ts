import { z } from 'zod';

/** The single error shape returned by every API endpoint. */
export const ApiErrorSchema = z.object({
  statusCode: z.number().int(),
  error: z.string(),
  message: z.string(),
  requestId: z.string().optional(),
  details: z
    .array(
      z.object({
        path: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
  timestamp: z.string(),
  path: z.string(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
