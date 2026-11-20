import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { ApiErrorSchema, HealthResponseSchema } from '@voyago/shared';
import 'dotenv/config';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { createApp } from '../src/bootstrap.js';
import { validateEnv } from '../src/config/env.schema.js';

/**
 * Smoke test: boots the real API against the Docker Postgres/PostGIS and Redis
 * services and proves the health endpoint and error format work end to end.
 */
describe('API smoke test (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const config = validateEnv({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    app = (await createApp(config)) as INestApplication<App>;
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /api/v1/health reports database, PostGIS and Redis as up', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    const body = HealthResponseSchema.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({ database: 'up', postgis: 'up', redis: 'up' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('returns the shared error shape for unknown routes', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/does-not-exist')
      .set('x-request-id', 'smoke-test-1')
      .expect(404);
    const body = ApiErrorSchema.parse(res.body);
    expect(body).toMatchObject({ statusCode: 404, error: 'Not Found', requestId: 'smoke-test-1' });
  });

  it('sets security headers', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('serves the OpenAPI document', async () => {
    await request(app.getHttpServer()).get('/api/docs-json').expect(200);
  });
});
