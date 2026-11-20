import { z } from 'zod';

/**
 * The two product modes. Rides and travel trips share one Trip model;
 * the mode decides which fields and filters apply.
 */
export const TripModeSchema = z.enum(['RIDE', 'TRAVEL']);
export type TripMode = z.infer<typeof TripModeSchema>;
