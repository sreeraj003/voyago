import { z } from 'zod';
import { UsernameSchema } from './auth.js';
import { ChatPhotoIdSchema } from './maps-media.js';
import { CursorPageQuerySchema, PageInfoSchema } from './pagination.js';

/** Socket.IO path on the API host (the client connects to the API origin with this path). */
export const REALTIME_PATH = '/api/v1/realtime';
export const MESSAGE_MAX_LENGTH = 2000;

export const ConversationTypeSchema = z.enum(['DIRECT', 'TRIP_GROUP', 'COMMUNITY']);
export type ConversationType = z.infer<typeof ConversationTypeSchema>;

export const MessageTypeSchema = z.enum(['TEXT', 'IMAGE', 'SYSTEM', 'ANNOUNCEMENT']);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const ChatPersonSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
});
export type ChatPerson = z.infer<typeof ChatPersonSchema>;

export const ChatMessageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  type: MessageTypeSchema,
  /** Null for photos without a caption and for deleted messages. */
  body: z.string().nullable(),
  /** A signed, private image link, shown only to members. */
  imageUrl: z.string().nullable(),
  /** Null for system messages and erased accounts. */
  sender: ChatPersonSchema.nullable(),
  /** The id the sending device chose, so it can match its pending copy. */
  clientId: z.uuid().nullable(),
  deleted: z.boolean(),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ReadStateSchema = z.object({ userId: z.uuid(), lastReadAt: z.string() });
export type ReadState = z.infer<typeof ReadStateSchema>;

export const ConversationSchema = z.object({
  id: z.uuid(),
  type: ConversationTypeSchema,
  /** Trip title, community name, or the other person's name. */
  title: z.string(),
  tripId: z.uuid().nullable(),
  communitySlug: z.string().nullable(),
  /** The other person, in a direct chat. */
  otherUser: ChatPersonSchema.nullable(),
  lastMessage: ChatMessageSchema.nullable(),
  unreadCount: z.number().int(),
  muted: z.boolean(),
  /** False when a direct chat is closed (a block, or their message setting). */
  canSend: z.boolean(),
  /** Organisers and community moderators can post announcements in groups. */
  canAnnounce: z.boolean(),
  /** How far each member has read (direct and trip chats; empty for communities). */
  readStates: z.array(ReadStateSchema),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const ConversationPageSchema = z.object({
  data: z.array(ConversationSchema),
  page: PageInfoSchema,
});

export const MessagesQuerySchema = CursorPageQuerySchema;
export const ConversationsQuerySchema = CursorPageQuerySchema;

export const StartDirectChatSchema = z.object({ username: UsernameSchema });

export const SendMessageSchema = z
  .object({
    /** A fresh UUID per message; sending the same one again returns the stored message. */
    clientId: z.uuid(),
    body: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH).optional(),
    imageId: ChatPhotoIdSchema.optional(),
    announcement: z.boolean().default(false),
  })
  .refine((value) => value.body !== undefined || value.imageId !== undefined, {
    message: 'Write a message or add a photo',
    path: ['body'],
  })
  .refine((value) => !value.announcement || (value.body !== undefined && !value.imageId), {
    message: 'Announcements are text only',
    path: ['announcement'],
  });
export type SendMessageInput = z.input<typeof SendMessageSchema>;

export const MarkReadSchema = z.object({ messageId: z.uuid() });
export const MuteConversationSchema = z.object({ muted: z.boolean() });
export const ChatUnreadSchema = z.object({ count: z.number().int() });

// ── Push ────────────────────────────────────────────────────────────────────

export const PushPlatformSchema = z.enum(['IOS', 'ANDROID']);
export const PushTokenSchema = z
  .string()
  .regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$/, 'Not an Expo push token');
export const RegisterPushTokenSchema = z.object({
  token: PushTokenSchema,
  platform: PushPlatformSchema,
});
export const RemovePushTokenSchema = z.object({ token: PushTokenSchema });

// ── Socket events ───────────────────────────────────────────────────────────

export const ConversationRefSchema = z.object({ conversationId: z.uuid() });
export const SocketSendSchema = z.intersection(ConversationRefSchema, SendMessageSchema);
export const SocketReadSchema = ConversationRefSchema.extend({ messageId: z.uuid() });

/** Every socket request is acknowledged with this shape. */
export type SocketAck<T = unknown> =
  { ok: true; data: T } | { ok: false; error: { status: number; message: string } };

export interface ServerToClientEvents {
  'message:new': (message: ChatMessage) => void;
  'message:deleted': (event: { conversationId: string; messageId: string }) => void;
  'message:read': (event: { conversationId: string } & ReadState) => void;
  'typing:update': (event: {
    conversationId: string;
    userId: string;
    displayName: string;
    typing: boolean;
  }) => void;
  'user:online': (event: { conversationId: string; userId: string }) => void;
  'user:offline': (event: { conversationId: string; userId: string }) => void;
}

export interface ClientToServerEvents {
  'conversation:join': (
    payload: { conversationId: string },
    ack: (result: SocketAck<{ onlineUserIds: string[] }>) => void,
  ) => void;
  'conversation:leave': (payload: { conversationId: string }, ack?: (r: SocketAck) => void) => void;
  'message:send': (
    payload: { conversationId: string } & SendMessageInput,
    ack: (result: SocketAck<ChatMessage>) => void,
  ) => void;
  'message:read': (
    payload: { conversationId: string; messageId: string },
    ack?: (result: SocketAck) => void,
  ) => void;
  'typing:start': (payload: { conversationId: string }) => void;
  'typing:stop': (payload: { conversationId: string }) => void;
}
