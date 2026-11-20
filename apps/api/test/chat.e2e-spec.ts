import 'reflect-metadata';
import 'dotenv/config';
import { type INestApplication } from '@nestjs/common';
import {
  type AuthTokens,
  type ChatMessage,
  ChatMessageSchema,
  type ClientToServerEvents,
  type Conversation,
  ConversationSchema,
  NotificationSchema,
  PublicProfileSchema,
  REALTIME_PATH,
  type ServerToClientEvents,
  type SocketAck,
  TripSchema,
} from '@voyago/shared';
import { randomUUID } from 'node:crypto';
import { type AddressInfo, type Server } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { z } from 'zod';
import { PrismaService } from '../src/database/prisma.service.js';
import { type DevPushSender, PUSH_SENDER } from '../src/notifications/push/push-sender.js';
import { bearer, login, registerAndLogin, startAuthApp } from './support/auth-helpers.js';

/** Chat over REST and Socket.IO, against the real database and Redis. */
const prefix = `ch_${randomUUID().slice(0, 6)}`;
const RATE_LIMIT = 12;
const dataOf = <T>(schema: z.ZodType<T>, res: { body: unknown }) =>
  schema.parse((res.body as { data: unknown }).data);
const MessagePage = z.object({
  data: z.array(ChatMessageSchema),
  page: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() }),
});
const NotificationPage = z.object({ data: z.array(NotificationSchema) });

