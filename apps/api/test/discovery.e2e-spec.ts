import 'reflect-metadata';
import 'dotenv/config';
import { type INestApplication } from '@nestjs/common';
import {
  type AuthTokens,
  type CreateTripInput,
  DestinationSummarySchema,
  TripCardSchema,
  TripSchema,
} from '@voyago/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { z } from 'zod';
import { PrismaService } from '../src/database/prisma.service.js';
import { bearer, login, registerAndLogin, startAuthApp } from './support/auth-helpers.js';

/**
 * Discovery against the real database. Test trips sit around a point far from the seed data
 * (in Uttarakhand) and carry a unique word, so other suites' rows don't affect the results.
 */
const prefix = `dq_${randomUUID().slice(0, 6)}`;
const word = `zq${randomUUID().replaceAll('-', '').slice(0, 8)}`;
const CENTRE = { latitude: 30.1, longitude: 79.1 };
const HOUR = 3_600_000;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();
/** A point `km` north of the centre (1° latitude ≈ 111 km). */
const north = (km: number) => ({
  latitude: CENTRE.latitude + km / 111.2,
  longitude: CENTRE.longitude,
});

const CardPage = z.object({
  data: z.array(TripCardSchema),
  page: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() }),
});
const DestinationPage = z.object({ data: z.array(DestinationSummarySchema) });

const body = (overrides: Partial<CreateTripInput> = {}): CreateTripInput => ({
  mode: 'RIDE',
  activityType: 'MOTORCYCLE_RIDE',
  title: `Hill ride ${word}`,
  origin: { name: 'Kathgodam station', point: { latitude: 30.123456, longitude: 79.123456 } },
  destination: { name: 'Mukteshwar', point: { latitude: 29.4722, longitude: 79.6479 } },
  departureAt: inHours(72),
  maxParticipants: 6,
  visibility: 'PUBLIC',
  ...overrides,
});

