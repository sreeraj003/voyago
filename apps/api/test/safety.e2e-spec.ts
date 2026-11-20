import 'reflect-metadata';
import 'dotenv/config';
import { type INestApplication } from '@nestjs/common';
import {
  type AuthTokens,
  type ClientToServerEvents,
  EmergencyContactSchema,
  LocationSessionSchema,
  NotificationSchema,
  REALTIME_PATH,
  type ServerToClientEvents,
  type SocketAck,
  SosResultSchema,
  SosAlertSchema,
  TripSafetySchema,
  TripSchema,
} from '@voyago/shared';
import { randomUUID } from 'node:crypto';
import { type AddressInfo, type Server } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { z } from 'zod';
import { PrismaService } from '../src/database/prisma.service.js';
import { RedisService } from '../src/redis/redis.service.js';
import { SafetyService } from '../src/safety/safety.service.js';
import { bearer, login, outboxes, registerAndLogin, startAuthApp } from './support/auth-helpers.js';

/** Live location, check-ins, SOS and emergency contacts, against the real database and Redis. */
const prefix = `sf_${randomUUID().slice(0, 6)}`;
const dataOf = <T>(schema: z.ZodType<T>, res: { body: unknown }) =>
  schema.parse((res.body as { data: unknown }).data);
const Accepted = z.object({ accepted: z.boolean() });
const NotificationPage = z.object({ data: z.array(NotificationSchema) });

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const NAMES = ['alice', 'bob', 'carol', 'dave'] as const;
type Name = (typeof NAMES)[number];
const HOUR = 3_600_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('safety (e2e)', () => {
  let app: INestApplication<App>;
  let baseUrl: string;
  let tripId: string;
  const tokens = {} as Record<Name, AuthTokens>;
  const ids = {} as Record<Name, string>;
  const sockets: Client[] = [];
  const http = () => request(app.getHttpServer());
  const prisma = () => app.get(PrismaService);
  const redis = () => app.get(RedisService).client;
  const as = (name: Name) => ({ authorization: bearer(tokens[name]) });

  const socketFor = async (name: Name): Promise<Client> => {
    const socket: Client = connect(baseUrl, {
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
  const collect = <E extends keyof ServerToClientEvents>(socket: Client, event: E) => {
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

  const state = async (name: Name) =>
    dataOf(
      TripSafetySchema,
      await http().get(`/api/v1/trips/${tripId}/safety`).set(as(name)).expect(200),
    );
  const share = (name: Name, body: object = { durationMinutes: 60, consent: true }) =>
    http().post(`/api/v1/trips/${tripId}/location/share`).set(as(name)).send(body);
  /** One reading; clears the per-member rate limit first unless told not to. */
  const sendPoint = (name: Name, at = Date.now(), extra: object = {}, resetRate = true) => ({
    expect: async (status: number) => {
      if (resetRate) await redis().del(`loc:rate:${ids[name]}`);
      return http()
        .post(`/api/v1/trips/${tripId}/location`)
        .set(as(name))
        .send({
          latitude: 13.2,
          longitude: 77.6,
          accuracyMeters: 12,
          recordedAt: new Date(at).toISOString(),
          ...extra,
        })
        .expect(status);
    },
  });
  const notifications = async (name: Name) =>
    NotificationPage.parse(
      (await http().get('/api/v1/me/notifications?limit=50').set(as(name)).expect(200)).body,
    ).data;
  const setDeparture = (at: number) =>
    prisma().trip.update({ where: { id: tripId }, data: { departureAt: new Date(at) } });

  beforeAll(async () => {
    app = await startAuthApp({ PUSH_PROVIDER: 'dev' });
    await app.listen(0);
    const { port } = (app.getHttpServer() as unknown as Server).address() as AddressInfo;
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
    const created = await http()
      .post('/api/v1/trips')
      .set(as('alice'))
      .send({
        mode: 'RIDE',
        activityType: 'MOTORCYCLE_RIDE',
        title: 'Safety ride to Nandi Hills',
        origin: { name: 'Hebbal', point: { latitude: 13.0358, longitude: 77.597 } },
        destination: { name: 'Nandi Hills', point: { latitude: 13.3702, longitude: 77.6835 } },
        departureAt: new Date(Date.now() + 72 * HOUR).toISOString(),
        maxParticipants: 8,
        visibility: 'PUBLIC',
      })
      .expect(201);
    tripId = dataOf(TripSchema, created).id;
    await http().post(`/api/v1/trips/${tripId}/publish`).set(as('alice')).expect(200);
    for (const name of ['bob', 'carol'] as const) {
      await prisma().tripParticipant.create({ data: { tripId, userId: ids[name] } });
    }
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.disconnect();
  });

  afterAll(async () => {
    const userIds = Object.values(ids);
    await prisma().trip.deleteMany({ where: { organiserId: { in: userIds } } });
    await prisma().user.deleteMany({ where: { id: { in: userIds } } });
    for (const id of userIds) await redis().del(`loc:${tripId}:${id}`, `loc:rate:${id}`);
    await app?.close();
  });

  describe('before the trip is live', () => {
    it('keeps sharing closed and hides the safety action until two hours before departure', async () => {
      await share('bob').expect(409);
      const trip = dataOf(
        TripSchema,
        await http().get(`/api/v1/trips/${tripId}`).set(as('bob')).expect(200),
      );
      expect(trip.viewer.actions).not.toContain('safety');
      expect((await state('bob')).live).toBe(false);

      await setDeparture(Date.now() + HOUR);
      const live = dataOf(
        TripSchema,
        await http().get(`/api/v1/trips/${tripId}`).set(as('bob')).expect(200),
      );
      expect(live.viewer.actions).toContain('safety');
      expect((await state('bob')).live).toBe(true);
    });
  });

  describe('sharing', () => {
    it('needs explicit consent and a duration of at most a day', async () => {
      await share('bob', { durationMinutes: 60 }).expect(400);
      await share('bob', { durationMinutes: 60, consent: false }).expect(400);
      await share('bob', { durationMinutes: 24 * 60 + 1, consent: true }).expect(400);
      await sendPoint('bob').expect(409);
    });

    it('is only for members of the trip', async () => {
      await http().get(`/api/v1/trips/${tripId}/safety`).set(as('dave')).expect(404);
      await share('dave').expect(404);
      await sendPoint('dave').expect(404);
      await http().post(`/api/v1/trips/${tripId}/location/stop`).set(as('dave')).expect(404);
      await http()
        .post(`/api/v1/trips/${tripId}/check-ins`)
        .set(as('dave'))
        .send({ kind: 'ALL_GOOD' })
        .expect(404);
      await http()
        .post(`/api/v1/trips/${tripId}/sos`)
        .set(as('dave'))
        .send({ confirm: true })
        .expect(404);
    });

    it('shares readings with the other members, in the app and over the socket', async () => {
      const aliceSocket = await socketFor('alice');
      const updates = collect(aliceSocket, 'location:update');
      const session = dataOf(LocationSessionSchema, await share('bob').expect(201));
      expect(session.status).toBe('ACTIVE');
      const expiresIn = new Date(session.expiresAt).getTime() - Date.now();
      expect(expiresIn).toBeGreaterThan(59 * 60_000);
      expect(expiresIn).toBeLessThanOrEqual(60 * 60_000);

      expect(dataOf(Accepted, await sendPoint('bob').expect(200)).accepted).toBe(true);
      await waitFor(() => updates.length === 1);
      expect(updates[0]).toMatchObject({
        tripId,
        user: { id: ids.bob, username: `${prefix}_bob` },
        latitude: 13.2,
        longitude: 77.6,
      });

      const seen = await state('alice');
      expect(seen.sharers).toHaveLength(1);
      expect(seen.sharers[0]).toMatchObject({
        user: { id: ids.bob },
        location: { latitude: 13.2, longitude: 77.6, accuracyMeters: 12 },
      });
      expect((await state('bob')).mySession?.id).toBe(session.id);
      // The point lives only in Redis, and only until the session expires.
      const ttl = await redis().pttl(`loc:${tripId}:${ids.bob}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60 * 60_000);
    });

    it('rate limits readings and ignores stale or out-of-order ones', async () => {
      const now = Date.now();
      expect(dataOf(Accepted, await sendPoint('bob', now).expect(200)).accepted).toBe(true);
      await sendPoint('bob', now + 1, {}, false).expect(429);
      // Older than the last reading: ignored, so a reconnecting phone can't move someone back.
      expect(dataOf(Accepted, await sendPoint('bob', now - 1_000).expect(200)).accepted).toBe(
        false,
      );
      // More than two minutes old: ignored.
      expect(
        dataOf(Accepted, await sendPoint('bob', Date.now() - 5 * 60_000).expect(200)).accepted,
      ).toBe(false);
      // In the future: refused.
      await sendPoint('bob', Date.now() + 10 * 60_000).expect(400);
      await sendPoint('bob', Date.now(), { latitude: 91 }).expect(400);
      const point = (await state('alice')).sharers[0]?.location;
      expect(point?.recordedAt).toBe(new Date(now).toISOString());
    });

    it('accepts readings over the socket with the same checks', async () => {
      const socket = await socketFor('bob');
      const emit = (payload: object) =>
        new Promise<SocketAck<{ accepted: boolean }>>((resolve) => {
          (socket.emit as (e: string, p: object, ack: (r: never) => void) => void)(
            'location:update',
            payload,
            resolve,
          );
        });
      await redis().del(`loc:rate:${ids.bob}`);
      const reading = { latitude: 13.25, longitude: 77.61, recordedAt: new Date().toISOString() };
      expect(await emit({ tripId, ...reading })).toEqual({ ok: true, data: { accepted: true } });
      expect(await emit({ tripId, ...reading })).toMatchObject({
        ok: false,
        error: { status: 429 },
      });
      expect(await emit({ tripId, latitude: 'x' })).toMatchObject({
        ok: false,
        error: { status: 400 },
      });
      // Dave is not on the trip.
      const daveSocket = await socketFor('dave');
      const ack = await new Promise<SocketAck<unknown>>((resolve) => {
        (daveSocket.emit as (e: string, p: object, ack: (r: never) => void) => void)(
          'location:update',
          { tripId, ...reading },
          resolve,
        );
      });
      expect(ack).toMatchObject({ ok: false, error: { status: 404 } });
    });

    it('hides members from each other both ways when one blocks the other', async () => {
      const carolSocket = await socketFor('carol');
      const carolUpdates = collect(carolSocket, 'location:update');
      const aliceSocket = await socketFor('alice');
      const aliceUpdates = collect(aliceSocket, 'location:update');
      await http().post(`/api/v1/users/${prefix}_bob/block`).set(as('carol')).expect(204);

      await sendPoint('bob').expect(200);
      await waitFor(() => aliceUpdates.length === 1);
      await sleep(150);
      expect(carolUpdates).toHaveLength(0);
      expect((await state('carol')).sharers).toHaveLength(0);

      await share('carol').expect(201);
      await sendPoint('carol').expect(200);
      expect((await state('bob')).sharers.map((s) => s.user.id)).not.toContain(ids.carol);
      expect((await state('alice')).sharers.map((s) => s.user.id)).toContain(ids.carol);

      await http().delete(`/api/v1/users/${prefix}_bob/block`).set(as('carol')).expect(204);
      expect((await state('carol')).sharers.map((s) => s.user.id)).toContain(ids.bob);
      await http().post(`/api/v1/trips/${tripId}/location/stop`).set(as('carol')).expect(204);
    });

    it('stops at once: the point is deleted and members are told', async () => {
      const aliceSocket = await socketFor('alice');
      const stopped = collect(aliceSocket, 'location:stopped');
      await http().post(`/api/v1/trips/${tripId}/location/stop`).set(as('bob')).expect(204);
      await waitFor(() => stopped.length === 1);
      expect(stopped[0]).toEqual({ tripId, userId: ids.bob });
      expect(await redis().exists(`loc:${tripId}:${ids.bob}`)).toBe(0);
      expect((await state('alice')).sharers).toHaveLength(0);
      expect((await state('bob')).mySession).toBeNull();
      await sendPoint('bob').expect(409);
      const session = await prisma().locationSession.findFirstOrThrow({
        where: { tripId, userId: ids.bob },
        orderBy: { startedAt: 'desc' },
      });
      expect(session).toMatchObject({ status: 'ENDED', endReason: 'stopped' });
      // Stopping when nothing is shared is fine.
      await http().post(`/api/v1/trips/${tripId}/location/stop`).set(as('bob')).expect(204);
    });

    it('expires on time', async () => {
      const session = dataOf(LocationSessionSchema, await share('bob').expect(201));
      await sendPoint('bob').expect(200);
      await prisma().locationSession.update({
        where: { id: session.id },
        // Started an hour ago for an hour: it has just run out.
        data: {
          startedAt: new Date(Date.now() - HOUR - 1_000),
          expiresAt: new Date(Date.now() - 1_000),
        },
      });
      await sendPoint('bob').expect(409);
      expect((await state('alice')).sharers).toHaveLength(0);
      expect(
        await prisma().locationSession.findUniqueOrThrow({ where: { id: session.id } }),
      ).toMatchObject({ status: 'EXPIRED', endReason: 'expired' });
      expect(await redis().exists(`loc:${tripId}:${ids.bob}`)).toBe(0);
    });

    it('ends when the member leaves the trip or the trip ends', async () => {
      await share('bob').expect(201);
      await sendPoint('bob').expect(200);
      await prisma().tripParticipant.update({
        where: { tripId_userId: { tripId, userId: ids.bob } },
        data: { status: 'LEFT', leftAt: new Date() },
      });
      // Reads drop them at once; the sweep ends the session.
      expect((await state('alice')).sharers).toHaveLength(0);
      await sendPoint('bob').expect(404);
      await app.get(SafetyService).sweep();
      expect(
        await prisma().locationSession.findFirstOrThrow({
          where: { tripId, userId: ids.bob },
          orderBy: { startedAt: 'desc' },
        }),
      ).toMatchObject({ status: 'ENDED', endReason: 'left_trip' });
      await prisma().tripParticipant.update({
        where: { tripId_userId: { tripId, userId: ids.bob } },
        data: { status: 'ACTIVE', leftAt: null },
      });

      await share('bob').expect(201);
      await setDeparture(Date.now() - 30 * HOUR); // PUBLISHED and long past: not live.
      await sendPoint('bob').expect(409);
      expect(
        await prisma().locationSession.findFirstOrThrow({
          where: { tripId, userId: ids.bob },
          orderBy: { startedAt: 'desc' },
        }),
      ).toMatchObject({ status: 'ENDED', endReason: 'trip_ended' });
      await setDeparture(Date.now() + HOUR);
    });
  });

  describe('check-ins', () => {
    it('records check-ins, and arriving safely stops sharing', async () => {
      await http()
        .post(`/api/v1/trips/${tripId}/check-ins`)
        .set(as('bob'))
        .send({ kind: 'AT_START', note: 'Fuelled up' })
        .expect(201);
      await share('bob').expect(201);
      await http()
        .post(`/api/v1/trips/${tripId}/check-ins`)
        .set(as('bob'))
        .send({ kind: 'NOT_A_KIND' })
        .expect(400);
      await http()
        .post(`/api/v1/trips/${tripId}/check-ins`)
        .set(as('bob'))
        .send({ kind: 'ARRIVED_SAFELY' })
        .expect(201);
      const seen = await state('alice');
      expect(seen.checkIns.map((c) => c.kind)).toEqual(['ARRIVED_SAFELY', 'AT_START']);
      expect(seen.checkIns[1]).toMatchObject({ note: 'Fuelled up', user: { id: ids.bob } });
      expect(seen.sharers).toHaveLength(0);
    });
  });

  describe('emergency contacts', () => {
    it('keeps up to three private contacts', async () => {
      await http()
        .post('/api/v1/me/emergency-contacts')
        .set(as('bob'))
        .send({ name: 'Mum', phone: '12345' })
        .expect(400);
      const added = [];
      for (const [name, phone] of [
        ['Mum', '+91 98450 00001'],
        ['Ravi', '+919845000002'],
        ['Sam', '+919845000003'],
      ] as const) {
        added.push(
          dataOf(
            EmergencyContactSchema,
            await http()
              .post('/api/v1/me/emergency-contacts')
              .set(as('bob'))
              .send({ name, phone, relationship: name === 'Mum' ? 'Mother' : undefined })
              .expect(201),
          ),
        );
      }
      expect(added[0]).toMatchObject({ phone: '+919845000001', relationship: 'Mother' });
      await http()
        .post('/api/v1/me/emergency-contacts')
        .set(as('bob'))
        .send({ name: 'Extra', phone: '+919845000004' })
        .expect(409);
      // Someone else can't see or remove them.
      const others = await http().get('/api/v1/me/emergency-contacts').set(as('alice')).expect(200);
      expect((others.body as { data: unknown[] }).data).toHaveLength(0);
      await http()
        .delete(`/api/v1/me/emergency-contacts/${added[2]!.id}`)
        .set(as('alice'))
        .expect(404);
      await http()
        .delete(`/api/v1/me/emergency-contacts/${added[2]!.id}`)
        .set(as('bob'))
        .expect(204);
      await http()
        .post('/api/v1/me/emergency-contacts')
        .set(as('bob'))
        .send({ name: 'Mum again', phone: '+919845000001' })
        .expect(409);
      const mine = await http().get('/api/v1/me/emergency-contacts').set(as('bob')).expect(200);
      expect((mine.body as { data: unknown[] }).data).toHaveLength(2);
    });
  });

  describe('SOS', () => {
    let alertId: string;

    it('needs confirmation', async () => {
      await http().post(`/api/v1/trips/${tripId}/sos`).set(as('bob')).send({}).expect(400);
      await http()
        .post(`/api/v1/trips/${tripId}/sos`)
        .set(as('bob'))
        .send({ confirm: false })
        .expect(400);
    });

    it('notifies members, texts contacts and is audited, without contacting anyone else', async () => {
      const aliceSocket = await socketFor('alice');
      const raised = collect(aliceSocket, 'sos:raised');
      const carolSocket = await socketFor('carol');
      const carolRaised = collect(carolSocket, 'sos:raised');
      // Carol blocked Bob for this test: she isn't told.
      await http().post(`/api/v1/users/${prefix}_bob/block`).set(as('carol')).expect(204);

      const res = await http()
        .post(`/api/v1/trips/${tripId}/sos`)
        .set(as('bob'))
        .send({
          confirm: true,
          message: 'Bike skidded, I am hurt',
          location: { latitude: 13.31, longitude: 77.65, recordedAt: new Date().toISOString() },
        })
        .expect(201);
      const result = dataOf(SosResultSchema, res);
      alertId = result.alert.id;
      expect(result).toMatchObject({
        membersNotified: 1,
        contactsTexted: 2,
        contactsTotal: 2,
        smsAvailable: true,
        emergencyNumber: '112',
        alert: {
          status: 'ACTIVE',
          message: 'Bike skidded, I am hurt',
          location: { latitude: 13.31, longitude: 77.65 },
        },
      });

      const text = outboxes(app).sms.lastMessageTo('+919845000001') ?? '';
      expect(text).toContain('Voyago SOS');
      expect(text).toContain('https://maps.google.com/?q=13.31000,77.65000');
      expect(text).toContain('call 112');
      expect(text).toContain('Voyago does not contact emergency services');

      const forAlice = await notifications('alice');
      expect(forAlice.find((n) => n.type === 'SAFETY_ALERT')).toMatchObject({
        title: `SOS from ${prefix}_bob`,
        data: { tripId, screen: 'safety' },
      });
      expect((await notifications('carol')).some((n) => n.type === 'SAFETY_ALERT')).toBe(false);
      await waitFor(() => raised.length === 1);
      await sleep(150);
      expect(carolRaised).toHaveLength(0);
      expect((await state('alice')).alerts[0]).toMatchObject({ id: alertId, status: 'ACTIVE' });
      expect((await state('carol')).alerts).toHaveLength(0);

      const audit = await prisma().auditLog.findFirstOrThrow({
        where: { action: 'sos.raise', entityId: tripId },
      });
      expect(audit).toMatchObject({ actorId: ids.bob, actorType: 'USER' });
      expect(audit.metadata).toEqual({
        alertId,
        hasLocation: true,
        membersNotified: 1,
        contacts: 2,
      });
      await http().delete(`/api/v1/users/${prefix}_bob/block`).set(as('carol')).expect(204);
    });

    it('allows one active SOS per member and trip', async () => {
      await http()
        .post(`/api/v1/trips/${tripId}/sos`)
        .set(as('bob'))
        .send({ confirm: true })
        .expect(409);
    });

    it('is closed by the member or the organiser, and the location is cleared', async () => {
      const resolve = (name: Name, outcome: string) =>
        http().post(`/api/v1/sos/${alertId}/resolve`).set(as(name)).send({ outcome });
      await resolve('dave', 'SAFE').expect(404);
      await resolve('carol', 'SAFE').expect(403);
      await resolve('alice', 'FALSE_ALARM').expect(403);
      const bobSocket = await socketFor('bob');
      const resolved = collect(bobSocket, 'sos:resolved');
      const closed = dataOf(SosAlertSchema, await resolve('alice', 'SAFE').expect(200));
      expect(closed).toMatchObject({ status: 'RESOLVED', location: null });
      await resolve('bob', 'SAFE').expect(409);
      await waitFor(() => resolved.length === 1);

      const row = await prisma().sosAlert.findUniqueOrThrow({ where: { id: alertId } });
      expect(row).toMatchObject({ latitude: null, longitude: null, resolvedById: ids.alice });
      expect(outboxes(app).sms.lastMessageTo('+919845000001')).toContain('marked safe');
      expect((await notifications('bob')).some((n) => n.title.includes('is marked safe'))).toBe(
        true,
      );
      expect(
        await prisma().auditLog.count({ where: { action: 'sos.resolve', entityId: tripId } }),
      ).toBe(1);
    });

    it('uses the last shared point when the phone sends none, and limits alerts per hour', async () => {
      await share('bob').expect(201);
      await sendPoint('bob', Date.now(), { latitude: 13.4, longitude: 77.7 }).expect(200);
      const second = dataOf(
        SosResultSchema,
        await http()
          .post(`/api/v1/trips/${tripId}/sos`)
          .set(as('bob'))
          .send({ confirm: true })
          .expect(201),
      );
      expect(second.alert.location).toMatchObject({ latitude: 13.4, longitude: 77.7 });
      await http()
        .post(`/api/v1/sos/${second.alert.id}/resolve`)
        .set(as('bob'))
        .send({ outcome: 'FALSE_ALARM' })
        .expect(200);
      await http()
        .post(`/api/v1/trips/${tripId}/sos`)
        .set(as('bob'))
        .send({ confirm: true })
        .expect(201)
        .then((res) =>
          http()
            .post(`/api/v1/sos/${dataOf(SosResultSchema, res).alert.id}/resolve`)
            .set(as('bob'))
            .send({ outcome: 'SAFE' })
            .expect(200),
        );
      const limited = await http()
        .post(`/api/v1/trips/${tripId}/sos`)
        .set(as('bob'))
        .send({ confirm: true })
        .expect(429);
      expect(JSON.stringify(limited.body)).toContain('Call 112');
    });

    it('stays open for a day after the trip is completed, then closes', async () => {
      await prisma().trip.update({
        where: { id: tripId },
        data: {
          status: 'COMPLETED',
          startedAt: new Date(Date.now() - 3 * HOUR),
          completedAt: new Date(Date.now() - HOUR),
        },
      });
      await prisma().tripParticipant.updateMany({
        where: { tripId },
        data: { status: 'COMPLETED' },
      });
      await http()
        .post(`/api/v1/trips/${tripId}/check-ins`)
        .set(as('carol'))
        .send({ kind: 'ARRIVED_SAFELY' })
        .expect(201);
      // Sharing is for the trip itself only.
      await share('carol').expect(409);
      await prisma().trip.update({
        where: { id: tripId },
        data: { completedAt: new Date(Date.now() - 25 * HOUR) },
      });
      await http()
        .post(`/api/v1/trips/${tripId}/check-ins`)
        .set(as('carol'))
        .send({ kind: 'ALL_GOOD' })
        .expect(409);
      await http()
        .post(`/api/v1/trips/${tripId}/sos`)
        .set(as('carol'))
        .send({ confirm: true })
        .expect(409);
    });

    it('clears SOS locations after a day', async () => {
      const active = await prisma().sosAlert.create({
        data: {
          tripId,
          userId: ids.carol,
          latitude: 13,
          longitude: 77,
          locationRecordedAt: new Date(Date.now() - 25 * HOUR),
          createdAt: new Date(Date.now() - 25 * HOUR),
        },
      });
      await app.get(SafetyService).sweep();
      expect(await prisma().sosAlert.findUniqueOrThrow({ where: { id: active.id } })).toMatchObject(
        { status: 'ACTIVE', latitude: null, longitude: null, locationRecordedAt: null },
      );
    });
  });
});
