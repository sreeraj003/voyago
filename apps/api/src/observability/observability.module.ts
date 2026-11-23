import { Global, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { PermissionGuard } from '../admin/permissions.js';
import { AlertsService } from './alerts.service.js';
import { AnalyticsService } from './analytics.service.js';
import { BusinessMetricsService } from './business-metrics.service.js';
import { HttpMetricsMiddleware } from './http-metrics.middleware.js';
import { JobMonitor } from './job-monitor.service.js';
import { MetricsRegistry } from './metrics.registry.js';
import { AdminMetricsController, ObservabilityController } from './observability.controller.js';
import { RetentionService } from './retention.service.js';
import { SystemStatusService } from './system-status.service.js';

/**
 * Analytics, metrics, background-job monitoring, alerts and data retention (milestone 15).
 * Global so any module can record an event or run a monitored job.
 */
@Global()
@Module({
  controllers: [ObservabilityController, AdminMetricsController],
  providers: [
    PermissionGuard,
    MetricsRegistry,
    AlertsService,
    AnalyticsService,
    JobMonitor,
    RetentionService,
    BusinessMetricsService,
    SystemStatusService,
  ],
  exports: [MetricsRegistry, AlertsService, AnalyticsService, JobMonitor],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(HttpMetricsMiddleware).forRoutes('{*splat}');
  }
}
