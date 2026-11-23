import { Injectable, type NestMiddleware } from '@nestjs/common';
import { type NextFunction, type Request, type Response } from 'express';
import { MetricsRegistry } from './metrics.registry.js';

/**
 * Times every request and records it by route pattern (`/api/v1/trips/:id`, never the filled-in
 * path), so metrics carry no ids or search text. Unmatched paths are grouped as `unmatched`.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsRegistry) {}

  use(req: Request, res: Response, next: NextFunction) {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const route = (req.route as { path?: string } | undefined)?.path;
      const pattern = route ? `${req.baseUrl}${route}` : 'unmatched';
      if (pattern.includes('/health') || /^\/[^/]+\/v\d+\/metrics$/.test(pattern)) return;
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      this.metrics.observeHttp(req.method, pattern, res.statusCode, seconds);
    });
    next();
  }
}