type ChatClient = Socket<ServerToClientEvents, ClientToServerEvents>;
const NAMES = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina'] as const;
type Name = (typeof NAMES)[number];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('chat (e2e)', () => {
  let app: INestApplication<App>;
  let baseUrl: string;
  const tokens = {} as Record<Name, AuthTokens>;
  const ids = {} as Record<Name, string>;
  const sockets: ChatClient[] = [];
  const http = () => request(app.getHttpServer());
  const prisma = () => app.get(PrismaService);
  const as = (name: Name) => ({ authorization: bearer(tokens[name]) });

  const socketFor = async (name: Name): Promise<ChatClient> => {
    const socket: ChatClient = connect(baseUrl, {
      path: REALTIME_PATH,
      auth: { token: tokens[name].accessToken },
      transports: ['websocket'],
      reconnection: false,
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    return socket;
  };
  const emit = <T>(socket: ChatClient, event: keyof ClientToServerEvents, payload: object) =>
    new Promise<SocketAck<T>>((resolve) => {
      (socket.emit as (e: string, p: object, ack: (r: SocketAck<T>) => void) => void)(
        event,
        payload,
        resolve,
      );
    });
  const join = async (socket: ChatClient, conversationId: string) => {
    const ack = await emit<{ onlineUserIds: string[] }>(socket, 'conversation:join', {
      conversationId,
    });
    if (!ack.ok) throw new Error(ack.error.message);
    return ack.data.onlineUserIds;
  };
  /** Collects events of one kind as they arrive. */
  const collect = <E extends keyof ServerToClientEvents>(socket: ChatClient, event: E) => {
    const seen: Parameters<ServerToClientEvents[E]>[0][] = [];
    (socket.on as (e: string, fn: (payload: never) => void) => void)(event, (payload) =>
      seen.push(payload),
    );
    return seen;
  };
  const waitFor = async (check: () => boolean, ms = 3_000) => {
    const until = Date.now() + ms;
    while (!check()) {
      if (Date.now() > until) throw new Error('Timed out waiting');
      await sleep(25);
    }
  };

  const openDirect = (from: Name, to: Name) =>
    http()
      .post('/api/v1/conversations/direct')
      .set(as(from))
      .send({ username: `${prefix}_${to}` });
  const send = (name: Name, conversationId: string, payload: object) =>
    http()
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set(as(name))
      .send({ clientId: randomUUID(), ...payload });
  const allowMessages = (name: Name, value: string) =>
    http()
      .patch('/api/v1/me/preferences')
      .set(as(name))
      .send({ allowMessagesFrom: value })
      .expect(200);
  const createTrip = async (by: Name) => {
    const res = await http()
      .post('/api/v1/trips')
      .set(as(by))
      .send({
        mode: 'RIDE',
        activityType: 'MOTORCYCLE_RIDE',
        title: 'Chat ride to Nandi Hills',
        origin: { name: 'Hebbal', point: { latitude: 13.0358, longitude: 77.597 } },
        destination: { name: 'Nandi Hills', point: { latitude: 13.3702, longitude: 77.6835 } },
        departureAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
        maxParticipants: 8,
        visibility: 'PUBLIC',
      })
      .expect(201);
    const trip = dataOf(TripSchema, res);
    await http().post(`/api/v1/trips/${trip.id}/publish`).set(as(by)).expect(200);
    return trip.id;
  };
  const addToTrip = (tripId: string, name: Name) =>
    prisma().tripParticipant.create({ data: { tripId, userId: ids[name] } });
  const notifications = async (name: Name) =>
    NotificationPage.parse(
      (await http().get('/api/v1/me/notifications?limit=50').set(as(name)).expect(200)).body,
    ).data;

  beforeAll(async () => {
    app = await startAuthApp({
      PUSH_PROVIDER: 'dev',
      CHAT_RATE_LIMIT_PER_MINUTE: String(RATE_LIMIT),
    });
    await app.listen(0);
    const server = app.getHttpServer() as unknown as Server;
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    for (const name of NAMES) {
      await registerAndLogin(app, {
        email: `${prefix}_${name}@example.test`,
        username: `${prefix}_${name}`,
      });
      tokens[name] = await login(app, `${prefix}_${name}@example.test`);
      ids[name] = (
        await prisma().user.findUniqueOrThrow({ where: { username: `${prefix}_${name}` } })
      ).id;
    }
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.disconnect();
  });

  afterAll(async () => {
    const userIds = Object.values(ids);
    await prisma().trip.deleteMany({ where: { organiserId: { in: userIds } } });
    await prisma().community.deleteMany({ where: { createdById: { in: userIds } } });
    await prisma().conversation.deleteMany({
      where: { type: 'DIRECT', members: { some: { userId: { in: userIds } } } },
    });
    await prisma().user.deleteMany({ where: { id: { in: userIds } } });
    await app?.close();
  });

  describe('socket authentication', () => {
    it('refuses connections without a valid access token', async () => {
      for (const auth of [{}, { token: 'not-a-token' }]) {
        const socket: ChatClient = connect(baseUrl, {
          path: REALTIME_PATH,
          auth,
          transports: ['websocket'],
          reconnection: false,
        });
        sockets.push(socket);
        const error = await new Promise<Error>((resolve) => socket.once('connect_error', resolve));
        expect(error.message).toBe('unauthorized');
      }
    });

    it('stops a socket whose session was signed out', async () => {
      const session = await login(app, `${prefix}_gina@example.test`);
      const socket: ChatClient = connect(baseUrl, {
        path: REALTIME_PATH,
        auth: { token: session.accessToken },
        transports: ['websocket'],
        reconnection: false,
      });
      sockets.push(socket);
      await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
      await http()
        .post('/api/v1/auth/logout')
        .set({ authorization: bearer(session) })
        .expect(204);
      const ack = await emit(socket, 'conversation:join', { conversationId: randomUUID() });
      expect(ack).toMatchObject({ ok: false, error: { status: 401 } });
      await waitFor(() => socket.disconnected);
    });
  });

  describe('direct messages', () => {
    let chat: Conversation;

    it("follows the recipient's message setting", async () => {
      // Default: only people you share a trip with.
      await openDirect('alice', 'bob').expect(403);
      const profile = await http().get(`/api/v1/users/${prefix}_bob`).set(as('alice')).expect(200);
      expect(dataOf(PublicProfileSchema, profile).canMessage).toBe(false);

      await allowMessages('bob', 'EVERYONE');
      expect(
        dataOf(
          PublicProfileSchema,
          await http().get(`/api/v1/users/${prefix}_bob`).set(as('alice')).expect(200),
        ).canMessage,
      ).toBe(true);
      chat = dataOf(ConversationSchema, await openDirect('alice', 'bob').expect(200));
      expect(chat).toMatchObject({ type: 'DIRECT', canSend: true, canAnnounce: false });
      expect(chat.otherUser?.username).toBe(`${prefix}_bob`);
      // Bob opening it finds the same chat.
      const fromBob = dataOf(ConversationSchema, await openDirect('bob', 'alice').expect(200));
      expect(fromBob.id).toBe(chat.id);
      // Followers-only: Carol doesn't follow Bob.
      await allowMessages('bob', 'FOLLOWERS');
      await openDirect('carol', 'bob').expect(403);
      await http().post(`/api/v1/users/${prefix}_bob/follow`).set(as('carol')).expect(204);
      await openDirect('carol', 'bob').expect(200);
      await allowMessages('bob', 'EVERYONE');
      await openDirect('alice', 'alice').expect(404);
    });

    it('delivers live, once per clientId, with typing and read receipts', async () => {
      const [aliceSocket, bobSocket] = [await socketFor('alice'), await socketFor('bob')];
      await join(aliceSocket, chat.id);
      const online = await join(bobSocket, chat.id);
      expect(online.sort()).toEqual([ids.alice, ids.bob].sort());
      const received = collect(bobSocket, 'message:new');
      const typing = collect(bobSocket, 'typing:update');
      const reads = collect(aliceSocket, 'message:read');

      aliceSocket.emit('typing:start', { conversationId: chat.id });
      aliceSocket.emit('typing:start', { conversationId: chat.id });
      await waitFor(() => typing.length === 1);
      expect(typing[0]).toMatchObject({ userId: ids.alice, typing: true });

      const clientId = randomUUID();
      const first = await emit<ChatMessage>(aliceSocket, 'message:send', {
        conversationId: chat.id,
        clientId,
        body: '  Ready for Sunday?  ',
      });
      const again = await emit<ChatMessage>(aliceSocket, 'message:send', {
        conversationId: chat.id,
        clientId,
        body: 'Ready for Sunday?',
      });
      if (!first.ok || !again.ok) throw new Error('send failed');
      expect(first.data).toMatchObject({ body: 'Ready for Sunday?', type: 'TEXT', clientId });
      expect(again.data.id).toBe(first.data.id);
      await waitFor(() => received.length === 1);
      await sleep(200);
      expect(received).toHaveLength(1);
      expect(await prisma().message.count({ where: { conversationId: chat.id, clientId } })).toBe(
        1,
      );

      // Bob's other device, with the chat list open rather than the chat, hears about it too.
      const bobPhone = await socketFor('bob');
      const listUpdates = collect(bobPhone, 'message:new');
      await send('alice', chat.id, { body: 'Reply when you can' }).expect(201);
      await waitFor(() => listUpdates.length === 1 && received.length === 2);
      await sleep(150);
      expect(received).toHaveLength(2);

      // Bob was looking at the chat, so no notification was needed.
      expect((await notifications('bob')).some((n) => n.type === 'NEW_MESSAGE')).toBe(false);
      const bobView = dataOf(
        ConversationSchema,
        await http().get(`/api/v1/conversations/${chat.id}`).set(as('bob')).expect(200),
      );
      expect(bobView.unreadCount).toBe(2);
      const latest = bobView.lastMessage;
      if (!latest) throw new Error('no last message');

      const read = await emit(bobSocket, 'message:read', {
        conversationId: chat.id,
        messageId: latest.id,
      });
      expect(read.ok).toBe(true);
      await waitFor(() => reads.length === 1);
      expect(reads[0]).toMatchObject({ userId: ids.bob, lastReadAt: latest.createdAt });
      const aliceView = dataOf(
        ConversationSchema,
        await http().get(`/api/v1/conversations/${chat.id}`).set(as('alice')).expect(200),
      );
      expect(aliceView.readStates).toContainEqual({
        userId: ids.bob,
        lastReadAt: latest.createdAt,
      });
      expect(
        dataOf(
          ConversationSchema,
          await http().get(`/api/v1/conversations/${chat.id}`).set(as('bob')).expect(200),
        ).unreadCount,
      ).toBe(0);
    });

    it('notifies someone away from the chat once per chat, and pushes it', async () => {
      await http()
        .post('/api/v1/me/push-tokens')
        .set(as('bob'))
        .send({ token: 'ExponentPushToken[not a token]', platform: 'IOS' })
        .expect(400);
      const token = `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`;
      await http()
        .post('/api/v1/me/push-tokens')
        .set(as('bob'))
        .send({ token, platform: 'ANDROID' })
        .expect(204);
      await send('alice', chat.id, { body: 'Meet at 6' }).expect(201);
      await send('alice', chat.id, { body: 'Bring a rain jacket' }).expect(201);
      const unread = (await notifications('bob')).filter(
        (n) => n.type === 'NEW_MESSAGE' && n.readAt === null,
      );
      expect(unread).toHaveLength(1);
      // The badge counts chat messages once, through the chat list.
      const counts = await http().get('/api/v1/me/notifications/unread-count').set(as('bob'));
      const chatUnread = await http().get('/api/v1/me/conversations/unread-count').set(as('bob'));
      // Only Carol's follow; the two messages are not counted again.
      expect((counts.body as { data: { count: number } }).data.count).toBe(1);
      expect((chatUnread.body as { data: { count: number } }).data.count).toBe(2);
      expect(unread[0]).toMatchObject({
        title: `${prefix}_alice`,
        body: 'Bring a rain jacket',
        data: { conversationId: chat.id },
      });
      const outbox = app.get<DevPushSender>(PUSH_SENDER).outbox;
      await waitFor(
        () => outbox.some((p) => p.to === token && p.body === 'Bring a rain jacket'),
        6_000,
      );
      expect(outbox.find((p) => p.body === 'Bring a rain jacket')?.data).toMatchObject({
        conversationId: chat.id,
      });

      // Muted chats don't notify.
      await http()
        .post(`/api/v1/conversations/${chat.id}/mute`)
        .set(as('bob'))
        .send({ muted: true })
        .expect(200);
      await http().post('/api/v1/me/notifications/read-all').set(as('bob')).expect(200);
      await send('alice', chat.id, { body: 'Are you there?' }).expect(201);
      expect((await notifications('bob')).filter((n) => n.readAt === null)).toHaveLength(0);
      await http().post('/api/v1/me/push-tokens/remove').set(as('bob')).send({ token }).expect(204);
    });

    it('pages history newest first', async () => {
      for (let i = 1; i <= 5; i += 1) await send('bob', chat.id, { body: `page ${i}` }).expect(201);
      const first = MessagePage.parse(
        (
          await http()
            .get(`/api/v1/conversations/${chat.id}/messages?limit=2`)
            .set(as('alice'))
            .expect(200)
        ).body,
      );
      expect(first.data.map((m) => m.body)).toEqual(['page 5', 'page 4']);
      expect(first.page.hasMore).toBe(true);
      const second = MessagePage.parse(
        (
          await http()
            .get(
              `/api/v1/conversations/${chat.id}/messages?limit=2&cursor=${first.page.nextCursor}`,
            )
            .set(as('alice'))
            .expect(200)
        ).body,
      );
      expect(second.data.map((m) => m.body)).toEqual(['page 3', 'page 2']);
      const list = await http().get('/api/v1/me/conversations').set(as('alice')).expect(200);
      const mine = z.object({ data: z.array(ConversationSchema) }).parse(list.body).data;
      expect(mine[0]).toMatchObject({ id: chat.id, lastMessage: { body: 'page 5' } });
    });

    it('validates messages', async () => {
      await send('alice', chat.id, { body: 'x'.repeat(2001) }).expect(400);
      await send('alice', chat.id, { body: '   ' }).expect(400);
      await send('alice', chat.id, {}).expect(400);
      // Photos must come from the sender's own chat folder, and need uploads set up.
      await send('alice', chat.id, {
        imageId: `voyago-dev/post-photos/${ids.alice}/${randomUUID()}`,
      }).expect(400);
      await send('alice', chat.id, {
        imageId: `voyago-dev/chat-photos/${ids.alice}/${randomUUID()}`,
      }).expect(503);
      // Direct chats have no announcements.
      await send('alice', chat.id, { body: 'Hear ye', announcement: true }).expect(403);
    });

    it('lets senders delete their own messages for everyone', async () => {
      const bobSocket = await socketFor('bob');
      await join(bobSocket, chat.id);
      const deleted = collect(bobSocket, 'message:deleted');
      const sent = dataOf(
        ChatMessageSchema,
        await send('alice', chat.id, { body: 'oops' }).expect(201),
      );
      await http().post(`/api/v1/messages/${sent.id}/delete`).set(as('bob')).expect(404);
      await http().post(`/api/v1/messages/${sent.id}/delete`).set(as('alice')).expect(204);
      await waitFor(() => deleted.length === 1);
      const page = MessagePage.parse(
        (await http().get(`/api/v1/conversations/${chat.id}/messages?limit=1`).set(as('bob'))).body,
      );
      expect(page.data[0]).toMatchObject({ id: sent.id, deleted: true, body: null });
    });

    it('closes the chat both ways after a block', async () => {
      await http().post(`/api/v1/users/${prefix}_alice/block`).set(as('bob')).expect(204);
      await send('alice', chat.id, { body: 'Hello?' }).expect(403);
      await send('bob', chat.id, { body: 'Bye' }).expect(403);
      const view = dataOf(
        ConversationSchema,
        await http().get(`/api/v1/conversations/${chat.id}`).set(as('alice')).expect(200),
      );
      expect(view.canSend).toBe(false);
      await openDirect('dave', 'bob').expect(200);
      await http().delete(`/api/v1/users/${prefix}_alice/block`).set(as('bob')).expect(204);
    });

    it('keeps chats private to their members', async () => {
      await http().get(`/api/v1/conversations/${chat.id}`).set(as('carol')).expect(404);
      await http().get(`/api/v1/conversations/${chat.id}/messages`).set(as('carol')).expect(404);
      await send('carol', chat.id, { body: 'Let me in' }).expect(404);
      const carolSocket = await socketFor('carol');
      const ack = await emit(carolSocket, 'conversation:join', { conversationId: chat.id });
      expect(ack).toMatchObject({ ok: false, error: { status: 404 } });
      // Typing into a chat you haven't joined goes nowhere.
      const bobSocket = await socketFor('bob');
      await join(bobSocket, chat.id);
      const typing = collect(bobSocket, 'typing:update');
      carolSocket.emit('typing:start', { conversationId: chat.id });
      await sleep(200);
      expect(typing).toHaveLength(0);
    });
  });

  describe('trip chats', () => {
    let tripId: string;
    let chat: Conversation;

    beforeAll(async () => {
      tripId = await createTrip('alice');
      for (const name of ['bob', 'dave', 'erin'] as const) await addToTrip(tripId, name);
    });

    it('is open to the people on the trip only', async () => {
      chat = dataOf(
        ConversationSchema,
        await http().post(`/api/v1/trips/${tripId}/chat`).set(as('bob')).expect(200),
      );
      expect(chat).toMatchObject({ type: 'TRIP_GROUP', tripId, canAnnounce: false });
      const again = dataOf(
        ConversationSchema,
        await http().post(`/api/v1/trips/${tripId}/chat`).set(as('alice')).expect(200),
      );
      expect(again).toMatchObject({ id: chat.id, canAnnounce: true });
      await http().post(`/api/v1/trips/${tripId}/chat`).set(as('carol')).expect(403);
      await http().get(`/api/v1/conversations/${chat.id}`).set(as('carol')).expect(404);
      const trip = dataOf(TripSchema, await http().get(`/api/v1/trips/${tripId}`).set(as('bob')));
      expect(trip.viewer.actions).toContain('chat');
    });

    it('lets organisers announce, and notifies everyone else', async () => {
      await send('bob', chat.id, { body: 'Big news', announcement: true }).expect(403);
      const sent = dataOf(
        ChatMessageSchema,
        await send('alice', chat.id, { body: 'Start moved to 5:30', announcement: true }).expect(
          201,
        ),
      );
      expect(sent.type).toBe('ANNOUNCEMENT');
      const bobNotes = await notifications('bob');
      expect(bobNotes.find((n) => n.data.conversationId === chat.id)).toMatchObject({
        title: 'Announcement in Chat ride to Nandi Hills',
        body: 'Start moved to 5:30',
      });
    });

    it('hides messages between people who blocked each other', async () => {
      await http().post(`/api/v1/users/${prefix}_dave/block`).set(as('erin')).expect(204);
      const erinSocket = await socketFor('erin');
      const bobSocket = await socketFor('bob');
      await join(erinSocket, chat.id);
      await join(bobSocket, chat.id);
      const erinSees = collect(erinSocket, 'message:new');
      const bobSees = collect(bobSocket, 'message:new');
      await send('dave', chat.id, { body: 'From Dave' }).expect(201);
      await waitFor(() => bobSees.length === 1);
      await sleep(200);
      expect(erinSees).toHaveLength(0);
      const history = MessagePage.parse(
        (await http().get(`/api/v1/conversations/${chat.id}/messages`).set(as('erin'))).body,
      );
      expect(history.data.map((m) => m.body)).not.toContain('From Dave');
      expect((await notifications('erin')).some((n) => n.body === 'From Dave')).toBe(false);
      await http().delete(`/api/v1/users/${prefix}_dave/block`).set(as('erin')).expect(204);
    });

    it('cuts off people who leave or are removed, at once', async () => {
      const bobSocket = await socketFor('bob');
      await join(bobSocket, chat.id);
      const bobSees = collect(bobSocket, 'message:new');
      await http()
        .post(`/api/v1/trips/${tripId}/participants/${ids.bob}/remove`)
        .set(as('alice'))
        .send({})
        .expect(204);
      await send('alice', chat.id, { body: 'After Bob left' }).expect(201);
      await sleep(300);
      expect(bobSees.map((m) => m.body)).not.toContain('After Bob left');
      await http().get(`/api/v1/conversations/${chat.id}/messages`).set(as('bob')).expect(404);
      await send('bob', chat.id, { body: 'Still here?' }).expect(404);
    });

    it('rate-limits sending', async () => {
      // Stay inside one minute window so the count is not reset halfway.
      const secondInMinute = new Date().getSeconds();
      if (secondInMinute > 50) await sleep((61 - secondInMinute) * 1000);
      const statuses: number[] = [];
      for (let i = 0; i <= RATE_LIMIT; i += 1) {
        statuses.push((await send('dave', chat.id, { body: `burst ${i}` })).status);
      }
      expect(statuses.filter((s) => s === 201).length).toBeLessThanOrEqual(RATE_LIMIT);
      expect(statuses.at(-1)).toBe(429);
    }, 20_000);
  });

  describe('community chats', () => {
    it('is open to active members only', async () => {
      const slug = `${prefix.replace('_', '-')}-club`;
      await http()
        .post('/api/v1/communities')
        .set(as('frank'))
        .send({ name: 'Chat club', slug, category: 'RIDING_CLUB' })
        .expect(201);
      await http().post(`/api/v1/communities/${slug}/chat`).set(as('gina')).expect(403);
      await http().post(`/api/v1/communities/${slug}/join`).set(as('gina')).send({}).expect(200);
      const chat = dataOf(
        ConversationSchema,
        await http().post(`/api/v1/communities/${slug}/chat`).set(as('gina')).expect(200),
      );
      expect(chat).toMatchObject({ type: 'COMMUNITY', communitySlug: slug, canAnnounce: false });
      await send('gina', chat.id, { body: 'Hi all' }).expect(201);
      // Ordinary community messages don't notify everyone; announcements do.
      expect((await notifications('frank')).some((n) => n.type === 'NEW_MESSAGE')).toBe(false);
      await send('frank', chat.id, { body: 'Ride on Sunday', announcement: true }).expect(201);
      expect(
        (await notifications('gina')).some((n) => n.title === 'Announcement in Chat club'),
      ).toBe(true);
      await http().post(`/api/v1/communities/${slug}/leave`).set(as('gina')).send({}).expect(200);
      await http().get(`/api/v1/conversations/${chat.id}`).set(as('gina')).expect(404);
      await prisma().community.deleteMany({ where: { slug } });
    });
  });
});
