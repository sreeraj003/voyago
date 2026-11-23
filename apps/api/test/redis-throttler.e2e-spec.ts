import 'reflect-metadata';
import 'dotenv/config';
import { type INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { type App } from 'supertest/types.js';
import { RedisThrottlerStorage } from '../src/common/redis-throttler.storage.js';
import { RedisService } from '../src/redis/redis.service.js';
import { startAuthApp } from './support/auth-helpers.js';

/** Rate limits shared across API instances through Redis. */
describe('Redis rate-limit storage (e2e)', () => {
  let app: INestApplication<App>;
  let redis: RedisService;

  beforeAll(async () => {
    app = await startAuthApp();
    redis = app.get(RedisService);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('shares one count between instances and blocks past the limit', async () => {
    const key = `test-${randomUUID()}`;
    const one = new RedisThrottlerStorage(redis);
    const two = new RedisThrottlerStorage(redis);
    const hits = [];
    for (let i = 0; i < 3; i += 1)
      hits.push(await one.increment(key, 60_000, 4, 60_000, 'default'));
    hits.push(await two.increment(key, 60_000, 4, 60_000, 'default'));
    expect(hits.map((h) => h.totalHits)).toEqual([1, 2, 3, 4]);
    expect(hits.every((h) => !h.isBlocked)).toBe(true);
    expect(hits[0]!.timeToExpire).toBeGreaterThan(50);

    const fifth = await two.increment(key, 60_000, 4, 30_000, 'default');
    expect(fifth).toMatchObject({ totalHits: 5, isBlocked: true });
    expect(fifth.timeToBlockExpire).toBeGreaterThan(25);
    await redis.client.del(`throttle:default:${key}`, `throttle:default:${key}:blocked`);
  });

  it('counts each window afresh', async () => {
    const key = `test-${randomUUID()}`;
    const store = new RedisThrottlerStorage(redis);
    await store.increment(key, 200, 10, 200, 'default');
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect((await store.increment(key, 200, 10, 200, 'default')).totalHits).toBe(1);
  });

  it('falls back to memory when Redis is not available', async () => {
    const offline = { isReady: false } as unknown as RedisService;
    const store = new RedisThrottlerStorage(offline);
    const key = `test-${randomUUID()}`;
    await store.increment(key, 60_000, 1, 60_000, 'default');
    const second = await store.increment(key, 60_000, 1, 60_000, 'default');
    expect(second).toMatchObject({ totalHits: 2, isBlocked: true });
  });
});
