import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ChatMessage, MESSAGE_MAX_LENGTH, type ReadState } from '@voyago/shared';
import * as Crypto from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  deleteMessage,
  getConversation,
  listMessages,
  markChatRead,
  muteChat,
  type OutgoingMessage,
  sendMessageOverHttp,
} from '../../src/api/chat';
import { ApiRequestError } from '../../src/api/http';
import { uploadImage } from '../../src/api/maps-media';
import { getMyProfile } from '../../src/api/profile';
import { useFeatures } from '../../src/api/use-features';
import { addMessageToCache, messagesKey } from '../../src/chat/messages-cache';
import { request, useChatSocket } from '../../src/chat/realtime';
import { PHOTOS_OFF_NOTE } from '../../src/components/CoverField';
import { Button, FormMessage } from '../../src/components/Form';
import { ReportForm } from '../../src/components/ReportForm';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

type Pending = OutgoingMessage & {
  previewUri?: string;
  status: 'sending' | 'failed';
  error?: string;
  createdAt: string;
};
type Row = { kind: 'message'; message: ChatMessage } | { kind: 'pending'; pending: Pending };

const TYPING_SEND_MS = 2_000;
const TYPING_IDLE_MS = 3_000;
const TYPING_SHOW_MS = 5_000;

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const features = useFeatures();
  const me = useQuery({ queryKey: ['me'], queryFn: getMyProfile });
  const myId = me.data?.id;
  const conversation = useQuery({
    queryKey: ['conversation', id],
    queryFn: () => getConversation(id),
  });
  const history = useInfiniteQuery({
    queryKey: messagesKey(id),
    queryFn: ({ pageParam }) => listMessages(id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const messages = useMemo(
    () => history.data?.pages.flatMap((page) => page.data) ?? [],
    [history.data],
  );
  const { socket, connected } = useChatSocket();

  const [text, setText] = useState('');
  const [announce, setAnnounce] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [online, setOnline] = useState<string[]>([]);
  const [typing, setTyping] = useState<Record<string, { name: string; until: number }>>({});
  const [liveReads, setLiveReads] = useState<ReadState[]>([]);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Join the room while the screen is open; the server checks membership.
  useEffect(() => {
    if (!socket || !connected) return;
    let active = true;
    void request<{ onlineUserIds: string[] }>(socket, 'conversation:join', {
      conversationId: id,
    }).then((ack) => {
      if (active && ack.ok) setOnline(ack.data.onlineUserIds);
    });
    const ours = (event: { conversationId: string }) => event.conversationId === id;
    const onTyping = (e: {
      conversationId: string;
      userId: string;
      displayName: string;
      typing: boolean;
    }) => {
      if (!ours(e)) return;
      setTyping((current) => {
        const next = { ...current };
        if (e.typing) next[e.userId] = { name: e.displayName, until: Date.now() + TYPING_SHOW_MS };
        else delete next[e.userId];
        return next;
      });
    };
    const onRead = (e: { conversationId: string } & ReadState) => {
      if (!ours(e)) return;
      setLiveReads((current) => [...current.filter((r) => r.userId !== e.userId), e]);
    };
    const onOnline = (e: { conversationId: string; userId: string }) => {
      if (ours(e)) setOnline((current) => [...new Set([...current, e.userId])]);
    };
    const onOffline = (e: { conversationId: string; userId: string }) => {
      if (ours(e)) setOnline((current) => current.filter((u) => u !== e.userId));
    };
    socket.on('typing:update', onTyping);
    socket.on('message:read', onRead);
    socket.on('user:online', onOnline);
    socket.on('user:offline', onOffline);
    return () => {
      active = false;
      socket.off('typing:update', onTyping);
      socket.off('message:read', onRead);
      socket.off('user:online', onOnline);
      socket.off('user:offline', onOffline);
      socket.emit('conversation:leave', { conversationId: id });
    };
  }, [socket, connected, id]);

  // Typing indicators fade on their own if the "stopped" event never arrives.
  useEffect(() => {
    const timer = setInterval(() => {
      setTyping((current) => {
        const now = Date.now();
        const kept = Object.entries(current).filter(([, v]) => v.until > now);
        return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
      });
    }, 1_000);
    return () => clearInterval(timer);
  }, []);

  // Mark the newest message from someone else as read once it is on screen.
  const lastMarked = useRef<string | null>(null);
  const newestFromOthers = messages.find((m) => m.sender && m.sender.id !== myId);
  useEffect(() => {
    if (!myId || !newestFromOthers || lastMarked.current === newestFromOthers.id) return;
    lastMarked.current = newestFromOthers.id;
    const done = () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['chat-unread'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    };
    if (socket && connected) {
      void request(socket, 'message:read', {
        conversationId: id,
        messageId: newestFromOthers.id,
      }).then(done);
    } else {
      void markChatRead(id, newestFromOthers.id).then(done, () => undefined);
    }
  }, [myId, newestFromOthers, socket, connected, id, queryClient]);

  // Typing: at most one "typing" event per two seconds, and "stopped" after a pause.
  const lastTypingSent = useRef(0);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTyping = () => {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = null;
    if (lastTypingSent.current && socket && connected) {
      socket.emit('typing:stop', { conversationId: id });
    }
    lastTypingSent.current = 0;
  };
  const onChangeText = (value: string) => {
    setText(value);
    if (!socket || !connected || value.trim() === '') return;
    if (Date.now() - lastTypingSent.current > TYPING_SEND_MS) {
      socket.emit('typing:start', { conversationId: id });
      lastTypingSent.current = Date.now();
    }
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = setTimeout(stopTyping, TYPING_IDLE_MS);
  };

  const deliver = async (item: Pending) => {
    const payload: OutgoingMessage = {
      clientId: item.clientId,
      ...(item.body ? { body: item.body } : {}),
      ...(item.imageId ? { imageId: item.imageId } : {}),
      ...(item.announcement ? { announcement: true } : {}),
    };
    const fail = (message: string) =>
      setPending((current) =>
        current.map((p) =>
          p.clientId === item.clientId ? { ...p, status: 'failed', error: message } : p,
        ),
      );
    let sent: ChatMessage | null = null;
    if (socket?.connected) {
      const ack = await request<ChatMessage>(socket, 'message:send', {
        conversationId: id,
        ...payload,
      });
      if (ack.ok) sent = ack.data;
      else if (ack.error.status !== 0) return fail(ack.error.message);
    }
    if (!sent) {
      // No live connection: the same clientId over HTTP can't create a duplicate.
      try {
        sent = await sendMessageOverHttp(id, payload);
      } catch (caught) {
        return fail(caught instanceof ApiRequestError ? caught.message : 'Not sent. Tap to retry.');
      }
    }
    addMessageToCache(queryClient, sent);
    setPending((current) => current.filter((p) => p.clientId !== item.clientId));
    void queryClient.invalidateQueries({ queryKey: ['conversations'] });
  };

  const queue = (item: Omit<Pending, 'clientId' | 'status' | 'createdAt'>) => {
    const next: Pending = {
      ...item,
      clientId: Crypto.randomUUID(),
      status: 'sending',
      createdAt: new Date().toISOString(),
    };
    setPending((current) => [next, ...current]);
    void deliver(next);
  };

  const sendText = () => {
    const body = text.trim();
    if (!body) return;
    stopTyping();
    setText('');
    setAnnounce(false);
    queue({ body: body.slice(0, MESSAGE_MAX_LENGTH), announcement: announce });
  };

  const retry = (item: Pending) => {
    setPending((current) =>
      current.map((p) => (p.clientId === item.clientId ? { ...p, status: 'sending' } : p)),
    );
    void deliver({ ...item, status: 'sending' });
  };

  const pickPhoto = async () => {
    setNotice(null);
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.85,
      exif: false,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return;
    setUploading(true);
    try {
      const imageId = await uploadImage(asset, 'chat-photo');
      queue({ imageId, previewUri: asset.uri, ...(text.trim() ? { body: text.trim() } : {}) });
      setText('');
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'The photo could not be uploaded.');
    } finally {
      setUploading(false);
    }
  };

  const mute = useMutation({
    mutationFn: (muted: boolean) => muteChat(id, muted),
    onSuccess: (updated) => {
      queryClient.setQueryData(['conversation', id], updated);
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
  const remove = useMutation({
    mutationFn: deleteMessage,
    onSuccess: () => {
      setSelected(null);
      void history.refetch();
    },
    onError: (caught) => setNotice(caught instanceof Error ? caught.message : 'Not deleted.'),
  });

  const chat = conversation.data;
  const delivered = new Set(messages.map((m) => m.clientId).filter(Boolean));
  const rows: Row[] = [
    ...pending
      .filter((p) => !delivered.has(p.clientId))
      .map((p) => ({ kind: 'pending' as const, pending: p })),
    ...messages.map((m) => ({ kind: 'message' as const, message: m })),
  ];
  const reads = useMemo(() => {
    const byUser = new Map((chat?.readStates ?? []).map((r) => [r.userId, r.lastReadAt]));
    for (const r of liveReads) {
      const known = byUser.get(r.userId);
      if (!known || known < r.lastReadAt) byUser.set(r.userId, r.lastReadAt);
    }
    return byUser;
  }, [chat?.readStates, liveReads]);
  const myLatest = messages.find((m) => m.sender?.id === myId && !m.deleted);
  const seenBy = myLatest
    ? [...reads.entries()].filter(([userId, at]) => userId !== myId && at >= myLatest.createdAt)
        .length
    : 0;
  const typers = Object.entries(typing)
    .filter(([userId]) => userId !== myId)
    .map(([, v]) => v.name);
  const otherOnline = chat?.otherUser ? online.includes(chat.otherUser.id) : false;

  if (conversation.isError) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: 'Chat' }} />
        <View style={styles.padded}>
          <FormMessage tone="error">This chat isn’t available to you.</FormMessage>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <Stack.Screen
        options={{
          title: chat?.title ?? 'Chat',
          headerRight: () =>
            chat ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => mute.mutate(!chat.muted)}
                style={styles.headerButton}
              >
                <Text style={{ color: colors.travel }}>{chat.muted ? 'Unmute' : 'Mute'}</Text>
              </Pressable>
            ) : null,
        }}
      />
      <View style={[styles.status, { borderColor: colors.border }]}>
        <Text
          style={[styles.caption, { color: colors.textMuted }]}
          accessibilityLiveRegion="polite"
        >
          {typers.length > 0
            ? `${typers.join(', ')} ${typers.length === 1 ? 'is' : 'are'} typing…`
            : !connected
              ? 'Connecting… messages still send.'
              : chat?.type === 'DIRECT'
                ? otherOnline
                  ? 'Online'
                  : 'Offline'
                : `${online.length} here now`}
        </Text>
      </View>
      {history.isPending ? (
        <View style={styles.padded}>
          <FormMessage tone="info">Loading messages…</FormMessage>
        </View>
      ) : null}
      <FlatList
        inverted
        data={rows}
        keyExtractor={(row) => (row.kind === 'message' ? row.message.id : row.pending.clientId)}
        contentContainerStyle={styles.list}
        onEndReached={() => {
          if (history.hasNextPage && !history.isFetchingNextPage) void history.fetchNextPage();
        }}
        onEndReachedThreshold={0.3}
        ListEmptyComponent={
          history.isSuccess ? (
            <Text style={[styles.empty, { color: colors.textMuted }]}>
              No messages yet. Say hello.
            </Text>
          ) : undefined
        }
        renderItem={({ item }) =>
          item.kind === 'pending' ? (
            <PendingBubble item={item.pending} onRetry={() => retry(item.pending)} />
          ) : (
            <MessageBubble
              message={item.message}
              mine={item.message.sender?.id === myId}
              showSender={chat?.type !== 'DIRECT'}
              receipt={
                item.message.id === myLatest?.id && seenBy > 0
                  ? chat?.type === 'DIRECT'
                    ? 'Seen'
                    : `Seen by ${seenBy}`
                  : null
              }
              selected={selected === item.message.id}
              onLongPress={() =>
                // Your own messages can be deleted; anyone else's can be reported.
                setSelected(!item.message.deleted && item.message.sender ? item.message.id : null)
              }
              onDelete={() => remove.mutate(item.message.id)}
              deleting={remove.isPending}
            />
          )
        }
      />
      {notice ? (
        <View style={styles.padded}>
          <FormMessage tone="error">{notice}</FormMessage>
        </View>
      ) : null}
      {chat && !chat.canSend ? (
        <View style={styles.padded}>
          <FormMessage tone="info">You can’t send messages in this chat.</FormMessage>
        </View>
      ) : (
        <View
          style={[styles.composer, { borderColor: colors.border, backgroundColor: colors.surface }]}
        >
          {chat?.canAnnounce ? (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: announce }}
              onPress={() => setAnnounce(!announce)}
            >
              <Text
                style={[styles.caption, { color: announce ? colors.travel : colors.textMuted }]}
              >
                {announce ? '☑' : '☐'} Send as announcement (notifies everyone)
              </Text>
            </Pressable>
          ) : null}
          <TextInput
            accessibilityLabel="Message"
            placeholder="Message"
            placeholderTextColor={colors.textMuted}
            value={text}
            onChangeText={onChangeText}
            multiline
            maxLength={MESSAGE_MAX_LENGTH}
            style={[styles.input, { color: colors.text, borderColor: colors.border }]}
          />
          <View style={styles.composerRow}>
            {announce ? null : (
              <Button
                title={uploading ? 'Uploading…' : 'Photo'}
                variant="secondary"
                loading={uploading}
                disabled={!features.coverUploads}
                onPress={() => void pickPhoto()}
              />
            )}
            <Button title="Send" disabled={text.trim() === ''} onPress={sendText} />
          </View>
          {features.coverUploads || announce ? null : (
            <Text style={[styles.caption, { color: colors.textMuted }]}>{PHOTOS_OFF_NOTE}</Text>
          )}
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

function MessageBubble({
  message,
  mine,
  showSender,
  receipt,
  selected,
  onLongPress,
  onDelete,
  deleting,
}: {
  message: ChatMessage;
  mine: boolean;
  showSender: boolean;
  receipt: string | null;
  selected: boolean;
  onLongPress: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const { colors } = useTheme();
  const time = new Date(message.createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (message.type === 'SYSTEM') {
    return <Text style={[styles.system, { color: colors.textMuted }]}>{message.body}</Text>;
  }
  const announcement = message.type === 'ANNOUNCEMENT';
  return (
    <View style={[styles.bubbleWrap, mine ? styles.mineWrap : styles.theirsWrap]}>
      <Pressable
        onLongPress={onLongPress}
        accessibilityHint={
          message.deleted ? undefined : mine ? 'Long press to delete' : 'Long press to report'
        }
        style={[
          styles.bubble,
          {
            backgroundColor: announcement ? colors.surface : mine ? colors.travel : colors.surface,
            borderColor: announcement ? colors.ride : colors.border,
          },
          announcement ? styles.announcement : null,
        ]}
      >
        {announcement ? (
          <Text style={[styles.label, { color: colors.ride }]}>Announcement</Text>
        ) : null}
        {showSender && !mine && message.sender ? (
          <Text style={[styles.label, { color: colors.textMuted }]}>
            {message.sender.displayName}
          </Text>
        ) : null}
        {message.deleted ? (
          <Text
            style={[
              styles.deleted,
              { color: mine && !announcement ? colors.onAccent : colors.textMuted },
            ]}
          >
            Message deleted
          </Text>
        ) : null}
        {message.imageUrl ? (
          <Image
            source={{ uri: message.imageUrl }}
            style={styles.photo}
            accessibilityLabel="Photo"
          />
        ) : null}
        {message.body ? (
          <Text
            style={[styles.body, { color: mine && !announcement ? colors.onAccent : colors.text }]}
          >
            {message.body}
          </Text>
        ) : null}
        <Text
          style={[
            styles.time,
            { color: mine && !announcement ? colors.onAccent : colors.textMuted },
          ]}
        >
          {time}
        </Text>
      </Pressable>
      {receipt ? (
        <Text style={[styles.caption, { color: colors.textMuted }]}>{receipt}</Text>
      ) : null}
      {selected && mine ? (
        <Button title="Delete for everyone" variant="link" loading={deleting} onPress={onDelete} />
      ) : null}
      {selected && !mine ? (
        <ReportForm targetType="MESSAGE" targetId={message.id} label="Report message" />
      ) : null}
    </View>
  );
}

function PendingBubble({ item, onRetry }: { item: Pending; onRetry: () => void }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.bubbleWrap, styles.mineWrap]}>
      <Pressable
        disabled={item.status !== 'failed'}
        onPress={onRetry}
        accessibilityRole={item.status === 'failed' ? 'button' : undefined}
        style={[
          styles.bubble,
          { backgroundColor: colors.travel, borderColor: colors.border, opacity: 0.7 },
        ]}
      >
        {item.previewUri ? (
          <Image
            source={{ uri: item.previewUri }}
            style={styles.photo}
            accessibilityLabel="Photo"
          />
        ) : null}
        {item.body ? (
          <Text style={[styles.body, { color: colors.onAccent }]}>{item.body}</Text>
        ) : null}
      </Pressable>
      <Text
        style={[
          styles.caption,
          { color: item.status === 'failed' ? colors.danger : colors.textMuted },
        ]}
      >
        {item.status === 'failed' ? `${item.error ?? 'Not sent'}. Tap to retry.` : 'Sending…'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  padded: { padding: spacing.md },
  status: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderBottomWidth: 1 },
  headerButton: { paddingHorizontal: spacing.sm },
  list: { padding: spacing.md, gap: spacing.sm },
  empty: { ...typography.body, textAlign: 'center', padding: spacing.lg },
  bubbleWrap: { maxWidth: '85%', gap: 2 },
  mineWrap: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  theirsWrap: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  bubble: { borderWidth: 1, borderRadius: radius.md, padding: spacing.sm, gap: 2 },
  announcement: { borderWidth: 2 },
  label: { ...typography.caption, fontWeight: '600' },
  body: { ...typography.body },
  deleted: { ...typography.body, fontStyle: 'italic' },
  time: { ...typography.caption, alignSelf: 'flex-end', opacity: 0.8 },
  caption: { ...typography.caption },
  system: { ...typography.caption, textAlign: 'center', alignSelf: 'center' },
  photo: { width: 220, height: 220, borderRadius: radius.sm },
  composer: { borderTopWidth: 1, padding: spacing.sm, gap: spacing.sm },
  composerRow: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end' },
  input: {
    ...typography.body,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    maxHeight: 120,
  },
});
