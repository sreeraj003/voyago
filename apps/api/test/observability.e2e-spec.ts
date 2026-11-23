import 'reflect-metadata';
import 'dotenv/config';
import { type INestApplication } from '@nestjs/common';
import {
  type AnalyticsEventName,
  type AuthTokens,
  BusinessMetricsSchema,
  SystemStatusSchema,
  TripSchema,
} from '@voyago/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { z } from 'zod';
import { PrismaService } from '../src/database/prisma.service.js';
import { AnalyticsService } from '../src/observability/analytics.service.js';
import { JobMonitor } from '../src/observability/job-monitor.service.js';
import { RetentionService } from '../src/observability/retention.service.js';
import { bearer, login, registerAndLogin, startAuthApp } from './support/auth-helpers.js';

/** Milestone 15: product events, business metrics, system status, crash reports, retention. */
const prefix = `ob_${randomUUID().slice(0, 6)}`;
const dataOf = <T>(schema: z.ZodType<T>, res: { body: unknown }) =>
  schema.parse((res.body as { data: unknown }).data);

const NAMES = ['org', 'rider', 'other', 'support', 'ops'] as const;
type Name = (typeof NAMES)[number];
const email = (name: Name) => `${prefix}_${name}@example.test`;

describe('analytics and operations (e2e)', () => {
  let app: INestApplication<App>;
  const tokens = {} as Record<Name, AuthTokens>;
  const ids = {} as Record<Name, string>;
  const http = () => request(app.getHttpServer());
  const prisma = () => app.get(PrismaService);
  const analytics = () => app.get(AnalyticsService);
  const as = (name: Name) => ({ authorization: bearer(tokens[name]) });
  const jobName = `e2e-${prefix}`;

  const eventsOf = (name: Name, event?: AnalyticsEventName) =>
    prisma().analyticsEvent.findMany({
      where: { actorKey: analytics().actorKey(ids[name]), ...(event ? { name: event } : {}) },
      orderBy: { occurredAt: 'asc' },
    });

  beforeAll(async () => {
    app = await startAuthApp();
    for (const name of NAMES) {
      await registerAndLogin(app, { email: email(name), username: `${prefix}_${name}` });
      const user = await prisma().user.update({
        where: { username: `${prefix}_${name}` },
        data: { role: name === 'support' ? 'SUPPORT' : name === 'ops' ? 'OPERATIONS' : 'USER' },
      });
      ids[name] = user.id;
      tokens[name] = await login(app, email(name));
    }
  });

  afterAll(async () => {
    const userIds = Object.values(ids);
    await prisma().analyticsEvent.deleteMany({
      where: { actorKey: { in: userIds.map((id) => analytics().actorKey(id)) } },
    });
    await prisma().jobRun.deleteMany({ where: { name: jobName } });
    await prisma().trip.deleteMany({ where: { organiserId: { in: userIds } } });
    await prisma().user.deleteMany({ where: { id: { in: userIds } } });
    await app?.close();
  });

  describe('product events', () => {
    it('records sign-ups under a pseudonymous key, never the user id', async () => {
      const [event] = await eventsOf('rider', 'account_registered');
      expect(event).toBeDefined();
      expect(event!.actorKey).toMatch(/^[0-9a-f]{32}$/);
      expect(event!.actorKey).not.toContain(ids.rider.replace(/-/g, '').slice(0, 32));
      expect(event!.properties).toEqual({ method: 'email' });
      expect(JSON.stringify(event)).not.toContain(ids.rider);
    });

    it('keeps only the properties in the event dictionary', async () => {
      await analytics().track('trip_cancelled', ids.other, {
        mode: 'RIDE',
        by: 'staff',
        email: 'someone@example.test',
        latitude: 12.97,
      } as never);
      const [event] = await eventsOf('other', 'trip_cancelled');
      expect(event!.properties).toEqual({ mode: 'RIDE', by: 'staff' });
    });

    it('drops events whose properties are invalid instead of failing the request', async () => {
      await expect(
        analytics().track('booking_started', ids.other, { seats: -1, amountPaise: 1 }),
      ).resolves.toBeUndefined();
      expect(await eventsOf('other', 'booking_started')).toHaveLength(0);
    });

    it('marks a member active once a day however many requests they make', async () => {
      for (let i = 0; i < 3; i += 1) {
        await http().get('/api/v1/me').set(as('rider')).expect(200);
      }
      // Marked in the background, so the request is never slowed by it.
      await vi.waitFor(async () => expect(await eventsOf('rider', 'user_active')).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await eventsOf('rider', 'user_active')).toHaveLength(1);
      const user = await prisma().user.findUniqueOrThrow({ where: { id: ids.rider } });
      expect(user.lastActiveAt).not.toBeNull();
    });

    it('records profile completion once, when bio, city, a language and an interest are set', async () => {
      await http()
        .patch('/api/v1/me')
        .set(as('rider'))
        .send({ bio: 'Weekend rider', homeCity: 'Bengaluru', languages: ['en', 'kn'] })
        .expect(200);
      expect(await eventsOf('rider', 'profile_completed')).toHaveLength(0);
      await http()
        .patch('/api/v1/me/preferences')
        .set(as('rider'))
        .send({ interests: ['ghats'] })
        .expect(200);
      await http().patch('/api/v1/me').set(as('rider')).send({ bio: 'Still riding' }).expect(200);
      expect(await eventsOf('rider', 'profile_completed')).toHaveLength(1);
      const user = await prisma().user.findUniqueOrThrow({ where: { id: ids.rider } });
      expect(user.profileCompletedAt).not.toBeNull();
    });

    it('follows a trip from creation to completion', async () => {
      const created = dataOf(
        TripSchema,
        await http()
          .post('/api/v1/trips')
          .set(as('org'))
          .send({
            mode: 'RIDE',
            activityType: 'MOTORCYCLE_RIDE',
            title: 'Metrics ride',
            origin: { name: 'Hebbal', point: { latitude: 13.0358, longitude: 77.597 } },
            destination: { name: 'Nandi Hills', point: { latitude: 13.3702, longitude: 77.6835 } },
            departureAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
            maxParticipants: 6,
            visibility: 'PUBLIC',
          })
          .expect(201),
      );
      await http().post(`/api/v1/trips/${created.id}/publish`).set(as('org')).expect(200);

      // Organisers opening their own trip are not counted; others once a day.
      await http().get(`/api/v1/trips/${created.id}`).set(as('org')).expect(200);
      await http().get(`/api/v1/trips/${created.id}`).set(as('rider')).expect(200);
      await http().get(`/api/v1/trips/${created.id}`).set(as('rider')).expect(200);

      const joined = await http()
        .post(`/api/v1/trips/${created.id}/join-requests`)
        .set(as('rider'))
        .send({ message: 'Count me in' })
        .expect(201);
      const requestId = (joined.body as { data: { id: string } }).data.id;
      await http().post(`/api/v1/join-requests/${requestId}/approve`).set(as('org')).expect(200);

      await prisma().trip.update({
        where: { id: created.id },
        data: { departureAt: new Date(Date.now() + 30 * 60_000) },
      });
      await http().post(`/api/v1/trips/${created.id}/start`).set(as('org')).expect(200);
      await http().post(`/api/v1/trips/${created.id}/complete`).set(as('org')).expect(200);

      const org = (await eventsOf('org')).map((e) => [e.name, e.properties]);
      expect(org).toEqual(
        expect.arrayContaining([
          [
            'trip_created',
            { mode: 'RIDE', activityType: 'MOTORCYCLE_RIDE', tripType: 'COMMUNITY_FREE' },
          ],
          [
            'trip_published',
            { mode: 'RIDE', activityType: 'MOTORCYCLE_RIDE', tripType: 'COMMUNITY_FREE' },
          ],
          ['trip_started', { mode: 'RIDE', activityType: 'MOTORCYCLE_RIDE', participants: 2 }],
          ['trip_completed', { mode: 'RIDE', activityType: 'MOTORCYCLE_RIDE', participants: 2 }],
        ]),
      );
      expect(org.some(([name]) => name === 'trip_viewed')).toBe(false);

      const rider = (await eventsOf('rider')).map((e) => [e.name, e.properties]);
      expect(rider.filter(([name]) => name === 'trip_viewed')).toEqual([
        ['trip_viewed', { mode: 'RIDE', participant: false }],
      ]);
      expect(rider).toEqual(
        expect.arrayContaining([
          ['join_requested', { mode: 'RIDE', approvalRequired: true }],
          ['join_approved', { mode: 'RIDE', automatic: false }],
        ]),
      );
    });
  });

  describe('admin metrics', () => {
    it('is for operations and super admins only', async () => {
      await http().get('/api/v1/admin/metrics').expect(401);
      await http().get('/api/v1/admin/metrics').set(as('rider')).expect(403);
      await http().get('/api/v1/admin/metrics').set(as('support')).expect(403);
      await http().get('/api/v1/admin/metrics?days=3').set(as('ops')).expect(400);
    });

    it('reports the north star, engagement, growth, trips and money', async () => {
      const metrics = dataOf(
        BusinessMetricsSchema,
        await http().get('/api/v1/admin/metrics?days=30').set(as('ops')).expect(200),
      );
      expect(metrics.period.days).toBe(30);
      expect(metrics.northStar.months).toHaveLength(6);
      // The trip above was completed this month with two people on it.
      expect(metrics.northStar.months.at(-1)!.value).toBeGreaterThanOrEqual(1);
      expect(metrics.engagement.dau).toBeGreaterThanOrEqual(1);
      expect(metrics.engagement.mau).toBeGreaterThanOrEqual(metrics.engagement.dau);
      expect(metrics.engagement.daily).toHaveLength(30);
      expect(metrics.growth.registrations).toBeGreaterThanOrEqual(NAMES.length - 2);
      expect(metrics.trips.created).toBeGreaterThanOrEqual(1);
      expect(metrics.trips.published).toBeGreaterThanOrEqual(1);
      expect(metrics.money.currency).toBe('INR');
      const names = metrics.events.map((e) => e.name);
      expect(names).toEqual(expect.arrayContaining(['account_registered', 'trip_completed']));
    });
  });

  describe('system status', () => {
    it('shows dependencies, jobs, payments and moderation to support and operations', async () => {
      await http().get('/api/v1/admin/system').set(as('rider')).expect(403);
      const status = dataOf(
        SystemStatusSchema,
        await http().get('/api/v1/admin/system').set(as('support')).expect(200),
      );
      const deps = Object.fromEntries(status.dependencies.map((d) => [d.name, d.up]));
      expect(deps).toMatchObject({ database: true, redis: true });
      expect(status.jobs.map((j) => j.name)).toEqual(
        expect.arrayContaining(['trip-expiry', 'payment-reconciliation', 'data-retention']),
      );
      expect(status.http.requests).toBeGreaterThan(0);
      expect(status.moderation.overdue).toBeGreaterThanOrEqual(0);
    });

    it('records failing and recovering jobs', async () => {
      const jobs = app.get(JobMonitor);
      expect(await jobs.run(jobName, () => Promise.reject(new Error('boom')))).toBe(false);
      expect(await jobs.run(jobName, () => Promise.reject(new Error('boom again')))).toBe(false);
      let row = await prisma().jobRun.findUniqueOrThrow({ where: { name: jobName } });
      expect(row).toMatchObject({ consecutiveFailures: 2, failures: 2, lastError: 'boom again' });
      expect(await jobs.run(jobName, () => Promise.resolve())).toBe(true);
      row = await prisma().jobRun.findUniqueOrThrow({ where: { name: jobName } });
      expect(row).toMatchObject({ consecutiveFailures: 0, runs: 3, failures: 2 });
      expect(row.lastSuccessAt).not.toBeNull();
    });
  });

  describe('crash reports', () => {
    it('accepts reports without an account and counts them', async () => {
      const before = dataOf(
        SystemStatusSchema,
        await http().get('/api/v1/admin/system').set(as('ops')).expect(200),
      ).clientErrors24h;
      await http()
        .post('/api/v1/client-errors')
        .send({
          platform: 'android',
          appVersion: '1.0.0',
          message: 'TypeError: undefined is not a function (user rider@example.test)',
          route: '/trips/[id]',
          fatal: true,
        })
        .expect(204);
      await http()
        .post('/api/v1/client-errors')
        .send({ platform: 'android', appVersion: '1.0.0', message: '' })
        .expect(400);
      const after = dataOf(
        SystemStatusSchema,
        await http().get('/api/v1/admin/system').set(as('ops')).expect(200),
      ).clientErrors24h;
      expect(after).toBeGreaterThanOrEqual(before + 1);
    });
  });

  describe('prometheus scraping', () => {
    it('is off without a metrics token', async () => {
      await http().get('/api/v1/metrics').expect(404);
    });

    it('needs the token when one is set', async () => {
      const token = randomUUID();
      const second = await startAuthApp({ METRICS_TOKEN: token });
      try {
        const server = () => request(second.getHttpServer());
        await server().get('/api/v1/metrics').expect(401);
        await server().get('/api/v1/metrics').set('authorization', 'Bearer wrong').expect(401);
        await server().get('/api/v1/health/live').expect(200);
        const res = await server()
          .get('/api/v1/metrics')
          .set('authorization', `Bearer ${token}`)
          .expect(200);
        expect(res.text).toContain('dependency_up{name="database"} 1');
        expect(res.text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      } finally {
        await second.close();
      }
    });
  });

  describe('data retention', () => {
    it('deletes events past retention and forgets deleted accounts, keeping the rest', async () => {
      const old = await prisma().analyticsEvent.create({
        data: {
          name: 'user_active',
          actorKey: analytics().actorKey(ids.other),
          occurredAt: new Date(Date.now() - 500 * 86_400_000),
        },
      });
      const recent = await prisma().analyticsEvent.create({
        data: { name: 'user_active', actorKey: analytics().actorKey(ids.other) },
      });
      const result = await app.get(RetentionService).run();
      expect(result.analyticsEvents).toBeGreaterThanOrEqual(1);
      expect(await prisma().analyticsEvent.findUnique({ where: { id: old.id } })).toBeNull();
      expect(await prisma().analyticsEvent.findUnique({ where: { id: recent.id } })).not.toBeNull();

      await prisma().user.update({ where: { id: ids.other }, data: { deletedAt: new Date() } });
      await app.get(RetentionService).run();
      expect(await eventsOf('other')).toHaveLength(0);
    });

    it('limits what an event can hold in the database too', async () => {
      await expect(
        prisma()
          .$executeRaw`INSERT INTO "analytics_events" ("name", "actor_key") VALUES ('user_active', ${'not-a-key'})`,
      ).rejects.toThrow();
      await expect(
        prisma()
          .$executeRaw`INSERT INTO "analytics_events" ("name", "properties") VALUES ('user_active', ${JSON.stringify({ blob: 'x'.repeat(2000) })}::jsonb)`,
      ).rejects.toThrow();
    });
  });
});