describe('discovery (e2e)', () => {
  let app: INestApplication<App>;
  let alice: AuthTokens;
  let bob: AuthTokens;
  let carol: AuthTokens;
  const http = () => request(app.getHttpServer());
  const prisma = () => app.get(PrismaService);
  type TripKey =
    'near' | 'mid' | 'far' | 'travel' | 'outside' | 'private' | 'draft' | 'cancelled' | 'carol';
  const ids = {} as Record<TripKey, string>;

  const create = async (tokens: AuthTokens, input: CreateTripInput, publish = true) => {
    const res = await http().post('/api/v1/trips').set('authorization', bearer(tokens)).send(input);
    expect(res.status).toBe(201);
    const trip = TripSchema.parse((res.body as { data: unknown }).data);
    if (publish) {
      await http()
        .post(`/api/v1/trips/${trip.id}/publish`)
        .set('authorization', bearer(tokens))
        .expect(200);
    }
    return trip.id;
  };
  const discover = (path: string, query: Record<string, string | number>, tokens = bob) =>
    http().get(`/api/v1/discovery/${path}`).query(query).set('authorization', bearer(tokens));
  const cards = async (path: string, query: Record<string, string | number>, tokens = bob) => {
    const res = await discover(path, query, tokens);
    expect(res.status).toBe(200);
    return CardPage.parse(res.body);
  };
  const near = (radiusKm = 50) => ({
    lat: CENTRE.latitude,
    lng: CENTRE.longitude,
    radiusKm,
  });
  const userId = async (name: string) =>
    (await prisma().user.findUniqueOrThrow({ where: { username: `${prefix}_${name}` } })).id;

  beforeAll(async () => {
    app = await startAuthApp({ DISCOVERY_DEFAULT_RADIUS_KM: '25', DISCOVERY_MAX_RADIUS_KM: '200' });
    for (const name of ['alice', 'bob', 'carol', 'dave']) {
      await registerAndLogin(app, {
        email: `${prefix}_${name}@example.test`,
        username: `${prefix}_${name}`,
      });
    }
    alice = await login(app, `${prefix}_alice@example.test`);
    bob = await login(app, `${prefix}_bob@example.test`);
    carol = await login(app, `${prefix}_carol@example.test`);

    // Five public trips by Alice at increasing distance and departure.
    ids.near = await create(alice, {
      ...body({ title: `Sunrise ${word} ride`, departureAt: inHours(96) }),
      origin: { name: 'Kathgodam station', point: north(2) },
      estimatedBudgetPaise: 40_000,
      minEngineCc: 300,
      bikeCategories: ['ADVENTURE'],
    });
    ids.mid = await create(alice, {
      ...body({ departureAt: inHours(48) }),
      origin: { name: 'Haldwani bus stand', point: north(20) },
      estimatedBudgetPaise: 90_000,
    });
    ids.far = await create(alice, {
      ...body({ departureAt: inHours(24) }),
      origin: { name: 'Bhimtal lake', point: north(40) },
    });
    ids.travel = await create(alice, {
      ...body({
        mode: 'TRAVEL',
        activityType: 'TREK',
        title: `Forest trek ${word}`,
        departureAt: inHours(120),
      }),
      origin: { name: 'Kathgodam station', point: north(10) },
      destination: { name: 'MUKTESHWAR ', point: { latitude: 29.47, longitude: 79.65 } },
      maxParticipants: 2,
    });
    ids.outside = await create(alice, {
      ...body({ departureAt: inHours(30) }),
      origin: { name: 'Almora', point: north(150) },
    });
    // Never discoverable: private, draft, cancelled, and Carol's (Bob blocks her).
    ids.private = await create(alice, { ...body(), visibility: 'PRIVATE' });
    ids.draft = await create(alice, body(), false);
    ids.cancelled = await create(alice, body());
    await http()
      .post(`/api/v1/trips/${ids.cancelled}/cancel`)
      .set('authorization', bearer(alice))
      .send({ reason: 'Weather' })
      .expect(200);
    ids.carol = await create(carol, body());
    await prisma().userBlock.create({
      data: { blockerId: await userId('bob'), blockedId: await userId('carol') },
    });
  });

  afterAll(async () => {
    const users = await prisma().user.findMany({
      where: { username: { startsWith: prefix } },
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);
    await prisma().trip.deleteMany({ where: { organiserId: { in: userIds } } });
    await prisma().user.deleteMany({ where: { id: { in: userIds } } });
    await app?.close();
  });

  describe('coordinate and radius validation', () => {
    it.each([
      [{ lat: 91, lng: 79 }, 'lat'],
      [{ lat: -90.5, lng: 79 }, 'lat'],
      [{ lat: 30, lng: 181 }, 'lng'],
      [{ lat: 30, lng: 'east' }, 'lng'],
      [{ lat: 30 }, 'lat'],
      [{ radiusKm: 10 }, 'radiusKm'],
      [{ lat: 30, lng: 79, radiusKm: 0 }, 'radiusKm'],
      [{ lat: 30, lng: 79, radiusKm: 501 }, 'radiusKm'],
      [{ sort: 'proximity' }, 'sort'],
    ])('rejects %o', async (query, field) => {
      const res = await discover('search', query);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain(field);
    });

    it('rejects a radius above the configured maximum', async () => {
      const res = await discover('nearby', { ...near(300) });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('200 km or less');
    });

    it('limits results to the radius', async () => {
      const within25 = await cards('nearby', { ...near(25) });
      const ours = within25.data.map((c) => c.id);
      expect(ours).toEqual(expect.arrayContaining([ids.near, ids.mid, ids.travel]));
      expect(ours).not.toContain(ids.far);
      expect(ours).not.toContain(ids.outside);
      const within5 = await cards('nearby', { ...near(5) });
      expect(within5.data.map((c) => c.id)).toEqual([ids.near]);
    });
  });

  describe('without location permission', () => {
    it('nearby needs a point and says so', async () => {
      const res = await discover('nearby', {});
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('lat');
    });

    it('search works without a point and reports no distance', async () => {
      const page = await cards('search', { q: word, limit: 50 });
      expect(page.data.length).toBeGreaterThanOrEqual(5);
      for (const card of page.data) {
        expect(card.straightLineKm).toBeNull();
        expect(card.matchReasons.join(' ')).not.toContain('km away');
      }
    });
  });

  describe('visibility', () => {
    it('never returns private, draft, cancelled or blocked organisers’ trips', async () => {
      const page = await cards('search', { q: word, limit: 50 });
      const found = page.data.map((c) => c.id);
      for (const hidden of ['private', 'draft', 'cancelled', 'carol'] as const) {
        expect({ hidden, found: found.includes(ids[hidden]) }).toEqual({
          hidden,
          found: false,
        });
      }
      // Blocking works both ways: Carol doesn't see Bob's trips either.
      const bobsTrip = await create(bob, body());
      try {
        const asCarol = await cards('search', { q: word, limit: 50 }, carol);
        expect(asCarol.data.map((c) => c.id)).toContain(ids.near);
        expect(asCarol.data.map((c) => c.id)).not.toContain(bobsTrip);
      } finally {
        await prisma().trip.delete({ where: { id: bobsTrip } });
      }
    });

    it('shows meeting points only approximately, with whole-km straight-line distance', async () => {
      const res = await discover('nearby', { ...near(50) });
      const text = JSON.stringify(res.body);
      const exact = north(2).latitude.toString();
      expect(text).not.toContain(exact.slice(0, 7));
      const card = CardPage.parse(res.body).data.find((c) => c.id === ids.near);
      expect(card?.origin.approximate).toBe(true);
      expect(card?.origin.point.latitude).toBe(Math.round(north(2).latitude * 100) / 100);
      expect(card?.straightLineKm).toBe(2);
      expect(card?.matchReasons).toContain('About 2 km away (straight line)');
    });
  });

  describe('filters', () => {
    const only = async (query: Record<string, string | number>) =>
      (await cards('search', { q: word, limit: 50, ...query })).data.map((c) => c.id).sort();

    it('filters by mode, activity, places and dates', async () => {
      expect(await only({ mode: 'TRAVEL' })).toEqual([ids.travel]);
      expect(await only({ activityType: 'TREK,BACKPACKING' })).toEqual([ids.travel]);
      expect(await only({ from: 'haldwani' })).toEqual([ids.mid]);
      expect(await only({ to: 'mukt', mode: 'TRAVEL' })).toEqual([ids.travel]);
      expect(await only({ departFrom: inHours(100), departTo: inHours(200) })).toEqual([
        ids.travel,
      ]);
    });

    it('filters by budget, seats, bike type and engine size', async () => {
      expect(await only({ budgetMaxPaise: 50_000 })).toEqual([ids.near]);
      expect(await only({ budgetMinPaise: 50_000 })).toEqual([ids.mid]);
      expect(await only({ minSeats: 5 })).not.toContain(ids.travel);
      expect(await only({ bikeCategory: 'SCOOTER' })).not.toContain(ids.near);
      expect(await only({ bikeCategory: 'ADVENTURE' })).toContain(ids.near);
      expect(await only({ engineCc: 200 })).not.toContain(ids.near);
      expect(await only({ engineCc: 400 })).toContain(ids.near);
    });

    it('includes full trips only when asked', async () => {
      await prisma().trip.update({ where: { id: ids.travel }, data: { status: 'FULL' } });
      try {
        expect(await only({})).not.toContain(ids.travel);
        expect(await only({ status: 'PUBLISHED,FULL' })).toContain(ids.travel);
      } finally {
        await prisma().trip.update({ where: { id: ids.travel }, data: { status: 'PUBLISHED' } });
      }
    });

    it('treats search text literally', async () => {
      expect(await only({ from: '%%' })).toEqual([]);
      const res = await discover('search', { q: "'):* & !" });
      expect(res.status).toBe(200);
      expect(CardPage.parse(res.body).data).toEqual([]);
    });
  });

  describe('sorting and pagination', () => {
    it('sorts by departure and by distance', async () => {
      const byDeparture = await cards('search', { q: word, sort: 'departure', limit: 50 });
      const times = byDeparture.data.map((c) => c.departureAt);
      expect(times).toEqual([...times].sort());
      const byDistance = await cards('search', { q: word, ...near(200), sort: 'proximity' });
      expect(byDistance.data.map((c) => c.id)).toEqual([
        ids.near,
        ids.travel,
        ids.mid,
        ids.far,
        ids.outside,
      ]);
    });

    it('ranks text matches in the title above weaker ones', async () => {
      const page = await cards('search', { q: `sunrise ${word}` });
      expect(page.data[0]?.id).toBe(ids.near);
      expect(page.data[0]?.matchReasons[0]).toBe(`Matches "sunrise ${word}"`);
    });

    it('pages through results without repeats', async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await cards('search', {
          q: word,
          sort: 'departure',
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        expect(page.data.length).toBeLessThanOrEqual(2);
        seen.push(...page.data.map((c) => c.id));
        cursor = page.page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it('rejects bad cursors and limits', async () => {
      expect((await discover('search', { cursor: 'not-a-cursor' })).status).toBe(400);
      expect((await discover('search', { limit: 51 })).status).toBe(400);
      const tooDeep = Buffer.from(JSON.stringify({ o: 10_000 })).toString('base64url');
      expect((await discover('search', { cursor: tooDeep })).status).toBe(400);
    });
  });

  describe('trending and destinations', () => {
    it('puts trips people joined this week first', async () => {
      await prisma().tripParticipant.create({
        data: { tripId: ids.far, userId: await userId('dave') },
      });
      const page = await cards('trending', { ...near(100) });
      expect(page.data[0]?.id).toBe(ids.far);
      expect(page.data[0]?.matchReasons).toContain('1 joined this week');
    });

    it('groups destinations ignoring case and spacing', async () => {
      const res = await discover('destinations', { q: 'mukteshwar' });
      expect(res.status).toBe(200);
      const [top] = DestinationPage.parse(res.body).data;
      expect(top?.tripCount).toBeGreaterThanOrEqual(5);
      expect(top?.name.trim().toLowerCase()).toBe('mukteshwar');
    });
  });
});
