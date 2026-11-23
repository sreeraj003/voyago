import { Injectable, Logger } from '@nestjs/common';
import { type ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { RedisService } from '../redis/redis.service.js';

/** Counts a hit in a fixed window and starts a block once the limit is passed, atomically. */
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

const HIT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
local block = redis.call('PTTL', KEYS[2])
if block < 0 and hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  block = tonumber(ARGV[3])
end
return {hits, ttl, block}
`;

/**
 * Rate-limit counters in Redis, so every API instance shares one limit per client. If Redis is
 * unavailable, limits fall back to this process's memory rather than failing open or closed.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly fallback = new ThrottlerStorageService();

  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    if (this.redis.isReady) {
      try {
        const base = `throttle:${throttlerName}:${key}`;
        const [hits, ttlMs, blockMs] = (await this.redis.client.eval(
          HIT_SCRIPT,
          2,
          base,
          `${base}:blocked`,
          String(ttl),
          String(limit),
          String(Math.max(blockDuration, 1)),
        )) as [number, number, number];
        return {
          totalHits: hits,
          timeToExpire: Math.max(0, Math.ceil(ttlMs / 1000)),
          isBlocked: blockMs > 0,
          timeToBlockExpire: Math.max(0, Math.ceil(blockMs / 1000)),
        };
      } catch (error) {
        this.logger.warn(`Rate limit store unavailable: ${(error as Error).message}`);
      }
    }
    return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
  }
}
