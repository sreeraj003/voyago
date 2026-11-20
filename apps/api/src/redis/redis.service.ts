import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

const MAX_RETRY_DELAY_MS = 5_000;
const STARTUP_WAIT_MS = 2_000;

/**
 * Shared Redis connection for cache, rate limits, presence and (later) live location.
 *
 * Graceful handling: the app starts even if Redis is down. ioredis keeps reconnecting with
 * capped backoff; while disconnected, commands fail fast (no offline queue) instead of hanging,
 * and the readiness probe reports `redis: down`.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;
  private lastError: string | undefined;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 5_000,
      retryStrategy: (attempt) => Math.min(attempt * 200, MAX_RETRY_DELAY_MS),
    });
    this.client.on('ready', () => {
      this.lastError = undefined;
      this.logger.log('Connected to Redis');
    });
    this.client.on('error', (error: Error) => {
      // Log each distinct failure once rather than on every retry.
      if (error.message !== this.lastError) {
        this.lastError = error.message;
        this.logger.warn(`Redis connection error: ${error.message}`);
      }
    });
  }

  /** Waits briefly for the first connection so the app is usually ready at boot, but never blocks startup. */
  async onModuleInit(): Promise<void> {
    const connecting = this.client.connect().catch(() => {
      // Reported through the 'error' event; ioredis keeps retrying in the background.
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, STARTUP_WAIT_MS);
    });
    await Promise.race([connecting, timeout]);
    clearTimeout(timer);
  }

  get isReady(): boolean {
    return this.client.status === 'ready';
  }

  async ping(): Promise<boolean> {
    if (!this.isReady) return false;
    return (await this.client.ping()) === 'PONG';
  }

  async onModuleDestroy(): Promise<void> {
    if (this.isReady) {
      await this.client.quit();
    } else {
      this.client.disconnect();
    }
  }
}
