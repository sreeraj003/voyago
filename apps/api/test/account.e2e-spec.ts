import 'reflect-metadata';
import 'dotenv/config';
import { type INestApplication } from '@nestjs/common';
import { AccountDeletionStatusSchema, type AuthTokens, TripSchema } from '@voyago/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { type z } from 'zod';
import { PrismaService } from '../src/database/prisma.service.js';
import { AnalyticsService } from '../src/observability/analytics.service.js';
import {
  bearer,
  login,
  registerAndLogin,
  startAuthApp,
  TEST_PASSWORD,
} from './support/auth-helpers.js';

/** Milestone 16: deleting an account and exporting one's data. */
const prefix = `ac_${randomUUID().slice(0, 6)}`;
const dataOf = <T>(schema: z.ZodType<T>, res: { body: unknown }) =>
  schema.parse((res.body as { data: unknown }).data);

const NAMES = ['leaver', 'organiser', 'friend', 'phoneOnly'] as const;
type Name = (typeof NAMES)[number];
const email = (name: Name) => `${prefix}_${name}@example.test`;

describe('account deletion and data export (e2e)', () => {
  let app: INestApplication<App>;
  const tokens = {} as Record<Name, AuthTokens>;
  const ids = {} as Record<Name, string>;
  const http = () => request(app.getHttpServer());
  const prisma = () => app.get(PrismaService);
  const as = (name: Name) => ({ authorization: bearer(tokens[name]) });

  const ride = async (by: Name) => {
    const trip = dataOf(
      TripSchema,
      await http()
        .post('/api/v1/trips')
        .set(as(by))
        .send({
          mode: 'RIDE',
          activityType: 'MOTORCYCLE_RIDE',
          title: 'Account test ride',
          origin: { name: 'Hebbal', point: { latitude: 13.0358, longitude: 77.597 } },
          destination: { name: 'Nandi Hills', point: { latitude: 13.3702, longitude: 77.6835 } },
          departureAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
          maxParticipants: 2,
          approvalRequired: false,
          visibility: 'PUBLIC',
        })
        .expect(201),
    );
    await http().post(`/api/v1/trips/${trip.id}/publish`).set(as(by)).expect(200);
    return trip.id;
  };

  beforeAll(async () => {
    app = await startAuthApp();
    for (const name of NAMES) {
      tokens[name] = await registerAndLogin(app, {
        email: email(name),
        username: `${prefix}_${name}`.slice(0, 30),
      });
      ids[name] = (await prisma().user.findUniqueOrThrow({ where: { email: email(name) } })).id;
    }
  });

  afterAll(async () => {
    const userIds = Object.values(ids);
    await prisma().trip.deleteMany({ where: { organiserId: { in: userIds } } });
    await prisma()
      .auditLog.deleteMany({ where: { actorId: { in: userIds } } })
      .catch(() => {
        // The audit log is append-only; its rows stay.
      });
    await prisma().user.deleteMany({ where: { id: { in: userIds } } });
    await app?.close();
  });

  it('exports everything held about the member, without secrets', async () => {
    await http()
      .patch('/api/v1/me')
      .set(as('leaver'))
      .send({ bio: 'Coffee rides', homeCity: 'Bengaluru' })
      .expect(200);
    await http()
      .post('/api/v1/me/emergency-contacts')
      .set(as('leaver'))
      .send({ name: 'Mum', phone: '+91 98450 00011' })
      .expect(201);
    const res = await http().get('/api/v1/me/export').set(as('leaver')).expect(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['cache-control']).toBe('no-store');
    const data = (res.body as { data: Record<string, unknown> }).data;
    expect(data.format).toBe('voyago-export-v1');
    expect(data.profile).toMatchObject({ email: email('leaver'), bio: 'Coffee rides' });
    expect(data.emergencyContacts).toEqual([expect.objectContaining({ name: 'Mum' })]);
    const text = JSON.stringify(data);
    expect(text).not.toMatch(/passwordHash|refreshTokenHash|codeHash|argon2/);
    await http().get('/api/v1/me/export').expect(401);
  });

  it('says what blocks deletion, and refuses until it is settled', async () => {
    const tripId = await ride('organiser');
    const status = dataOf(
      AccountDeletionStatusSchema,
      await http().get('/api/v1/me/deletion').set(as('organiser')).expect(200),
    );
    expect(status.canDelete).toBe(false);
    expect(status.blockers.map((b) => b.code)).toEqual(['ORGANISING_TRIPS']);
    expect(status.passwordRequired).toBe(true);

    const refused = await http()
      .post('/api/v1/me/delete')
      .set(as('organiser'))
      .send({ confirm: 'DELETE', password: TEST_PASSWORD })
      .expect(409);
    expect((refused.body as { details: { path: string }[] }).details[0]!.path).toBe(
      'ORGANISING_TRIPS',
    );

    await http()
      .post(`/api/v1/trips/${tripId}/cancel`)
      .set(as('organiser'))
      .send({ reason: 'Testing account deletion' })
      .expect(200);
    const after = dataOf(
      AccountDeletionStatusSchema,
      await http().get('/api/v1/me/deletion').set(as('organiser')).expect(200),
    );
    expect(after.canDelete).toBe(true);
  });

  it('needs the confirmation word and the password', async () => {
    await http()
      .post('/api/v1/me/delete')
      .set(as('leaver'))
      .send({ password: TEST_PASSWORD })
      .expect(400);
    await http()
      .post('/api/v1/me/delete')
      .set(as('leaver'))
      .send({ confirm: 'DELETE', password: 'not the password' })
      .expect(401);
    await http()
      .post('/api/v1/me/delete')
      .set(as('leaver'))
      .send({ confirm: 'DELETE' })
      .expect(401);
  });

  it('erases the member, frees their place on a trip and signs them out everywhere', async () => {
    // The leaver joins the friend's two-seat ride, which fills it.
    const tripId = await ride('friend');
    await http()
      .post(`/api/v1/trips/${tripId}/join-requests`)
      .set(as('leaver'))
      .send({})
      .expect(201);
    expect((await prisma().trip.findUniqueOrThrow({ where: { id: tripId } })).status).toBe('FULL');
    await prisma().follow.create({ data: { followerId: ids.friend, followeeId: ids.leaver } });
    const otherDevice = await login(app, email('leaver'));
    const analytics = app.get(AnalyticsService);
    expect(
      await prisma().analyticsEvent.count({ where: { actorKey: analytics.actorKey(ids.leaver) } }),
    ).toBeGreaterThan(0);

    await http()
      .post('/api/v1/me/delete')
      .set(as('leaver'))
      .send({ confirm: 'DELETE', password: TEST_PASSWORD })
      .expect(204);

    const user = await prisma().user.findUniqueOrThrow({ where: { id: ids.leaver } });
    expect(user).toMatchObject({
      email: null,
      phone: null,
      passwordHash: null,
      bio: null,
      homeCity: null,
      displayName: 'Deleted member',
      status: 'DEACTIVATED',
    });
    expect(user.username).toMatch(/^deleted_[0-9a-f]{16}$/);
    expect(user.deletedAt).not.toBeNull();

    // Their place is free again and the trip is open.
    expect(await prisma().trip.findUniqueOrThrow({ where: { id: tripId } })).toMatchObject({
      status: 'PUBLISHED',
      participantCount: 1,
    });
    expect(await prisma().emergencyContact.count({ where: { userId: ids.leaver } })).toBe(0);
    expect(await prisma().follow.count({ where: { followeeId: ids.leaver } })).toBe(0);
    expect(await prisma().authSession.count({ where: { userId: ids.leaver } })).toBe(0);
    expect(
      await prisma().analyticsEvent.count({ where: { actorKey: analytics.actorKey(ids.leaver) } }),
    ).toBe(0);
    const audit = await prisma().auditLog.findFirst({
      where: { entityId: ids.leaver, action: 'user.self_delete' },
    });
    expect(audit).toMatchObject({ actorType: 'USER', actorId: ids.leaver });

    // Every session is gone, and the account can't sign in or be found.
    await http().get('/api/v1/me').set(as('leaver')).expect(401);
    await http().get('/api/v1/me').set('authorization', bearer(otherDevice)).expect(401);
    await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: otherDevice.refreshToken })
      .expect(401);
    await http()
      .post('/api/v1/auth/login')
      .send({ email: email('leaver'), password: TEST_PASSWORD })
      .expect(401);
    await http().get(`/api/v1/users/${prefix}_leaver`).set(as('friend')).expect(404);

    // The email can be used for a new account.
    await http()
      .post('/api/v1/auth/register')
      .send({
        email: email('leaver'),
        username: `${prefix}_again`,
        displayName: 'Again',
        password: TEST_PASSWORD,
      })
      .expect(202);
    const again = await prisma().user.findUniqueOrThrow({ where: { email: email('leaver') } });
    expect(again.id).not.toBe(ids.leaver);
    await prisma().analyticsEvent.deleteMany({ where: { actorKey: analytics.actorKey(again.id) } });
    await prisma().user.delete({ where: { id: again.id } });
  });

  it('asks password-less accounts for a recent sign-in instead', async () => {
    await prisma().user.update({ where: { id: ids.phoneOnly }, data: { passwordHash: null } });
    const status = dataOf(
      AccountDeletionStatusSchema,
      await http().get('/api/v1/me/deletion').set(as('phoneOnly')).expect(200),
    );
    expect(status.passwordRequired).toBe(false);
    // Make the sign-in look old.
    await prisma().authSession.updateMany({
      where: { userId: ids.phoneOnly },
      data: { createdAt: new Date(Date.now() - 60 * 60_000) },
    });
    const old = await http()
      .post('/api/v1/me/delete')
      .set(as('phoneOnly'))
      .send({ confirm: 'DELETE' })
      .expect(403);
    expect((old.body as { message: string }).message).toContain('Sign in again');
    await prisma().authSession.updateMany({
      where: { userId: ids.phoneOnly },
      data: { createdAt: new Date() },
    });
    await http()
      .post('/api/v1/me/delete')
      .set(as('phoneOnly'))
      .send({ confirm: 'DELETE' })
      .expect(204);
  });
});
