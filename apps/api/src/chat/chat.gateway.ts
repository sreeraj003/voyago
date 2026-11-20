import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { createAdapter } from '@socket.io/redis-adapter';
import {
  type ClientToServerEvents,
  ConversationRefSchema,
  REALTIME_PATH,
  type SocketAck,
  SocketReadSchema,
  SocketLocationUpdateSchema,
  SocketSendSchema,
  type ServerToClientEvents,
} from '@voyago/shared';
import { type Redis } from 'ioredis';
import { decodeJwt } from 'jose';
import { Server, type Socket } from 'socket.io';
import { ZodError, type z } from 'zod';
import { SessionService } from '../auth/session.service.js';
import { TokenService } from '../auth/token.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { SafetyService } from '../safety/safety.service.js';
import { blockedIds } from '../social/blocks.js';
import { ChatService } from './chat.service.js';
import {
  conversationRoom,
  RealtimeService,
  type RealtimeServer,
  type SocketData,
  userRoom,
} from './realtime.service.js';

type AnySocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

/** Largest socket frame; messages are at most 2,000 characters. */
const MAX_FRAME_BYTES = 32 * 1024;
/** One "typing" event per chat per this long is forwarded; the rest are dropped. */
const TYPING_INTERVAL_MS = 1_500;

/**
 * Socket.IO on the API's own HTTP server, at REALTIME_PATH. Every connection must present a
 * valid access token (`auth: { token }`); the socket is closed when that token expires, and the
 * session is checked again on each join and send, so signing out or suspension cuts it off.
 * Messages go through ChatService, the same rules as the REST routes.
 */
