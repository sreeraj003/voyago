import { Injectable, Logger } from '@nestjs/common';
import { type DependencyStatus, type HealthResponse, type LivenessResponse } from '@voyago/shared';
import { PrismaService } from '../database/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { APP_VERSION } from '../version.js';

const CHECK_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  live(): LivenessResponse {
    return {
      status: 'ok',
      version: APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  async check(): Promise<HealthResponse> {
    const [database, postgis, redis] = await Promise.all([
      this.probe('database', async () => {
        await this.prisma.$queryRaw`SELECT 1`;
        return true;
      }),
      this.probe('postgis', async () => {
        const rows = await this.prisma.$queryRaw<{ version: string }[]>`
          SELECT extversion AS version FROM pg_extension WHERE extname = 'postgis'`;
        return rows.length === 1;
      }),
      this.probe('redis', () => this.redis.ping()),
    ]);

    const allUp = database === 'up' && postgis === 'up' && redis === 'up';
    return {
      status: allUp ? 'ok' : 'degraded',
      version: APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      checks: { database, postgis, redis },
    };
  }

  private async probe(name: string, run: () => Promise<boolean>): Promise<DependencyStatus> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), CHECK_TIMEOUT_MS);
      });
      const ok = await Promise.race([run(), timeout]);
      return ok ? 'up' : 'down';
    } catch (error) {
      this.logger.warn(`Health check "${name}" failed: ${(error as Error).message}`);
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
