import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { type ClientToServerEvents, type ServerToClientEvents } from '@voyago/shared';
import { type Server } from 'socket.io';
import { PrismaService } from '../database/prisma.service.js';

export interface SocketData {
  userId: string;
  sessionFamilyId: string;
  displayName: string;
  /** People this member blocked or was blocked by; refreshed when joining a chat. */
  blocked: string[];
}

export type RealtimeServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export const conversationRoom = (conversationId: string) => `conv:${conversationId}`;
export const userRoom = (userId: string) => `user:${userId}`;

/**
 * The Socket.IO server, as seen by the rest of the API. The server itself is created by
 * ChatGateway once the HTTP server exists; until then (and in unit tests) every call is a no-op.
 * With the Redis adapter these calls reach sockets on every API instance.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  io: RealtimeServer | null = null;

  constructor(private readonly prisma: PrismaService) {}

  emitToConversation<E extends keyof ServerToClientEvents>(
    conversationId: string,
    exceptUserIds: string[],
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    this.emitTo(conversationId, [], exceptUserIds, event, ...args);
  }

  /**
   * Emits to everyone in the chat's room and to these members' own rooms (so their chat list and
   * badge update without opening the chat). Socket.IO sends each socket one copy.
   */
  emitTo<E extends keyof ServerToClientEvents>(
    conversationId: string,
    userIds: string[],
    exceptUserIds: string[],
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    if (!this.io) return;
    this.io
      .to([conversationRoom(conversationId), ...userIds.map(userRoom)])
      .except(exceptUserIds.map(userRoom))
      .emit(event, ...args);
  }

  /** Members with at least one socket open in the chat right now. */
  async onlineUserIds(conversationId: string): Promise<string[]> {
    if (!this.io) return [];
    try {
      const sockets = await this.io.in(conversationRoom(conversationId)).fetchSockets();
      return [...new Set(sockets.map((s) => s.data.userId))];
    } catch (error) {
      this.logger.warn(`Presence lookup failed: ${(error as Error).message}`);
      return [];
    }
  }

  /** Stops a member who left or was removed from receiving a trip's chat. */
  async leaveTripChat(tripId: string, userId: string): Promise<void> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { tripId },
      select: { id: true },
    });
    if (conversation) this.evict(conversation.id, userId);
  }

  async leaveCommunityChat(communityId: string, userId: string): Promise<void> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { communityId },
      select: { id: true },
    });
    if (conversation) this.evict(conversation.id, userId);
  }

  private evict(conversationId: string, userId: string): void {
    if (!this.io) return;
    const room = conversationRoom(conversationId);
    this.io.in(userRoom(userId)).socketsLeave(room);
    this.io.to(room).emit('user:offline', { conversationId, userId });
  }
}

@Global()
@Module({ providers: [RealtimeService], exports: [RealtimeService] })
export class RealtimeModule {}
