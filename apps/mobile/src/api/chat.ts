import {
  type ChatMessage,
  ChatMessageSchema,
  ChatUnreadSchema,
  type Conversation,
  ConversationSchema,
  pageEnvelope,
  type PageResponse,
  ReadStateSchema,
} from '@voyago/shared';
import { z } from 'zod';
import { apiRequest } from './http';

const ConversationPage = pageEnvelope(ConversationSchema);
const MessagePage = pageEnvelope(ChatMessageSchema);

const page = async <T>(path: string, schema: z.ZodType<T>): Promise<T> =>
  schema.parse(await apiRequest(path, { schema: z.unknown(), raw: true }));
const query = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const listConversations = (cursor?: string): Promise<PageResponse<Conversation>> =>
  page(`/me/conversations${query({ cursor })}`, ConversationPage);

export const getChatUnreadCount = async (): Promise<number> =>
  (await apiRequest('/me/conversations/unread-count', { schema: ChatUnreadSchema })).count;

export const getConversation = (id: string): Promise<Conversation> =>
  apiRequest(`/conversations/${id}`, { schema: ConversationSchema });

export const openTripChat = (tripId: string): Promise<Conversation> =>
  apiRequest(`/trips/${tripId}/chat`, { method: 'POST', schema: ConversationSchema });

export const openCommunityChat = (slug: string): Promise<Conversation> =>
  apiRequest(`/communities/${slug}/chat`, { method: 'POST', schema: ConversationSchema });

export const openDirectChat = (username: string): Promise<Conversation> =>
  apiRequest('/conversations/direct', {
    method: 'POST',
    body: { username },
    schema: ConversationSchema,
  });

/** Newest first. */
export const listMessages = (id: string, cursor?: string): Promise<PageResponse<ChatMessage>> =>
  page(`/conversations/${id}/messages${query({ cursor, limit: '30' })}`, MessagePage);

export interface OutgoingMessage {
  clientId: string;
  body?: string;
  imageId?: string;
  announcement?: boolean;
}

/** REST fallback for when the live connection is down; same rules and idempotency. */
export const sendMessageOverHttp = (id: string, message: OutgoingMessage): Promise<ChatMessage> =>
  apiRequest(`/conversations/${id}/messages`, {
    method: 'POST',
    body: message,
    schema: ChatMessageSchema,
  });

export const markChatRead = (id: string, messageId: string) =>
  apiRequest(`/conversations/${id}/read`, {
    method: 'POST',
    body: { messageId },
    schema: ReadStateSchema,
  });

export const muteChat = (id: string, muted: boolean): Promise<Conversation> =>
  apiRequest(`/conversations/${id}/mute`, {
    method: 'POST',
    body: { muted },
    schema: ConversationSchema,
  });

export const deleteMessage = (id: string) =>
  apiRequest(`/messages/${id}/delete`, { method: 'POST' });

export const registerPushToken = (token: string, platform: 'IOS' | 'ANDROID') =>
  apiRequest('/me/push-tokens', { method: 'POST', body: { token, platform } });

export const removePushToken = (token: string) =>
  apiRequest('/me/push-tokens/remove', { method: 'POST', body: { token } });
