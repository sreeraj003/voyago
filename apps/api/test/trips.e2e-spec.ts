import 'reflect-metadata';
import 'dotenv/config';
import { type INestApplication } from '@nestjs/common';
import {
  ApiErrorSchema,
  type AuthTokens,
  type CreateTripInput,
  type PageResponse,
  type Trip,
  TripSchema,
} from '@voyago/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { TripExpiryService } from '../src/trips/trip-expiry.service.js';
import { bearer, login, registerAndLogin, startAuthApp } from './support/auth-helpers.js';

/** Trip creation and lifecycle against the real database. Rows are deleted afterwards. */
const tripOf = (res: { body: unknown }) => TripSchema.parse((res.body as { data: unknown }).data);
const prefix = `tr_${randomUUID().slice(0, 6)}`;
const HOUR = 3_600_000;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

const rideBody = (overrides: Partial<CreateTripInput> = {}): CreateTripInput => ({
  mode: 'RIDE',
  activityType: 'MOTORCYCLE_RIDE',
  title: 'Sunrise ride to Nandi Hills',
  description: 'Easy pace, breakfast at the top.',
  origin: { name: 'Hebbal flyover', point: { latitude: 13.035812, longitude: 77.597034 } },
  destination: { name: 'Nandi Hills', point: { latitude: 13.3702, longitude: 77.6835 } },
  stops: [
    {
      name: 'Devanahalli fort',
      point: { latitude: 13.2437, longitude: 77.7172 },
      plannedArrivalAt: inHours(73),
    },
  ],
  departureAt: inHours(72),
  returnAt: inHours(78),
  minParticipants: 2,
  maxParticipants: 8,
  estimatedBudgetPaise: 50_000,
  estimatedDistanceKm: 120,
  estimatedDurationMinutes: 360,
  minEngineCc: 150,
  visibility: 'PUBLIC',
  ...overrides,
});

