import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Post,
  Query,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { ClientErrorSchema, MetricsQuerySchema } from '@voyago/shared';
import { type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { PermissionGuard, RequirePermission } from '../admin/permissions.js';
import { Public } from '../common/auth/public.decorator.js';
import { ApiErrorResponses } from '../common/openapi/zod-openapi.js';
import { createZodDto } from '../common/validation/zod-dto.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { RedisService } from '../redis/redis.service.js';
import { BusinessMetricsService } from './business-metrics.service.js';
import { MetricsRegistry } from './metrics.registry.js';
import { scrub } from './scrub.js';
import { clientErrorKey, SystemStatusService } from './system-status.service.js';

class ClientErrorDto extends createZodDto(ClientErrorSchema) {}
class MetricsQueryDto extends createZodDto(MetricsQuerySchema) {}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Prometheus scraping and crash reports from the apps. */
@ApiTags('observability')
@Controller()
export class ObservabilityController {
  private readonly logger = new Logger('ClientError');

  constructor(
    private readonly metrics: MetricsRegistry,
    private readonly status: SystemStatusService,
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Prometheus text format. Needs `Authorization: Bearer METRICS_TOKEN`; 404 when unset. */
  @Get('metrics')
  @Public()
  @SkipThrottle()
  @ApiExcludeEndpoint()
  async scrape(@Headers('authorization') auth: string | undefined, @Res() res: Response) {
    if (!this.config.METRICS_TOKEN) throw new NotFoundException();
    if (!auth || !sameSecret(auth, `Bearer ${this.config.METRICS_TOKEN}`)) {
      throw new UnauthorizedException('Metrics token required');
    }
    // Refreshes the dependency, webhook and moderation gauges.
    await this.status.status();
    res.type('text/plain; version=0.0.4').send(this.metrics.render());
  }

  @Post('client-errors')
  @Public()
  @HttpCode(204)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiOperation({
    summary:
      'Crash and error reports from the apps: no account, no personal data (text is scrubbed again on arrival)',
  })
  @ApiErrorResponses(400, 429)
  async clientError(@Body() body: ClientErrorDto) {
    const platform = body.platform;
    this.metrics.inc(
      'client_errors_total',
      { platform, fatal: String(body.fatal) },
      1,
      'App crash and error reports',
    );
    this.logger.warn(
      {
        clientError: {
          platform,
          appVersion: scrub(body.appVersion),
          fatal: body.fatal,
          route: body.route ? scrub(body.route) : undefined,
          message: scrub(body.message),
          stack: body.stack ? scrub(body.stack).split('\n').slice(0, 30).join('\n') : undefined,
        },
      },
      'App error reported',
    );
    if (this.redis.isReady) {
      const key = clientErrorKey(new Date());
      await this.redis.client
        .multi()
        .incr(key)
        .expire(key, 26 * 3600)
        .exec()
        .catch(() => undefined);
    }
  }
}

/** Business metrics and system status for staff. */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(PermissionGuard)
@ApiErrorResponses(401, 403)
@Controller('admin')
export class AdminMetricsController {
  constructor(
    private readonly business: BusinessMetricsService,
    private readonly status: SystemStatusService,
  ) {}

  @Get('metrics')
  @RequirePermission('metrics.read')
  @ApiOperation({
    summary:
      'Growth, engagement, trips and revenue for the last `days` (aggregates only; definitions in docs/ANALYTICS.md)',
  })
  async metrics(@Query() query: MetricsQueryDto) {
    return { data: await this.business.metrics(query.days) };
  }

  @Get('system')
  @RequirePermission('system.read')
  @ApiOperation({
    summary:
      'Dependencies, request latency, background jobs, payment webhook and moderation backlogs',
  })
  async system() {
    return { data: await this.status.status() };
  }
}
