import { z } from 'zod';

export const DependencyStatusSchema = z.enum(['up', 'down']);
export type DependencyStatus = z.infer<typeof DependencyStatusSchema>;

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
