import { z } from 'zod';

/** WGS 84 coordinate pair. Stored in PostGIS as geography(Point, 4326). */
export const GeoPointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type GeoPoint = z.infer<typeof GeoPointSchema>;
