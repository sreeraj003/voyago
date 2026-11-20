import { useQueryClient } from '@tanstack/react-query';
import { type ChatMessage } from '@voyago/shared';
import { useEffect } from 'react';
import {
  addMessageToCache,
  type MessagePages,
  messagesKey,
  withoutMessage,
} from './messages-cache';
import { useChatSocket } from './realtime';

/**
 * App-wide listener while signed in: new messages land in any open history and refresh the chat
 * list and the Inbox badge.
 */
export function useChatEvents(): void {
  const queryClient = useQueryClient();
  const { socket } = useChatSocket();
  useEffect(() => {
    if (!socket) return;
    const onMessage = (message: ChatMessage) => {
      addMessageToCache(queryClient, message);
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['chat-unread'] });
    };
    const onDeleted = (event: { conversationId: string; messageId: string }) => {
      queryClient.setQueryData<MessagePages>(messagesKey(event.conversationId), (data) =>
        withoutMessage(data, event.messageId),
      );
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    };
    const onReconnect = () => {
      // Catch up on anything sent while the connection was down.
      void queryClient.invalidateQueries({ queryKey: ['chat-messages'] });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    };
    socket.on('message:new', onMessage);
    socket.on('message:deleted', onDeleted);
    socket.io.on('reconnect', onReconnect);
    return () => {
      socket.off('message:new', onMessage);
      socket.off('message:deleted', onDeleted);
      socket.io.off('reconnect', onReconnect);
    };
  }, [socket, queryClient]);
}
