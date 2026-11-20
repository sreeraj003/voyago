import { Logger } from '@nestjs/common';
import { type AppConfig } from '../../config/app-config.js';

export const SMS_SENDER = Symbol('SMS_SENDER');

/** Sends text messages. Real providers (e.g. MSG91, Twilio) implement this once credentials exist. */
export interface SmsSender {
  /** False when no provider is configured: phone sign-in then returns 503 instead of pretending. */
  readonly enabled: boolean;
  send(to: string, body: string): Promise<void>;
}

export class DisabledSmsSender implements SmsSender {
  readonly enabled = false;
  send(): Promise<void> {
    return Promise.reject(new Error('No SMS provider is configured'));
  }
}

/**
 * Development and test only. Keeps recent messages in memory (for tests) and logs them in
 * development. Refuses to exist in production, in addition to the env validation check.
 */
export class DevSmsSender implements SmsSender {
  readonly enabled = true;
  private readonly logger = new Logger('DevSmsSender');
  private readonly outbox = new Map<string, string>();

  constructor(private readonly nodeEnv: AppConfig['NODE_ENV']) {
    if (nodeEnv === 'production') {
      throw new Error('The development SMS adapter cannot be used in production');
    }
  }

  send(to: string, body: string): Promise<void> {
    this.outbox.set(to, body);
    if (this.nodeEnv === 'development') this.logger.warn(`[dev SMS to ${to}] ${body}`);
    return Promise.resolve();
  }

  /** Test helper: the last message sent to a number. */
  lastMessageTo(phone: string): string | undefined {
    return this.outbox.get(phone);
  }
}

export function createSmsSender(config: AppConfig): SmsSender {
  return config.SMS_PROVIDER === 'dev'
    ? new DevSmsSender(config.NODE_ENV)
    : new DisabledSmsSender();
}
