import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaClient } from '../generated/prisma/client.js';

const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Prisma client for the whole app. Startup does not fail if the database is briefly
 * unavailable: the error is logged, the readiness probe reports `database: down`, and
 * queries reconnect through the pg pool once the database is back.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({
      adapter: new PrismaPg({
        connectionString: config.DATABASE_URL,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      await this.$queryRaw`SELECT 1`;
      this.logger.log('Connected to PostgreSQL');
    } catch (error) {
      this.logger.warn(`PostgreSQL unavailable at startup: ${(error as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
