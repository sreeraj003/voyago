import { type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { type ChatMessage, type PageResponse } from '@voyago/shared';

export type MessagePages = InfiniteData<PageResponse<ChatMessage>, string | undefined>;

export const messagesKey = (conversationId: string) => ['chat-messages', conversationId] as const;

/** Adds a live message to cached history (newest first), or replaces the copy already there. */
export function withMessage(data: MessagePages | undefined, message: ChatMessage) {
  if (!data) return data;
  const exists = data.pages.some((p) => p.data.some((m) => m.id === message.id));
  if (exists) {
    return {
      ...data,
      pages: data.pages.map((p) => ({
        ...p,
        data: p.data.map((m) => (m.id === message.id ? message : m)),
      })),
    };
  }
  const [first, ...rest] = data.pages;
  if (!first) return data;
  return { ...data, pages: [{ ...first, data: [message, ...first.data] }, ...rest] };
}

/** Marks a message deleted in cached history. */
export function withoutMessage(data: MessagePages | undefined, messageId: string) {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((p) => ({
      ...p,
      data: p.data.map((m) =>
        m.id === messageId ? { ...m, deleted: true, body: null, imageUrl: null } : m,
      ),
    })),
  };
}

export function addMessageToCache(client: QueryClient, message: ChatMessage) {
  client.setQueryData<MessagePages>(messagesKey(message.conversationId), (data) =>
    withMessage(data, message),
  );
}
