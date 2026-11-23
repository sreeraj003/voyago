import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { HTTP_FETCH, type HttpFetch, PROVIDER_TIMEOUT_MS } from '../integrations/http-fetch.js';
import { MetricsRegistry } from './metrics.registry.js';

/** The same kind of alert is sent at most once in this window. */
const QUIET_MS = 15 * 60_000;

/**
 * Operational alerts: always logged and counted; also posted to ALERT_WEBHOOK_URL (Slack-style
 * `{ text }`) when it is set. Texts carry what failed and where, never personal data.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly lastSent = new Map<string, number>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(HTTP_FETCH) private readonly fetchImpl: HttpFetch,
    private readonly metrics: MetricsRegistry,
  ) {}

  /** Returns whether it went out (false while the same kind is quiet). */
  async raise(kind: string, text: string, now = Date.now()): Promise<boolean> {
    this.metrics.inc('alerts_total', { kind }, 1, 'Operational alerts raised');
    const last = this.lastSent.get(kind);
    if (last !== undefined && now - last < QUIET_MS) return false;
    this.lastSent.set(kind, now);
    this.logger.error({ alert: kind }, text);
    if (!this.config.ALERT_WEBHOOK_URL) return true;
    try {
      const res = await this.fetchImpl(this.config.ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `[Voyago ${this.config.NODE_ENV}] ${text}` }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      if (!res.ok) this.logger.warn(`Alert webhook answered ${res.status}`);
    } catch (error) {
      this.logger.warn(`Alert webhook failed: ${(error as Error).message}`);
    }
    return true;
  }
}
