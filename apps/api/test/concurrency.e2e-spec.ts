import 'reflect-metadata';
import 'dotenv/config';
import { type INestApplication } from '@nestjs/common';
import { type AuthTokens, TripSchema } from '@voyago/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { type z } from 'zod';
import { PrismaService } from '../src/database/prisma.service.js';
import { bearer, registerAndLogin, startAuthApp, TEST_PASSWORD } from './support/auth-helpers.js';

/**
 * Races that real traffic produces: the same request twice from a flaky network, and many
 * members going for the last place at once. The database decides; nothing is double-counted.
 */
const prefix = `cc_${randomUUID().slice(0, 6)}`;
const dataOf = <T>(schema: z.ZodType<T>, res: { body: unknown }) =>
  schema.parse((res.body as { data: unknown }).data);

describe('concurrency (e2e)', () => {
  let app: INestApplication<App>;
  const created: string[] = [];
  const http = () => request(app.getHttpServer());
  const prisma = () => app.get(PrismaService);

  const member = async (name: string) => {
    const email = `${prefix}_${name}@example.test`;
    const tokens = await registerAndLogin(app, { email, username: `${prefix}_${name}` });
    const { id } = await prisma().user.findUniqueOrThrow({ where: { email } });
    created.push(id);
    return { tokens, id, email };
  };

  beforeAll(async () => {
    app = await startAuthApp();
  });

  afterAll(async () => {
    await prisma().trip.deleteMany({ where: { organiserId: { in: created } } });
    await prisma().user.deleteMany({ where: { id: { in: created } } });
    await app?.close();
  });

  it('fills the last places of an open trip exactly, with ten members joining at once', async () => {
    const organiser = await member('org');
    const trip = dataOf(
      TripSchema,
      await http()
        .post('/api/v1/trips')
        .set('authorization', bearer(organiser.tokens))
        .send({
          mode: 'TRAVEL',
          activityType: 'ROAD_TRIP',
          title: 'Race for the last seats',
          origin: { name: 'Indiranagar', point: { latitude: 12.9719, longitude: 77.6412 } },
          destination: { name: 'Coorg', point: { latitude: 12.4244, longitude: 75.7382 } },
          departureAt: new Date(Date.now() + 96 * 3_600_000).toISOString(),
          maxParticipants: 4,
          approvalRequired: false,
          visibility: 'PUBLIC',
        })
        .expect(201),
    );
    await http()
      .post(`/api/v1/trips/${trip.id}/publish`)
      .set('authorization', bearer(organiser.tokens))
      .expect(200);

    const joiners: AuthTokens[] = [];
    for (let i = 0; i < 10; i += 1) joiners.push((await member(`j${i}`)).tokens);
    const results = await Promise.all(
      joiners.map((tokens) =>
        http()
          .post(`/api/v1/trips/${trip.id}/join-requests`)
          .set('authorization', bearer(tokens))
          .send({}),
      ),
    );
    const statuses = results.map((r) => r.status);
    // Organiser plus three: exactly three got in, the rest were told it is full.
    expect(statuses.filter((s) => s === 201)).toHaveLength(3);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    const onTrip = await prisma().tripParticipant.count({
      where: { tripId: trip.id, status: 'ACTIVE' },
    });
    expect(onTrip).toBe(4);
    const stored = await prisma().trip.findUniqueOrThrow({ where: { id: trip.id } });
    expect(stored.status).toBe('FULL');
    // The count discovery reads, kept by a trigger, agrees with the rows.
    expect(stored.participantCount).toBe(4);
  });

  it('lets only one of two parallel refreshes with the same token through', async () => {
    const { tokens } = await member('refresh');
    const [a, b] = await Promise.all([
      http().post('/api/v1/auth/refresh').send({ refreshToken: tokens.refreshToken }),
      http().post('/api/v1/auth/refresh').send({ refreshToken: tokens.refreshToken }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
  });

  it('creates one account when the same username is registered twice at once', async () => {
    const username = `${prefix}_dupe`;
    const results = await Promise.all(
      ['one', 'two'].map((n) =>
        http()
          .post('/api/v1/auth/register')
          .send({
            email: `${prefix}_${n}@example.test`,
            username,
            displayName: 'Dupe',
            password: TEST_PASSWORD,
          }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    const users = await prisma().user.findMany({ where: { username } });
    expect(users).toHaveLength(1);
    created.push(users[0]!.id);
  });

  it('deletes an account once when the request is sent twice', async () => {
    const { tokens, id } = await member('twice');
    const results = await Promise.all(
      [1, 2].map(() =>
        http()
          .post('/api/v1/me/delete')
          .set('authorization', bearer(tokens))
          .send({ confirm: 'DELETE', password: TEST_PASSWORD }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses[0]).toBe(204);
    expect([401, 409]).toContain(statuses[1]);
    const audits = await prisma().auditLog.count({
      where: { entityId: id, action: 'user.self_delete' },
    });
    expect(audits).toBe(1);
  });
});
