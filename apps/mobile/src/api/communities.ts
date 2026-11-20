import {
  type Community,
  type CommunityMember,
  CommunityMemberSchema,
  CommunitySchema,
  type CreateCommunityInput,
  pageEnvelope,
  type PageResponse,
  type Post,
  PostSchema,
  type TripSummary,
  TripSummarySchema,
  type UpdateCommunityInput,
} from '@voyago/shared';
import { z } from 'zod';
import { apiRequest } from './http';

const CommunityPage = pageEnvelope(CommunitySchema);
const MemberPage = pageEnvelope(CommunityMemberSchema);
const TripPage = pageEnvelope(TripSummarySchema);
const PostPage = pageEnvelope(PostSchema);

const page = async <T>(path: string, schema: z.ZodType<T>): Promise<T> =>
  schema.parse(await apiRequest(path, { schema: z.unknown(), raw: true }));
const qs = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  return search.toString();
};

export type CommunityFilters = { q?: string; mode?: 'RIDE' | 'TRAVEL'; mine?: boolean };

export const listCommunities = (
  filters: CommunityFilters,
  cursor?: string,
): Promise<PageResponse<Community>> =>
  page(
    `/communities?${qs({
      limit: '20',
      q: filters.q?.trim() || undefined,
      mode: filters.mode,
      mine: filters.mine ? 'true' : undefined,
      cursor,
    })}`,
    CommunityPage,
  );

export const getCommunity = (slug: string): Promise<Community> =>
  apiRequest(`/communities/${slug}`, { schema: CommunitySchema });

export const createCommunity = (input: CreateCommunityInput): Promise<Community> =>
  apiRequest('/communities', { method: 'POST', body: input, schema: CommunitySchema });

export const updateCommunity = (slug: string, input: UpdateCommunityInput): Promise<Community> =>
  apiRequest(`/communities/${slug}`, { method: 'PATCH', body: input, schema: CommunitySchema });

export const joinCommunity = (slug: string, message: string): Promise<Community> =>
  apiRequest(`/communities/${slug}/join`, {
    method: 'POST',
    body: message.trim() ? { message: message.trim() } : {},
    schema: CommunitySchema,
  });

export const leaveCommunity = (slug: string): Promise<Community> =>
  apiRequest(`/communities/${slug}/leave`, { method: 'POST', schema: CommunitySchema });

export const listMembers = (
  slug: string,
  status: 'ACTIVE' | 'PENDING' | 'BANNED',
  cursor?: string,
): Promise<PageResponse<CommunityMember>> =>
  page(`/communities/${slug}/members?${qs({ status, limit: '50', cursor })}`, MemberPage);

export const moderateMember = (
  slug: string,
  userId: string,
  verb: 'approve' | 'reject' | 'unban',
) => apiRequest(`/communities/${slug}/members/${userId}/${verb}`, { method: 'POST' });

export const setMemberRole = (
  slug: string,
  userId: string,
  role: 'ADMIN' | 'MODERATOR' | 'MEMBER',
) => apiRequest(`/communities/${slug}/members/${userId}/role`, { method: 'POST', body: { role } });

export const removeMember = (slug: string, userId: string, reason: string, ban: boolean) =>
  apiRequest(`/communities/${slug}/members/${userId}/remove`, {
    method: 'POST',
    body: { ...(reason.trim() ? { reason: reason.trim() } : {}), ban },
  });

export const listCommunityTrips = (
  slug: string,
  when: 'upcoming' | 'past',
  cursor?: string,
): Promise<PageResponse<TripSummary>> =>
  page(`/communities/${slug}/trips?${qs({ when, limit: '20', cursor })}`, TripPage);

export const listCommunityPosts = (slug: string, cursor?: string): Promise<PageResponse<Post>> =>
  page(`/communities/${slug}/posts?${qs({ limit: '20', cursor })}`, PostPage);

export const announce = (slug: string, body: string, membersOnly: boolean): Promise<Post> =>
  apiRequest(`/communities/${slug}/announcements`, {
    method: 'POST',
    body: { body: body.trim(), membersOnly },
    schema: PostSchema,
  });
