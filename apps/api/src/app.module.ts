import { type DynamicModule, Module, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module.js';
import { ChatModule } from './chat/chat.module.js';
import { RealtimeModule } from './chat/realtime.service.js';
import { AuthGuard } from './common/auth/auth.guard.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { ZodValidationPipe } from './common/pipes/zod-validation.pipe.js';
import { resolveRequestId } from './common/request-id.js';
import { type AppConfig } from './config/app-config.js';
import { ConfigModule } from './config/config.module.js';
import { PrismaModule } from './database/prisma.module.js';
import { HealthModule } from './health/health.module.js';
import { IntegrationsModule } from './integrations/integrations.module.js';
import { RedisModule } from './redis/redis.module.js';
import { SocialModule } from './social/social.module.js';
import { CommunitiesModule } from './communities/communities.module.js';
import { DiscoveryModule } from './discovery/discovery.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { ParticipationModule } from './participation/participation.module.js';
import { PostsModule } from './posts/posts.module.js';
import { TripsModule } from './trips/trips.module.js';
import { UsersModule } from './users/users.module.js';

/** Fields that must never reach the logs. */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.idToken',
  '*.signupToken',
  '*.code',
  '*.currentPassword',
  '*.newPassword',
  '*.otp',
  '*.phone',
  '*.email',
  '*.latitude',
  '*.longitude',
];

/**
 * Root module. Domain modules (auth, users, trips, ...) are added here
 * one milestone at a time; each owns its own tables and services.
 */
@Module({})
export class AppModule {
  /** `extraModules` lets integration tests mount test-only controllers on the real app. */
  static forRoot(config: AppConfig, extraModules: Type[] = []): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggerModule.forRoot({
          pinoHttp: {
            level: config.LOG_LEVEL,
            genReqId: resolveRequestId,
            redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
            // Log the path only: query strings can carry search terms or coordinates.
            serializers: {
              req: (req: { id: unknown; method: string; url: string }) => ({
                id: req.id,
                method: req.method,
                path: req.url.split('?')[0],
              }),
              res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
            },
            autoLogging: { ignore: (req) => req.url?.startsWith('/api/v1/health') ?? false },
            ...(config.NODE_ENV === 'development'
              ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
              : {}),
          },
        }),
        ThrottlerModule.forRoot([
          { ttl: config.RATE_LIMIT_TTL_SECONDS * 1000, limit: config.RATE_LIMIT_MAX },
        ]),
        PrismaModule,
        RedisModule,
        HealthModule,
        IntegrationsModule,
        NotificationsModule,
        AuthModule,
        UsersModule,
        TripsModule,
        DiscoveryModule,
        ParticipationModule,
        SocialModule,
        PostsModule,
        CommunitiesModule,
        RealtimeModule,
        ChatModule,
        ...extraModules,
      ],
      providers: [
        // Guards run in this order: rate limit first, then authentication.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_PIPE, useValue: new ZodValidationPipe() },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }
}
