import 'reflect-metadata';
import 'dotenv/config';
import { type INestApplication } from '@nestjs/common';
import {
  ApiErrorSchema,
  HealthResponseSchema,
  LivenessResponseSchema,
  PageInfoSchema,
  type PageResponse,
} from '@voyago/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { createApp } from '../src/bootstrap.js';
import { validateEnv } from '../src/config/env.schema.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { TestRoutesModule } from './support/test-routes.module.js';

/**
 * Integration tests for the API conventions (milestone 03) against the real
 * Postgres/PostGIS and Redis services. Rows created here are deleted afterwards.
 */
const baseEnv = { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' };

async function startApp(overrides: Record<string, string> = {}) {
  const app = (await createApp(validateEnv({ ...baseEnv, ...overrides }), {
    extraModules: [TestRoutesModule],
  })) as INestApplication<App>;
  await app.init();
  return app;
}

/** Readiness right after boot can race Redis's first connect; poll briefly. */
async function waitForReady(app: INestApplication<App>) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await request(app.getHttpServer()).get('/api/v1/health/ready');
    if (res.status === 200) return res;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return request(app.getHttpServer()).get('/api/v1/health/ready');
}

const expectApiError = (body: unknown, statusCode: number) => {
  const error = ApiErrorSchema.parse(body);
  expect(error.statusCode).toBe(statusCode);
  expect(error.requestId).toBeTruthy();
  return error;
};

