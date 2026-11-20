import {
  type CreateTripInput,
  pageEnvelope,
  type PageResponse,
  type Trip,
  TripSchema,
  type UpdateTripInput,
} from '@voyago/shared';
import { z } from 'zod';
import { apiRequest } from './http';

export const getTrip = (id: string): Promise<Trip> =>
  apiRequest(`/trips/${id}`, { schema: TripSchema });

export const createTrip = (input: CreateTripInput): Promise<Trip> =>
  apiRequest('/trips', { method: 'POST', body: input, schema: TripSchema });

export const updateTrip = (id: string, input: UpdateTripInput): Promise<Trip> =>
  apiRequest(`/trips/${id}`, { method: 'PATCH', body: input, schema: TripSchema });

export const tripAction = (id: string, action: 'publish' | 'start' | 'complete'): Promise<Trip> =>
  apiRequest(`/trips/${id}/${action}`, { method: 'POST', schema: TripSchema });

export const cancelTrip = (id: string, reason: string): Promise<Trip> =>
  apiRequest(`/trips/${id}/cancel`, { method: 'POST', body: { reason }, schema: TripSchema });

export const deleteTrip = (id: string): Promise<void> =>
  apiRequest(`/trips/${id}`, { method: 'DELETE' });

const MyTripsPage = pageEnvelope(TripSchema);

/** Lists use the full page envelope, so they bypass the `{ data }` unwrapping helper. */
export async function listMyTrips(cursor?: string): Promise<PageResponse<Trip>> {
  const query = new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) });
  const page = await apiRequest(`/me/trips?${query.toString()}`, {
    schema: z.unknown(),
    raw: true,
  });
  return MyTripsPage.parse(page);
}
