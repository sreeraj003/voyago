import {
  DestinationSummarySchema,
  type DiscoverySearchQuery,
  type GeoPoint,
  pageEnvelope,
  type PageResponse,
  type TripCard,
  TripCardSchema,
  type TripMode,
  type DestinationSummary,
} from '@voyago/shared';
import { z } from 'zod';
import { toQueryString } from '../discovery/filters';
import { apiRequest } from './http';

const CardPage = pageEnvelope(TripCardSchema);
const DestinationPage = pageEnvelope(DestinationSummarySchema);

async function getPage<T>(path: string, query: object, schema: z.ZodType<T>): Promise<T> {
  const page = await apiRequest(`${path}?${toQueryString(query)}`, {
    schema: z.unknown(),
    raw: true,
  });
  return schema.parse(page);
}

export const searchTrips = (
  query: DiscoverySearchQuery,
  cursor?: string,
): Promise<PageResponse<TripCard>> => getPage('/discovery/search', { ...query, cursor }, CardPage);

export const trendingTrips = (
  mode: TripMode,
  near: GeoPoint | null,
): Promise<PageResponse<TripCard>> =>
  getPage(
    '/discovery/trending',
    {
      mode,
      limit: 10,
      ...(near ? { lat: near.latitude, lng: near.longitude, radiusKm: 100 } : {}),
    },
    CardPage,
  );

export const popularDestinations = (mode: TripMode): Promise<PageResponse<DestinationSummary>> =>
  getPage('/discovery/destinations', { mode, limit: 12 }, DestinationPage);
