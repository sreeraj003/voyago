import {
  type BlockedUser,
  BlockedUserSchema,
  type CreatePostInput,
  type CreateReportInput,
  type FeedItem,
  FeedItemSchema,
  pageEnvelope,
  type PageResponse,
  type Post,
  PostSchema,
  type PublicProfile,
  PublicProfileSchema,
  ReportReceiptSchema,
} from '@voyago/shared';
import { z } from 'zod';
import { apiRequest } from './http';

const FeedPage = pageEnvelope(FeedItemSchema);

export const getPublicProfile = (username: string): Promise<PublicProfile> =>
  apiRequest(`/users/${encodeURIComponent(username)}`, { schema: PublicProfileSchema });

export const follow = (username: string) =>
  apiRequest(`/users/${encodeURIComponent(username)}/follow`, { method: 'POST' });

export const unfollow = (username: string) =>
  apiRequest(`/users/${encodeURIComponent(username)}/follow`, { method: 'DELETE' });

export const block = (username: string) =>
  apiRequest(`/users/${encodeURIComponent(username)}/block`, { method: 'POST' });

export const unblock = (username: string) =>
  apiRequest(`/users/${encodeURIComponent(username)}/block`, { method: 'DELETE' });

export const listBlocks = (): Promise<BlockedUser[]> =>
  apiRequest('/me/blocks', { schema: z.array(BlockedUserSchema) });

export const report = (input: CreateReportInput) =>
  apiRequest('/reports', { method: 'POST', body: input, schema: ReportReceiptSchema });

export const getFeed = async (cursor?: string): Promise<PageResponse<FeedItem>> =>
  FeedPage.parse(
    await apiRequest(`/feed?limit=20${cursor ? `&cursor=${cursor}` : ''}`, {
      schema: z.unknown(),
      raw: true,
    }),
  );

export const createPost = (input: CreatePostInput): Promise<Post> =>
  apiRequest('/posts', { method: 'POST', body: input, schema: PostSchema });

export const deletePost = (id: string) => apiRequest(`/posts/${id}`, { method: 'DELETE' });
