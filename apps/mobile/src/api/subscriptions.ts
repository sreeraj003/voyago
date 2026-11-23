import {
  type BulkJoinRequestsInput,
  BulkJoinResultSchema,
  type CreateSavedSearchInput,
  type MySubscription,
  MySubscriptionSchema,
  type OrganiserInsights,
  OrganiserInsightsSchema,
  pageEnvelope,
  type PageResponse,
  type PlansResponse,
  PlansResponseSchema,
  type ProfileStyle,
  ProfileStyleSchema,
  type SavedSearch,
  SavedSearchSchema,
  type TravelStats,
  TravelStatsSchema,
  type TripCard,
  TripCardSchema,
} from '@voyago/shared';
import { z } from 'zod';
import { apiRequest } from './http';

const CardPage = pageEnvelope(TripCardSchema);

export const getPlans = (): Promise<PlansResponse> =>
  apiRequest('/subscriptions/plans', { schema: PlansResponseSchema });

export const getMySubscription = (returnUrl?: string): Promise<MySubscription> =>
  apiRequest(`/me/subscription${returnUrl ? `?returnUrl=${encodeURIComponent(returnUrl)}` : ''}`, {
    schema: MySubscriptionSchema,
  });

/** Starts a subscription waiting for its first payment. Send a fresh key per attempt. */
export const subscribe = (input: {
  planCode: string;
  idempotencyKey: string;
  returnUrl?: string;
}): Promise<MySubscription> =>
  apiRequest('/me/subscription', { method: 'POST', body: input, schema: MySubscriptionSchema });

export const cancelSubscription = (reason?: string): Promise<MySubscription> =>
  apiRequest('/me/subscription/cancel', {
    method: 'POST',
    body: reason?.trim() ? { reason: reason.trim() } : {},
    schema: MySubscriptionSchema,
  });

export const listSavedSearches = (): Promise<SavedSearch[]> =>
  apiRequest('/me/saved-searches', { schema: z.array(SavedSearchSchema) });

export const createSavedSearch = (input: CreateSavedSearchInput): Promise<SavedSearch> =>
  apiRequest('/me/saved-searches', { method: 'POST', body: input, schema: SavedSearchSchema });

export const updateSavedSearch = (
  id: string,
  input: { name?: string; alerts?: boolean },
): Promise<SavedSearch> =>
  apiRequest(`/me/saved-searches/${id}`, {
    method: 'PATCH',
    body: input,
    schema: SavedSearchSchema,
  });

export const deleteSavedSearch = (id: string): Promise<void> =>
  apiRequest(`/me/saved-searches/${id}`, { method: 'DELETE' });

export const runSavedSearch = async (
  id: string,
  cursor?: string,
): Promise<PageResponse<TripCard>> =>
  CardPage.parse(
    await apiRequest(
      `/me/saved-searches/${id}/trips?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      { schema: z.unknown(), raw: true },
    ),
  );

export const getTravelStats = (): Promise<TravelStats> =>
  apiRequest('/me/stats', { schema: TravelStatsSchema });

export const getOrganiserInsights = (): Promise<OrganiserInsights> =>
  apiRequest('/me/organiser/insights', { schema: OrganiserInsightsSchema });

export const bulkJoinRequests = (tripId: string, input: BulkJoinRequestsInput) =>
  apiRequest(`/trips/${tripId}/join-requests/bulk`, {
    method: 'POST',
    body: input,
    schema: BulkJoinResultSchema,
  });

export const getProfileStyle = (): Promise<ProfileStyle> =>
  apiRequest('/me/profile/style', { schema: ProfileStyleSchema });

export const updateProfileStyle = (input: {
  accentColor?: ProfileStyle['accentColor'];
  headline?: string | null;
}): Promise<ProfileStyle> =>
  apiRequest('/me/profile/style', { method: 'PATCH', body: input, schema: ProfileStyleSchema });