@Injectable()
export class ChatGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ChatGateway.name);
  private io: RealtimeServer | null = null;
  private redisClients: Redis[] = [];

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    private readonly chat: ChatService,
    private readonly realtime: RealtimeService,
    private readonly redis: RedisService,
    private readonly safety: SafetyService,
  ) {}

  onApplicationBootstrap(): void {
    const httpServer: unknown = this.adapterHost.httpAdapter?.getHttpServer();
    if (!httpServer) return;
    const io: RealtimeServer = new Server(httpServer as never, {
      path: REALTIME_PATH,
      serveClient: false,
      maxHttpBufferSize: MAX_FRAME_BYTES,
      cors: {
        origin: this.config.CORS_ORIGINS.length > 0 ? this.config.CORS_ORIGINS : false,
        credentials: true,
      },
    });
    // The Redis adapter lets every API instance reach every socket. These connections queue
    // commands while Redis is away, so a restart of Redis doesn't break chat for good.
    const pub = this.redis.client.duplicate({
      lazyConnect: false,
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
    });
    const sub = pub.duplicate();
    for (const client of [pub, sub]) {
      client.on('error', (error: Error) => this.logger.warn(`Realtime Redis: ${error.message}`));
    }
    this.redisClients = [pub, sub];
    io.adapter(createAdapter(pub, sub));
    io.use((socket, next) => {
      this.authenticate(socket).then(
        () => next(),
        () => next(new Error('unauthorized')),
      );
    });
    io.on('connection', (socket) => this.onConnection(socket));
    this.io = io;
    this.realtime.io = io;
  }

  async onApplicationShutdown(): Promise<void> {
    this.realtime.io = null;
    if (this.io) {
      this.io.local.disconnectSockets(true);
      // Close only Socket.IO's own engine; Nest closes the HTTP server.
      this.io.engine.close();
      this.io = null;
    }
    const [pub, sub] = this.redisClients;
    this.redisClients = [];
    // Stop hearing other instances' requests first, give answers already being prepared a moment
    // to go out, then close the publishing connection (quit waits for queued commands).
    if (sub) await closeGracefully(sub);
    await new Promise((resolve) => setTimeout(resolve, ANSWER_GRACE_MS).unref());
    if (pub) await closeGracefully(pub);
  }

  private async authenticate(socket: AnySocket): Promise<void> {
    const auth = socket.handshake.auth as { token?: unknown };
    if (typeof auth.token !== 'string') throw new Error('missing token');
    const claims = await this.tokens.verifyAccessToken(auth.token);
    const user = await this.sessions.findActiveUser(claims.userId, claims.sessionFamilyId);
    if (!user || user.status !== 'ACTIVE' || user.deletedAt) throw new Error('inactive');
    const profile = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { displayName: true },
    });
    socket.data = {
      userId: user.id,
      sessionFamilyId: claims.sessionFamilyId,
      displayName: profile.displayName,
      blocked: await blockedIds(this.prisma, user.id),
    };
    // Close the socket when its token expires; the app reconnects with a fresh one.
    const { exp } = decodeJwt(auth.token);
    if (typeof exp === 'number') {
      const timer = setTimeout(() => socket.disconnect(true), Math.max(exp * 1000 - Date.now(), 0));
      timer.unref();
      socket.once('disconnect', () => clearTimeout(timer));
    }
  }

  private onConnection(socket: AnySocket): void {
    const { userId } = socket.data;
    void socket.join(userRoom(userId));
    const lastTyping = new Map<string, number>();

    socket.on(
      'conversation:join',
      this.handler(socket, ConversationRefSchema, async ({ conversationId }) => {
        await this.assertSession(socket);
        await this.chat.access(userId, conversationId);
        socket.data.blocked = await blockedIds(this.prisma, userId);
        const room = conversationRoom(conversationId);
        if (!socket.rooms.has(room)) {
          await socket.join(room);
          socket
            .to(room)
            .except(socket.data.blocked.map(userRoom))
            .emit('user:online', { conversationId, userId });
        }
        const online = await this.realtime.onlineUserIds(conversationId);
        return { onlineUserIds: online.filter((id) => !socket.data.blocked.includes(id)) };
      }),
    );

    socket.on(
      'conversation:leave',
      this.handler(socket, ConversationRefSchema, async ({ conversationId }) => {
        const room = conversationRoom(conversationId);
        if (socket.rooms.has(room)) {
          await socket.leave(room);
          await this.announceOfflineIfGone(socket, conversationId);
        }
        return null;
      }),
    );

    socket.on(
      'message:send',
      this.handler(socket, SocketSendSchema, async ({ conversationId, ...input }) => {
        await this.assertSession(socket);
        const { message } = await this.chat.send(userId, conversationId, input);
        return message;
      }),
    );

    socket.on(
      'message:read',
      this.handler(socket, SocketReadSchema, async ({ conversationId, messageId }) => {
        return this.chat.markRead(userId, conversationId, messageId);
      }),
    );

    // Live location: the same checks as the REST route (membership, session, expiry, rate).
    socket.on(
      'location:update',
      this.handler(socket, SocketLocationUpdateSchema, async ({ tripId, ...reading }) => {
        await this.assertSession(socket);
        return this.safety.update(userId, tripId, reading);
      }),
    );

    const typing = (state: boolean) => (payload: unknown) => {
      const parsed = ConversationRefSchema.safeParse(payload);
      if (!parsed.success) return;
      const { conversationId } = parsed.data;
      const room = conversationRoom(conversationId);
      // Only chats this socket has joined (and so was authorised for).
      if (!socket.rooms.has(room)) return;
      const now = Date.now();
      if (state && now - (lastTyping.get(conversationId) ?? 0) < TYPING_INTERVAL_MS) return;
      lastTyping.set(conversationId, state ? now : 0);
      socket.to(room).except(socket.data.blocked.map(userRoom)).emit('typing:update', {
        conversationId,
        userId,
        displayName: socket.data.displayName,
        typing: state,
      });
    };
    socket.on('typing:start', typing(true));
    socket.on('typing:stop', typing(false));

    socket.on('disconnecting', () => {
      for (const room of socket.rooms) {
        if (!room.startsWith('conv:')) continue;
        const conversationId = room.slice('conv:'.length);
        void this.announceOfflineIfGone(socket, conversationId, true);
      }
    });
  }

  /** Tells the chat a member went offline once their last socket in it has gone. */
  private async announceOfflineIfGone(
    socket: AnySocket,
    conversationId: string,
    leaving = false,
  ): Promise<void> {
    const { userId } = socket.data;
    try {
      const sockets = await this.io?.in(conversationRoom(conversationId)).fetchSockets();
      const stillHere = (sockets ?? []).some(
        (s) => s.data.userId === userId && !(leaving && s.id === socket.id),
      );
      if (stillHere) return;
      this.io
        ?.to(conversationRoom(conversationId))
        .except([...socket.data.blocked.map(userRoom), userRoom(userId)])
        .emit('user:offline', { conversationId, userId });
    } catch (error) {
      this.logger.warn(`Presence update failed: ${(error as Error).message}`);
    }
  }

  private async assertSession(socket: AnySocket): Promise<void> {
    const { userId, sessionFamilyId } = socket.data;
    const user = await this.sessions.findActiveUser(userId, sessionFamilyId);
    if (!user || user.status !== 'ACTIVE' || user.deletedAt) {
      // The handler answers first, then closes the socket (see below).
      throw new HttpException('Session ended. Sign in again.', 401);
    }
  }

  /** Validates the payload, runs the action and answers through the acknowledgement callback. */
  private handler<S extends z.ZodType, T>(
    socket: AnySocket,
    schema: S,
    action: (payload: z.output<S>) => Promise<T>,
  ) {
    return (payload: unknown, ack?: unknown) => {
      const reply = (result: SocketAck<T>) => {
        if (typeof ack === 'function') (ack as (r: SocketAck<T>) => void)(result);
      };
      void (async () => {
        try {
          reply({ ok: true, data: await action(schema.parse(payload)) });
        } catch (error) {
          const failure = this.toAckError(error, socket);
          reply({ ok: false, error: failure });
          if (failure.status === 401) setImmediate(() => socket.disconnect(true));
        }
      })();
    };
  }

  private toAckError(error: unknown, socket: AnySocket): { status: number; message: string } {
    if (error instanceof ZodError) {
      return { status: 400, message: error.issues[0]?.message ?? 'Invalid request' };
    }
    if (error instanceof HttpException) {
      const body = error.getResponse();
      const message =
        typeof body === 'string'
          ? body
          : typeof (body as { message?: unknown }).message === 'string'
            ? (body as { message: string }).message
            : error.message;
      return { status: error.getStatus(), message };
    }
    this.logger.error(`Socket event failed for ${socket.data.userId}: ${(error as Error).message}`);
    return { status: 500, message: 'Something went wrong' };
  }
}

/** How long shutdown lets answers to other instances' requests finish before closing. */
const ANSWER_GRACE_MS = 100;
/** How long shutdown waits for a still-connecting Redis connection before dropping it. */
const CLOSE_WAIT_MS = 1_000;

/**
 * Lets queued commands (subscriptions, answers to other instances) finish before closing.
 * Dropping a connection that still has queued commands rejects them inside the adapter, where
 * nothing handles the error.
 */
async function closeGracefully(client: Redis): Promise<void> {
  if (
    client.status === 'connecting' ||
    client.status === 'connect' ||
    client.status === 'reconnecting'
  ) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_WAIT_MS);
      timer.unref();
      client.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (client.status === 'ready') {
    await client.quit().catch(() => client.disconnect());
  } else {
    client.disconnect();
  }
}
