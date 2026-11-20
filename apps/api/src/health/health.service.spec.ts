import { type PrismaService } from '../database/prisma.service.js';
import { type RedisService } from '../redis/redis.service.js';
import { HealthService } from './health.service.js';

// Unit test of the status aggregation only. The real database and Redis
// are exercised by test/health.e2e-spec.ts.
function makeService(opts: { dbFails?: boolean; postgisRows?: number; redisUp?: boolean }) {
  const prisma = {
    $queryRaw: (strings: TemplateStringsArray) => {
      const sql = strings.join('');
      if (opts.dbFails) return Promise.reject(new Error('connection refused'));
      if (sql.includes('pg_extension')) {
        return Promise.resolve(
          Array.from({ length: opts.postgisRows ?? 1 }, () => ({ version: '3.5' })),
        );
      }
      return Promise.resolve([{ '?column?': 1 }]);
    },
  } as unknown as PrismaService;
  const redis = { ping: () => Promise.resolve(opts.redisUp ?? true) } as unknown as RedisService;
  return new HealthService(prisma, redis);
}

describe('HealthService', () => {
  it('reports ok when every dependency is up', async () => {
    const result = await makeService({}).check();
    expect(result.status).toBe('ok');
    expect(result.checks).toEqual({ database: 'up', postgis: 'up', redis: 'up' });
  });

  it('reports degraded when the database is unreachable', async () => {
    const result = await makeService({ dbFails: true }).check();
    expect(result.status).toBe('degraded');
    expect(result.checks.database).toBe('down');
  });

  it('reports PostGIS down when the extension is missing', async () => {
    const result = await makeService({ postgisRows: 0 }).check();
    expect(result.checks.postgis).toBe('down');
    expect(result.status).toBe('degraded');
  });

  it('reports degraded when Redis does not answer', async () => {
    const result = await makeService({ redisUp: false }).check();
    expect(result.checks.redis).toBe('down');
  });
});