describe('API foundation (e2e)', () => {
  let app: INestApplication<App>;
  const prefix = `it_${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    app = await startApp();
  });

  afterAll(async () => {
    await app.get(PrismaService).user.deleteMany({ where: { username: { startsWith: prefix } } });
    await app?.close();
  });

  describe('health', () => {
    it('reports liveness without touching dependencies', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
      expect(LivenessResponseSchema.parse(res.body).status).toBe('ok');
    });

    it('reports readiness with database, PostGIS and Redis up', async () => {
      const res = await waitForReady(app);
      expect(res.status).toBe(200);
      expect(HealthResponseSchema.parse(res.body).checks).toEqual({
        database: 'up',
        postgis: 'up',
        redis: 'up',
      });
    });
  });

  describe('validation', () => {
    it('accepts a valid body and strips unknown fields', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/_test/echo')
        .send({ title: 'Nandi Hills', count: 2, role: 'ADMIN' })
        .expect(201);
      expect(res.body).toEqual({ data: { title: 'Nandi Hills', count: 2 } });
    });

    it('rejects an invalid body with field details', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/_test/echo')
        .send({ title: 'x', count: 1.5 })
        .expect(400);
      const error = expectApiError(res.body, 400);
      expect(error.details?.map((d) => d.path).sort()).toEqual(['count', 'title']);
    });

    it('rejects an invalid UUID path parameter', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/_test/items/123').expect(400);
      expect(expectApiError(res.body, 400).details?.[0]?.path).toBe('id');
      await request(app.getHttpServer()).get(`/api/v1/_test/items/${randomUUID()}`).expect(200);
    });

    it('rejects invalid query parameters', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/_test/users')
        .query({ prefix, limit: 1000 })
        .expect(400);
      expect(expectApiError(res.body, 400).details?.[0]?.path).toBe('limit');
    });

    it('rejects malformed JSON with 400 and oversized bodies with 413', async () => {
      const malformed = await request(app.getHttpServer())
        .post('/api/v1/_test/echo')
        .set('content-type', 'application/json')
        .send('{"title": ')
        .expect(400);
      expect(expectApiError(malformed.body, 400).message).toBe('Request body is not valid JSON.');

      const huge = await request(app.getHttpServer())
        .post('/api/v1/_test/echo')
        .send({ title: 'x'.repeat(200_000) })
        .expect(413);
      expectApiError(huge.body, 413);
    });
  });

  describe('errors never leak internals', () => {
    it('returns 409 for a duplicate without database details', async () => {
      const username = `${prefix}_dup`;
      await request(app.getHttpServer())
        .post('/api/v1/_test/users')
        .send({ username, displayName: 'Dup' })
        .expect(201);
      const res = await request(app.getHttpServer())
        .post('/api/v1/_test/users')
        .send({ username: username.toUpperCase(), displayName: 'Dup' })
        .expect(409);
      expectApiError(res.body, 409);
      expect(JSON.stringify(res.body)).not.toMatch(
        /users_username_key|constraint|prisma|postgres/i,
      );
    });

    it('returns 422 when a data rule (CHECK constraint) is broken', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/v1/_test/users')
        .send({ username: `${prefix}_self`, displayName: 'Self' })
        .expect(201);
      const id = (created.body as { data: { id: string } }).data.id;
      const res = await request(app.getHttpServer())
        .post(`/api/v1/_test/users/${id}/follow-self`)
        .expect(422);
      expectApiError(res.body, 422);
      expect(JSON.stringify(res.body)).not.toContain('follows_not_self');
    });

    it('returns 404 in the shared shape for unknown routes', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);
      expectApiError(res.body, 404);
    });
  });

  describe('authentication foundation', () => {
    it('rejects routes not marked @Public() with 401', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/_test/private').expect(401);
      expect(expectApiError(res.body, 401).message).toBe('Authentication required');
    });
  });

  describe('cursor pagination', () => {
    it('pages through results with an opaque cursor', async () => {
      for (const n of [1, 2, 3]) {
        await request(app.getHttpServer())
          .post('/api/v1/_test/users')
          .send({ username: `${prefix}_page${n}`, displayName: `Page ${n}` })
          .expect(201);
      }
      const pagePrefix = `${prefix}_page`;
      type UserPage = PageResponse<{ username: string }>;
      const first = await request(app.getHttpServer())
        .get('/api/v1/_test/users')
        .query({ prefix: pagePrefix, limit: 2 })
        .expect(200);
      const firstBody = first.body as UserPage;
      const firstPage = PageInfoSchema.parse(firstBody.page);
      expect(firstBody.data).toHaveLength(2);
      expect(firstPage.hasMore).toBe(true);

      const second = await request(app.getHttpServer())
        .get('/api/v1/_test/users')
        .query({ prefix: pagePrefix, limit: 2, cursor: firstPage.nextCursor })
        .expect(200);
      const secondBody = second.body as UserPage;
      expect(secondBody.data).toHaveLength(1);
      expect(secondBody.page).toEqual({ hasMore: false, nextCursor: null });

      const names = [...firstBody.data, ...secondBody.data].map((u) => u.username);
      expect(new Set(names).size).toBe(3);

      await request(app.getHttpServer())
        .get('/api/v1/_test/users')
        .query({ prefix: pagePrefix, cursor: 'bm90LWEtY3Vyc29y' })
        .expect(400);
    });
  });

  describe('Swagger', () => {
    it('documents the health endpoints and Zod DTOs', async () => {
      const res = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
      const doc = res.body as {
        paths: Record<string, unknown>;
        components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
      };
      expect(Object.keys(doc.paths)).toEqual(
        expect.arrayContaining(['/api/v1/health', '/api/v1/health/live', '/api/v1/health/ready']),
      );
      expect(doc.components.schemas.EchoDto?.properties).toHaveProperty('title');
      await request(app.getHttpServer()).get('/api/docs').expect(200);
    });
  });
});

describe('rate limiting (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await startApp({ RATE_LIMIT_MAX: '3', RATE_LIMIT_TTL_SECONDS: '60' });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns 429 after the limit and never limits health probes', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer())
        .post('/api/v1/_test/echo')
        .send({ title: 'abc' })
        .expect(201);
    }
    const res = await request(app.getHttpServer())
      .post('/api/v1/_test/echo')
      .send({ title: 'abc' })
      .expect(429);
    expectApiError(res.body, 429);
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
    }
  });
});

describe('startup with dependencies down (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    // Nothing listens on port 1: both dependencies are unreachable.
    app = await startApp({
      DATABASE_URL: 'postgresql://voyago:wrong@127.0.0.1:1/voyago',
      REDIS_URL: 'redis://127.0.0.1:1',
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('still starts, stays live and reports not ready', async () => {
    await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
    const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
    const body = HealthResponseSchema.parse(res.body);
    expect(body.status).toBe('degraded');
    expect(body.checks).toEqual({ database: 'down', postgis: 'down', redis: 'down' });
  });
});
