import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import {
  type HealthResponse,
  HealthResponseSchema,
  type LivenessResponse,
  LivenessResponseSchema,
} from '@voyago/shared';
import type { Response } from 'express';
import { Public } from '../common/auth/public.decorator.js';
import { toOpenApiSchema } from '../common/openapi/zod-openapi.js';
import { HealthService } from './health.service.js';

const readinessSchema = toOpenApiSchema(HealthResponseSchema);

/** Probes for load balancers, orchestrators and the apps. Public and not rate limited. */
@ApiTags('health')
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness: the process is up. Never checks dependencies.' })
  @ApiResponse({ status: 200, schema: toOpenApiSchema(LivenessResponseSchema) })
  live(): LivenessResponse {
    return this.health.live();
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness: PostgreSQL, PostGIS and Redis are reachable.' })
  @ApiResponse({ status: 200, description: 'Ready to serve traffic', schema: readinessSchema })
  @ApiResponse({ status: 503, description: 'A dependency is down', schema: readinessSchema })
  ready(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    return this.readiness(res);
  }

  @Get()
  @ApiOperation({ summary: 'Alias of /health/ready (used by the mobile and admin apps).' })
  @ApiResponse({ status: 200, schema: readinessSchema })
  @ApiResponse({ status: 503, schema: readinessSchema })
  summary(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    return this.readiness(res);
  }

  private async readiness(res: Response): Promise<HealthResponse> {
    const result = await this.health.check();
    res.status(result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}
