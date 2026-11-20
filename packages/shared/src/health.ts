import { z } from 'zod';

export const DependencyStatusSchema = z.enum(['up', 'down']);
export type DependencyStatus = z.infer<typeof DependencyStatusSchema>;

/** GET /health/live: the process is running. No dependency checks. */
export const LivenessResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.string(),
});
export type LivenessResponse = z.infer<typeof LivenessResponseSchema>;

/** GET /health/ready (and /health): dependencies the API needs to serve traffic. */
export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.string(),
  checks: z.object({
    database: DependencyStatusSchema,
    postgis: DependencyStatusSchema,
    redis: DependencyStatusSchema,
  }),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
