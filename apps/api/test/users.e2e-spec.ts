import 'reflect-metadata';
import 'dotenv/config';
import { type INestApplication } from '@nestjs/common';
import {
  ApiErrorSchema,
  type AuthTokens,
  type Motorcycle,
  PreferencesSchema,
  PrivateProfileSchema,
  PublicProfileSchema,
} from '@voyago/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { bearer, registerAndLogin, startAuthApp } from './support/auth-helpers.js';

/** Profiles, preferences, motorcycles: ownership and privacy rules. */
const prefix = `us_${randomUUID().slice(0, 6)}`;

describe('profiles (e2e)', () => {
  let app: INestApplication<App>;
  let alice: AuthTokens;
  let bob: AuthTokens;
  const http = () => request(app.getHttpServer());
  const aliceName = `${prefix}_alice`;
  const bobName = `${prefix}_bob`;

  beforeAll(async () => {
    app = await startAuthApp();
    alice = await registerAndLogin(app, {
      email: `${aliceName}@example.test`,
      username: aliceName,
    });
    bob = await registerAndLogin(app, { email: `${bobName}@example.test`, username: bobName });
    await app
      .get(PrismaService)
      .user.update({ where: { username: aliceName }, data: { phone: '+919811122233' } });
  });

  afterAll(async () => {
    await app.get(PrismaService).user.deleteMany({ where: { username: { startsWith: prefix } } });
    await app?.close();
  });

  const setVisibility = (tokens: AuthTokens, profileVisibility: string) =>
    http()
      .patch('/api/v1/me/preferences')
      .set('authorization', bearer(tokens))
      .send({ profileVisibility })
      .expect(200);

  describe('my profile', () => {
    it('updates allowed fields and ignores protected ones', async () => {
      const res = await http()
        .patch('/api/v1/me')
        .set('authorization', bearer(alice))
        .send({
          displayName: '  Alice Rider ',
          bio: 'Weekend rides around Bengaluru',
          homeCity: 'Bengaluru',
          country: 'in',
          languages: ['en', 'KN', 'en'],
          role: 'ADMIN',
          status: 'ACTIVE',
          email: 'stolen@example.test',
        })
        .expect(200);
      const profile = PrivateProfileSchema.parse((res.body as { data: unknown }).data);
      expect(profile).toMatchObject({
        displayName: 'Alice Rider',
        homeCity: 'Bengaluru',
        country: 'IN',
        languages: ['en', 'kn'],
        role: 'USER',
        email: `${aliceName}@example.test`,
      });
    });

    it('rejects a taken username and an empty update', async () => {
      await http()
        .patch('/api/v1/me')
        .set('authorization', bearer(alice))
        .send({ username: bobName.toUpperCase() })
        .expect(409);
      await http().patch('/api/v1/me').set('authorization', bearer(alice)).send({}).expect(400);
    });

    it('requires authentication', async () => {
      await http().get('/api/v1/me').expect(401);
      await http().patch('/api/v1/me').send({ displayName: 'x' }).expect(401);
      await http().get(`/api/v1/users/${aliceName}`).expect(401);
    });
  });

  describe('public profiles', () => {
    it('never include contact details', async () => {
      await setVisibility(alice, 'PUBLIC');
      const res = await http()
        .get(`/api/v1/users/${aliceName.toUpperCase()}`)
        .set('authorization', bearer(bob))
        .expect(200);
      const profile = PublicProfileSchema.parse((res.body as { data: unknown }).data);
      expect(profile).toMatchObject({ username: aliceName, limited: false, homeCity: 'Bengaluru' });
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('@example.test');
      expect(body).not.toContain('9811122233');
      for (const key of ['email', 'phone', 'passwordHash', 'role', 'status', 'lastActiveAt']) {
        expect(res.body).not.toHaveProperty(`data.${key}`);
      }
    });

    it('show only the basics for private profiles, and for followers-only to non-followers', async () => {
      await setVisibility(alice, 'PRIVATE');
      const priv = await http()
        .get(`/api/v1/users/${aliceName}`)
        .set('authorization', bearer(bob))
        .expect(200);
      expect(priv.body).toMatchObject({
        data: { limited: true, bio: null, homeCity: null, motorcycles: [] },
      });
      // The owner always sees the full profile.
      const own = await http()
        .get(`/api/v1/users/${aliceName}`)
        .set('authorization', bearer(alice))
        .expect(200);
      expect(own.body).toMatchObject({ data: { limited: false } });

      await setVisibility(alice, 'FOLLOWERS');
      const notFollowing = await http()
        .get(`/api/v1/users/${aliceName}`)
        .set('authorization', bearer(bob))
        .expect(200);
      expect(notFollowing.body).toMatchObject({ data: { limited: true } });

      const prisma = app.get(PrismaService);
      const [a, b] = await Promise.all([
        prisma.user.findUniqueOrThrow({ where: { username: aliceName } }),
        prisma.user.findUniqueOrThrow({ where: { username: bobName } }),
      ]);
      await prisma.follow.create({ data: { followerId: b.id, followeeId: a.id } });
      const following = await http()
        .get(`/api/v1/users/${aliceName}`)
        .set('authorization', bearer(bob))
        .expect(200);
      expect(following.body).toMatchObject({ data: { limited: false } });
      await setVisibility(alice, 'PUBLIC');
    });

    it('are hidden in both directions after a block, and for suspended or unknown users', async () => {
      const prisma = app.get(PrismaService);
      const carolName = `${prefix}_carol`;
      const carol = await registerAndLogin(app, {
        email: `${carolName}@example.test`,
        username: carolName,
      });
      const [a, c] = await Promise.all([
        prisma.user.findUniqueOrThrow({ where: { username: aliceName } }),
        prisma.user.findUniqueOrThrow({ where: { username: carolName } }),
      ]);
      await prisma.userBlock.create({ data: { blockerId: a.id, blockedId: c.id } });
      await http()
        .get(`/api/v1/users/${aliceName}`)
        .set('authorization', bearer(carol))
        .expect(404);
      await http()
        .get(`/api/v1/users/${carolName}`)
        .set('authorization', bearer(alice))
        .expect(404);
      await http()
        .get(`/api/v1/users/${prefix}_nobody`)
        .set('authorization', bearer(bob))
        .expect(404);
      await http().get('/api/v1/users/x').set('authorization', bearer(bob)).expect(400);

      await prisma.user.update({ where: { id: c.id }, data: { status: 'SUSPENDED' } });
      await http().get(`/api/v1/users/${carolName}`).set('authorization', bearer(bob)).expect(404);
    });
  });

  describe('preferences', () => {
    it('reads defaults and applies partial updates', async () => {
      const initial = await http()
        .get('/api/v1/me/preferences')
        .set('authorization', bearer(bob))
        .expect(200);
      expect(PreferencesSchema.parse((initial.body as { data: unknown }).data)).toMatchObject({
        profileVisibility: 'PUBLIC',
        allowMessagesFrom: 'TRIP_PARTICIPANTS',
        interests: [],
      });
      const res = await http()
        .patch('/api/v1/me/preferences')
        .set('authorization', bearer(bob))
        .send({
          preferredMode: 'RIDE',
          interests: ['photography', 'camping', 'photography'],
          preferredActivities: ['MOTORCYCLE_RIDE', 'TREK'],
          travelStyles: ['ADVENTURE'],
          preferredDestinations: ['Coorg', 'Gokarna'],
          budgetMinPaise: 100_000,
          budgetMaxPaise: 500_000,
          groupSizeMin: 2,
          groupSizeMax: 8,
          ridingExperience: 'INTERMEDIATE',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        data: { preferredMode: 'RIDE', interests: ['photography', 'camping'], groupSizeMax: 8 },
      });
    });

    it('rejects invalid ranges, including against stored values', async () => {
      const inline = await http()
        .patch('/api/v1/me/preferences')
        .set('authorization', bearer(bob))
        .send({ groupSizeMin: 10, groupSizeMax: 2 })
        .expect(400);
      expect(ApiErrorSchema.parse(inline.body).details?.[0]?.path).toBe('groupSizeMin');
      // Stored max is 8 from the previous test.
      await http()
        .patch('/api/v1/me/preferences')
        .set('authorization', bearer(bob))
        .send({ groupSizeMin: 20 })
        .expect(400);
      await http()
        .patch('/api/v1/me/preferences')
        .set('authorization', bearer(bob))
        .send({ travelStyles: ['SPACE_TOURISM'] })
        .expect(400);
    });
  });

  describe('motorcycles', () => {
    const add = (tokens: AuthTokens, body: Record<string, unknown>) =>
      http().post('/api/v1/me/motorcycles').set('authorization', bearer(tokens)).send(body);

    it('adds motorcycles with one primary and never stores identifiers', async () => {
      const first = await add(alice, {
        make: 'Royal Enfield',
        model: 'Himalayan 450',
        engineCc: 452,
        category: 'ADVENTURE',
        nickname: 'Himmy',
        registrationNumber: 'KA01AB1234',
      }).expect(201);
      expect((first.body as { data: Motorcycle }).data).toMatchObject({
        isPrimary: true,
        verificationStatus: 'UNVERIFIED',
      });
      expect(JSON.stringify(first.body)).not.toContain('KA01AB1234');

      const second = await add(alice, {
        make: 'KTM',
        model: '390 Duke',
        category: 'STREET',
        isPrimary: true,
      }).expect(201);
      const list = await http()
        .get('/api/v1/me/motorcycles')
        .set('authorization', bearer(alice))
        .expect(200);
      const bikes = (list.body as { data: Motorcycle[] }).data;
      expect(bikes.filter((b) => b.isPrimary).map((b) => b.id)).toEqual([
        (second.body as { data: Motorcycle }).data.id,
      ]);

      // Public profile lists the bikes without nicknames.
      const profile = await http()
        .get(`/api/v1/users/${aliceName}`)
        .set('authorization', bearer(bob))
        .expect(200);
      expect((profile.body as { data: { motorcycles: unknown[] } }).data.motorcycles).toHaveLength(
        2,
      );
      expect(JSON.stringify(profile.body)).not.toContain('Himmy');

      await add(alice, { make: 'X', model: 'Y', category: 'SPORT', engineCc: 10 }).expect(400);
    });

    it("cannot read, change or delete someone else's motorcycle", async () => {
      const created = await add(alice, { make: 'Bajaj', model: 'Dominar 400', category: 'TOURER' });
      const id = (created.body as { data: Motorcycle }).data.id;

      await http()
        .patch(`/api/v1/me/motorcycles/${id}`)
        .set('authorization', bearer(bob))
        .send({ model: 'Hijacked' })
        .expect(404);
      await http()
        .delete(`/api/v1/me/motorcycles/${id}`)
        .set('authorization', bearer(bob))
        .expect(404);
      const bobs = await http()
        .get('/api/v1/me/motorcycles')
        .set('authorization', bearer(bob))
        .expect(200);
      expect((bobs.body as { data: unknown[] }).data).toEqual([]);

      const updated = await http()
        .patch(`/api/v1/me/motorcycles/${id}`)
        .set('authorization', bearer(alice))
        .send({ model: 'Dominar 250', engineCc: 248 })
        .expect(200);
      expect((updated.body as { data: Motorcycle }).data.model).toBe('Dominar 250');
      await http()
        .delete(`/api/v1/me/motorcycles/${id}`)
        .set('authorization', bearer(alice))
        .expect(204);
      await http()
        .delete(`/api/v1/me/motorcycles/${id}`)
        .set('authorization', bearer(alice))
        .expect(404);
      await http()
        .delete('/api/v1/me/motorcycles/not-a-uuid')
        .set('authorization', bearer(alice))
        .expect(400);
    });
  });
});