describe('trips (e2e)', () => {
  let app: INestApplication<App>;
  let alice: AuthTokens;
  let bob: AuthTokens;
  let carol: AuthTokens;
  const http = () => request(app.getHttpServer());
  const prisma = () => app.get(PrismaService);

  const create = async (tokens: AuthTokens, body: CreateTripInput = rideBody()) => {
    const res = await http().post('/api/v1/trips').set('authorization', bearer(tokens)).send(body);
    expect(res.status).toBe(201);
    return tripOf(res);
  };
  const action = (tokens: AuthTokens, id: string, verb: string, body?: object) =>
    http().post(`/api/v1/trips/${id}/${verb}`).set('authorization', bearer(tokens)).send(body);
  const patch = (tokens: AuthTokens, id: string, body: object) =>
    http().patch(`/api/v1/trips/${id}`).set('authorization', bearer(tokens)).send(body);
  const get = (tokens: AuthTokens, id: string) =>
    http().get(`/api/v1/trips/${id}`).set('authorization', bearer(tokens));
  const userId = async (name: string) =>
    (await prisma().user.findUniqueOrThrow({ where: { username: `${prefix}_${name}` } })).id;
  const addParticipant = async (tripId: string, name: string) =>
    prisma().tripParticipant.create({ data: { tripId, userId: await userId(name) } });

  beforeAll(async () => {
    app = await startAuthApp();
    for (const name of ['alice', 'bob', 'carol', 'dave']) {
      await registerAndLogin(app, {
        email: `${prefix}_${name}@example.test`,
        username: `${prefix}_${name}`,
      });
    }
    alice = await login(app, `${prefix}_alice@example.test`);
    bob = await login(app, `${prefix}_bob@example.test`);
    carol = await login(app, `${prefix}_carol@example.test`);
  });

  afterAll(async () => {
    const users = await prisma().user.findMany({
      where: { username: { startsWith: prefix } },
      select: { id: true },
    });
    const ids = users.map((u) => u.id);
    // Audit rows are append-only by design; deleting the users only clears their actor id.
    await prisma().trip.deleteMany({ where: { organiserId: { in: ids } } });
    await prisma().user.deleteMany({ where: { id: { in: ids } } });
    await app?.close();
  });

  describe('create and view', () => {
    it('creates a free community draft with the organiser as first participant', async () => {
      const trip = await create(alice, {
        ...rideBody(),
        // Clients cannot choose these.
        ...({
          tripType: 'COMMERCIAL_PAID',
          status: 'PUBLISHED',
          organiserId: randomUUID(),
        } as object),
      });
      expect(trip).toMatchObject({
        status: 'DRAFT',
        tripType: 'COMMUNITY_FREE',
        participantCount: 1,
        estimatesSource: 'ORGANISER',
        currency: 'INR',
        viewer: {
          isOrganiser: true,
          isParticipant: true,
          actions: ['edit', 'publish', 'delete', 'cancel'],
        },
      });
      expect(trip.origin).toEqual({
        name: 'Hebbal flyover',
        point: { latitude: 13.035812, longitude: 77.597034 },
        approximate: false,
      });
      expect(trip.stops).toHaveLength(1);
      expect(trip.stops[0]).toMatchObject({ position: 1, name: 'Devanahalli fort' });
    });

    it('rejects invalid dates, capacity, activity and coordinates', async () => {
      const cases: [Partial<CreateTripInput>, string][] = [
        [{ departureAt: inHours(-1), returnAt: null, stops: [] }, 'departureAt'],
        [{ returnAt: inHours(10) }, 'returnAt'],
        [{ returnAt: inHours(72 + 24 * 61) }, 'returnAt'],
        [{ minParticipants: 9, maxParticipants: 8 }, 'minParticipants'],
        [{ maxParticipants: 1 }, 'maxParticipants'],
        [{ maxParticipants: 501 }, 'maxParticipants'],
        [{ activityType: 'TREK' }, 'activityType'],
        [{ mode: 'TRAVEL', activityType: 'TREK' }, 'minEngineCc'],
        [
          { destination: { name: 'Nowhere', point: { latitude: 95, longitude: 0 } } },
          'destination.point.latitude',
        ],
        [
          {
            stops: [
              {
                name: 'Early',
                point: { latitude: 13, longitude: 77 },
                plannedArrivalAt: inHours(1),
              },
            ],
          },
          'stops.0.plannedArrivalAt',
        ],
      ];
      for (const [overrides, path] of cases) {
        const res = await http()
          .post('/api/v1/trips')
          .set('authorization', bearer(alice))
          .send(rideBody(overrides));
        expect({ path, status: res.status }).toEqual({ path, status: 400 });
        expect(ApiErrorSchema.parse(res.body).details?.map((d) => d.path)).toContain(path);
      }
    });

    it('hides drafts and private trips, and the exact meeting point from non-participants', async () => {
      const draft = await create(alice);
      await get(bob, draft.id).expect(404);

      const publicTrip = await create(alice);
      await action(alice, publicTrip.id, 'publish').expect(200);
      const seen = tripOf(await get(bob, publicTrip.id).expect(200));
      expect(seen.origin).toEqual({
        name: 'Hebbal flyover',
        point: { latitude: 13.04, longitude: 77.6 },
        approximate: true,
      });
      expect(seen.viewer).toEqual({
        isOrganiser: false,
        isParticipant: false,
        isCoOrganiser: false,
        invitationId: null,
        participantStatus: null,
        joinRequest: null,
        pendingRequestCount: 0,
        actions: ['join'],
      });

      const privateTrip = await create(alice, rideBody({ visibility: 'PRIVATE' }));
      await action(alice, privateTrip.id, 'publish').expect(200);
      await get(bob, privateTrip.id).expect(404);
      await addParticipant(privateTrip.id, 'bob');
      const asParticipant = tripOf(await get(bob, privateTrip.id).expect(200));
      expect(asParticipant.origin.approximate).toBe(false);

      // Blocking hides the trip both ways.
      await prisma().userBlock.create({
        data: { blockerId: await userId('alice'), blockedId: await userId('carol') },
      });
      await get(carol, publicTrip.id).expect(404);
      await get(alice, randomUUID()).expect(404);
      await get(alice, 'nope').expect(400);
    });
  });

  describe('ownership and editing', () => {
    it('lets only the organiser edit, publish or delete', async () => {
      const trip = await create(alice);
      await action(alice, trip.id, 'publish').expect(200);
      await patch(bob, trip.id, { title: 'Hijacked' }).expect(403);
      await action(bob, trip.id, 'cancel', { reason: 'Not mine' }).expect(403);
      await action(bob, trip.id, 'start').expect(403);
      await http().delete(`/api/v1/trips/${trip.id}`).set('authorization', bearer(bob)).expect(403);
    });

    it('edits fields, replaces stops and re-checks rules after merging', async () => {
      const trip = await create(alice);
      const res = await patch(alice, trip.id, {
        title: 'Nandi Hills via Devanahalli',
        stops: [
          { name: 'Stop A', point: { latitude: 13.1, longitude: 77.6 } },
          { name: 'Stop B', point: { latitude: 13.2, longitude: 77.65 } },
        ],
      }).expect(200);
      const updated = tripOf(res);
      expect(updated.title).toBe('Nandi Hills via Devanahalli');
      expect(updated.stops.map((s) => [s.position, s.name])).toEqual([
        [1, 'Stop A'],
        [2, 'Stop B'],
      ]);
      // Merged with the stored maximum of 8.
      await patch(alice, trip.id, { minParticipants: 9 }).expect(400);
      await patch(alice, trip.id, { returnAt: inHours(50) }).expect(400);
      await patch(alice, trip.id, { departureAt: inHours(-2) }).expect(400);
      await patch(alice, trip.id, {}).expect(400);
    });

    it('locks mode after publishing and keeps capacity above current participants', async () => {
      const trip = await create(alice, rideBody({ maxParticipants: 4 }));
      await addParticipant(trip.id, 'bob');
      await addParticipant(trip.id, 'carol');
      await action(alice, trip.id, 'publish').expect(200);
      await patch(alice, trip.id, {
        mode: 'TRAVEL',
        activityType: 'ROAD_TRIP',
        minEngineCc: null,
      }).expect(409);
      const res = await patch(alice, trip.id, { maxParticipants: 2 }).expect(400);
      expect(ApiErrorSchema.parse(res.body).details?.[0]?.message).toContain('3 people');

      // Reaching capacity marks the trip FULL; raising it re-opens it.
      const full = tripOf(await patch(alice, trip.id, { maxParticipants: 3 }).expect(200));
      expect(full.status).toBe('FULL');
      const reopened = tripOf(await patch(alice, trip.id, { maxParticipants: 6 }).expect(200));
      expect(reopened.status).toBe('PUBLISHED');
    });

    it('allows only the description to change after the trip starts', async () => {
      const trip = await create(
        alice,
        rideBody({ departureAt: inHours(1), returnAt: inHours(5), stops: [] }),
      );
      await action(alice, trip.id, 'publish').expect(200);
      const started = tripOf(await action(alice, trip.id, 'start').expect(200));
      expect(started.status).toBe('IN_PROGRESS');
      expect(started.startedAt).not.toBeNull();
      const res = await patch(alice, trip.id, { title: 'Changed', maxParticipants: 20 }).expect(
        409,
      );
      expect(
        ApiErrorSchema.parse(res.body)
          .details?.map((d) => d.path)
          .sort(),
      ).toEqual(['maxParticipants', 'title']);
      await patch(alice, trip.id, { description: 'Running 10 minutes late' }).expect(200);

      const completed = tripOf(await action(alice, trip.id, 'complete').expect(200));
      expect(completed.status).toBe('COMPLETED');
      await patch(alice, trip.id, { description: 'After' }).expect(409);
    });
  });

  describe('lifecycle', () => {
    it('rejects invalid transitions', async () => {
      const trip = await create(alice);
      await action(alice, trip.id, 'complete').expect(409);
      await action(alice, trip.id, 'start').expect(409);
      await action(alice, trip.id, 'publish').expect(200);
      await action(alice, trip.id, 'publish').expect(409);
      // Departure is 72 hours away: too early to start.
      const early = await action(alice, trip.id, 'start').expect(409);
      expect(ApiErrorSchema.parse(early.body).message).toContain('2 hours');
      await http()
        .delete(`/api/v1/trips/${trip.id}`)
        .set('authorization', bearer(alice))
        .expect(409);

      await action(alice, trip.id, 'cancel', {}).expect(400);
      const cancelled = tripOf(
        await action(alice, trip.id, 'cancel', { reason: 'Heavy rain forecast' }).expect(200),
      );
      expect(cancelled).toMatchObject({
        status: 'CANCELLED',
        cancellationReason: 'Heavy rain forecast',
        viewer: { actions: ['chat'] },
      });
      await action(alice, trip.id, 'cancel', { reason: 'Again' }).expect(409);
      await action(alice, trip.id, 'publish').expect(409);
      await patch(alice, trip.id, { title: 'Back on' }).expect(409);
    });

    it('refuses to publish a draft whose departure has passed', async () => {
      const trip = await create(alice);
      await prisma().trip.update({
        where: { id: trip.id },
        data: { departureAt: new Date(Date.now() - HOUR), returnAt: null },
      });
      await prisma().tripStop.deleteMany({ where: { tripId: trip.id } });
      const res = await action(alice, trip.id, 'publish').expect(400);
      expect(ApiErrorSchema.parse(res.body).details?.[0]?.path).toBe('departureAt');
    });

    it('deletes drafts', async () => {
      const trip = await create(alice);
      await http()
        .delete(`/api/v1/trips/${trip.id}`)
        .set('authorization', bearer(alice))
        .expect(204);
      await get(alice, trip.id).expect(404);
    });

    it('expires published trips that never started', async () => {
      const trip = await create(alice);
      await action(alice, trip.id, 'publish').expect(200);
      await prisma().trip.update({
        where: { id: trip.id },
        data: { departureAt: new Date(Date.now() - 25 * HOUR), returnAt: null },
      });
      expect(await app.get(TripExpiryService).expireOverdue()).toBeGreaterThanOrEqual(1);
      const expired = tripOf(await get(alice, trip.id).expect(200));
      expect(expired.status).toBe('EXPIRED');
      await action(alice, trip.id, 'start').expect(409);
    });

    it('lets moderators cancel any trip, with an audit record', async () => {
      const trip = await create(alice);
      await action(alice, trip.id, 'publish').expect(200);
      const daveId = await userId('dave');
      await prisma().user.update({ where: { id: daveId }, data: { role: 'MODERATOR' } });
      const dave = await login(app, `${prefix}_dave@example.test`);
      const res = await action(dave, trip.id, 'cancel', { reason: 'Reported as unsafe' }).expect(
        200,
      );
      expect((res.body as { data: Trip }).data.status).toBe('CANCELLED');
      const audit = await prisma().auditLog.findFirstOrThrow({
        where: { entityId: trip.id, action: 'trip.moderate_cancel' },
      });
      expect(audit).toMatchObject({ actorId: daveId, actorType: 'ADMIN', entityType: 'trip' });
      expect(audit.requestId).toBeTruthy();
    });
  });

  describe('free vs commercial', () => {
    it('never lets community endpoints change a commercial departure', async () => {
      const commercialId = '5eed0000-0000-4000-8000-000000000203';
      const seeded = await prisma().trip.findUnique({ where: { id: commercialId } });
      expect(seeded?.tripType).toBe('COMMERCIAL_PAID');
      const rahul = await login(app, 'dev_rahul@example.com', 'voyago-dev-password');
      const view = tripOf(await get(rahul, commercialId).expect(200));
      expect(view.viewer.actions).toEqual([]);
      await patch(rahul, commercialId, { title: 'Edited' }).expect(409);
      await action(rahul, commercialId, 'cancel', { reason: 'Test' }).expect(409);
    });
  });

  it('lists my trips with cursor pagination', async () => {
    const first = await http()
      .get('/api/v1/me/trips')
      .query({ role: 'organising', limit: 2 })
      .set('authorization', bearer(alice))
      .expect(200);
    const page = first.body as PageResponse<Trip>;
    expect(page.data).toHaveLength(2);
    expect(page.page.hasMore).toBe(true);
    const second = await http()
      .get('/api/v1/me/trips')
      .query({ role: 'organising', limit: 2, cursor: page.page.nextCursor })
      .set('authorization', bearer(alice))
      .expect(200);
    const ids = [...page.data, ...(second.body as PageResponse<Trip>).data].map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);

    const joined = await http()
      .get('/api/v1/me/trips')
      .query({ role: 'joined' })
      .set('authorization', bearer(bob))
      .expect(200);
    expect((joined.body as PageResponse<Trip>).data.length).toBeGreaterThanOrEqual(1);
    await http()
      .get('/api/v1/me/trips')
      .query({ status: 'NOPE' })
      .set('authorization', bearer(bob))
      .expect(400);
  });

  describe('maps and media when not configured', () => {
    it('reports the features as off and refuses rather than pretending', async () => {
      const features = await http()
        .get('/api/v1/features')
        .set('authorization', bearer(alice))
        .expect(200);
      expect(features.body).toEqual({
        data: { placeSearch: false, routing: false, coverUploads: false, push: false },
      });
      await http()
        .get('/api/v1/places/autocomplete')
        .query({ q: 'Nandi', sessionToken: 'session-12345' })
        .set('authorization', bearer(alice))
        .expect(503);
      await http()
        .post('/api/v1/uploads/cover-signature')
        .set('authorization', bearer(alice))
        .expect(503);
      await http().get('/api/v1/features').expect(401);

      const trip = await create(alice);
      expect(trip.route).toBeNull();
      expect(trip.coverImageUrl).toBeNull();
      const cover = `voyago-dev/trip-covers/${await userId('alice')}/${randomUUID()}`;
      await patch(alice, trip.id, { coverImageId: cover }).expect(503);
      await patch(alice, trip.id, { coverImageId: 'https://evil.example/x.jpg' }).expect(400);
    });
  });
});
