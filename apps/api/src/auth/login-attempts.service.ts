import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';
import { sha256Hex } from './crypto.js';

const MAX_FAILURES = 10;
const WINDOW_SECONDS = 15 * 60;

/**
 * Limits failed password attempts per account (in addition to the per-IP route limit), so a
 * distributed guessing attack on one account is slowed down. Keys hold a hash, not the email.
 * If Redis is unavailable the check is skipped (per-IP limits still apply) and a warning logged.
 */
@Injectable()
export class LoginAttemptsService {
  private readonly logger = new Logger(LoginAttemptsService.name);

  constructor(private readonly redis: RedisService) {}

  async assertNotLocked(email: string): Promise<void> {
    const failures = await this.run(() => this.redis.client.get(this.key(email)));
    if (failures !== null && Number(failures) >= MAX_FAILURES) {
      throw new HttpException(
        'Too many failed attempts. Try again in 15 minutes or reset your password.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async recordFailure(email: string): Promise<void> {
    const key = this.key(email);
    await this.run(() =>
      this.redis.client.multi().incr(key).expire(key, WINDOW_SECONDS, 'NX').exec(),
    );
  }

  async reset(email: string): Promise<void> {
    await this.run(() => this.redis.client.del(this.key(email)));
  }

  private key(email: string): string {
    return `auth:login-failures:${sha256Hex(email.toLowerCase())}`;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T | null> {
    if (!this.redis.isReady) {
      this.logger.warn('Redis unavailable: per-account login limit skipped');
      return null;
    }
    try {
      return await operation();
    } catch (error) {
      this.logger.warn(`Login attempt tracking failed: ${(error as Error).message}`);
      return null;
    }
  }
}
