import { Logger } from '@nestjs/common';
import { type AppConfig } from '../../config/app-config.js';
import { type HttpFetch, PROVIDER_TIMEOUT_MS } from '../../integrations/http-fetch.js';

export const PUSH_SENDER = Symbol('PUSH_SENDER');

export interface PushMessage {
  /** An Expo push token. */
  to: string;
  title: string;
  body?: string | undefined;
  /** Ids for navigation only. */
  data: Record<string, string>;
}

/** Per message, in order: sent, or the token is no longer valid and should be forgotten. */
export type PushOutcome = 'sent' | 'invalid_token' | 'failed';

export interface PushSender {
  readonly enabled: boolean;
  send(messages: PushMessage[]): Promise<PushOutcome[]>;
}

export class DisabledPushSender implements PushSender {
  readonly enabled = false;
  send(messages: PushMessage[]): Promise<PushOutcome[]> {
    return Promise.resolve(messages.map(() => 'failed' as const));
  }
}

/** Development and test only: keeps pushes in memory and logs them. Refused in production. */
export class DevPushSender implements PushSender {
  readonly enabled = true;
  private readonly logger = new Logger('DevPushSender');
  readonly outbox: PushMessage[] = [];

  constructor(private readonly nodeEnv: AppConfig['NODE_ENV']) {
    if (nodeEnv === 'production') {
      throw new Error('The development push adapter cannot be used in production');
    }
  }

  send(messages: PushMessage[]): Promise<PushOutcome[]> {
    this.outbox.push(...messages);
    if (this.outbox.length > 500) this.outbox.splice(0, this.outbox.length - 500);
    if (this.nodeEnv === 'development') {
      for (const m of messages) this.logger.warn(`[dev push] ${m.title}: ${m.body ?? ''}`);
    }
    return Promise.resolve(messages.map(() => 'sent' as const));
  }
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** Expo accepts at most 100 messages per request. */
const EXPO_BATCH = 100;

interface ExpoTicket {
  status?: 'ok' | 'error';
  details?: { error?: string };
}

/**
 * Expo push service. Expo forwards to FCM and APNs with the credentials stored in the Expo
 * project, so the server needs no Google or Apple keys of its own.
 */
export class ExpoPushSender implements PushSender {
  readonly enabled = true;
  private readonly logger = new Logger('ExpoPushSender');

  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: HttpFetch = fetch,
  ) {}

  async send(messages: PushMessage[]): Promise<PushOutcome[]> {
    const outcomes: PushOutcome[] = [];
    for (let i = 0; i < messages.length; i += EXPO_BATCH) {
      outcomes.push(...(await this.sendBatch(messages.slice(i, i + EXPO_BATCH))));
    }
    return outcomes;
  }

  private async sendBatch(batch: PushMessage[]): Promise<PushOutcome[]> {
    const failed = batch.map(() => 'failed' as const);
    try {
      const res = await this.fetchImpl(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: JSON.stringify(
          batch.map((m) => ({
            to: m.to,
            title: m.title,
            body: m.body,
            data: m.data,
            sound: 'default',
            priority: 'high',
          })),
        ),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(`Expo push responded ${res.status}`);
        return failed;
      }
      const { data } = (await res.json()) as { data?: ExpoTicket[] };
      return batch.map((_, index) => {
        const ticket = data?.[index];
        if (ticket?.status === 'ok') return 'sent';
        return ticket?.details?.error === 'DeviceNotRegistered' ? 'invalid_token' : 'failed';
      });
    } catch (error) {
      this.logger.warn(`Expo push failed: ${(error as Error).message}`);
      return failed;
    }
  }
}

export function createPushSender(
  config: Pick<AppConfig, 'PUSH_PROVIDER' | 'EXPO_ACCESS_TOKEN' | 'NODE_ENV'>,
  fetchImpl: HttpFetch = fetch,
): PushSender {
  switch (config.PUSH_PROVIDER) {
    case 'dev':
      return new DevPushSender(config.NODE_ENV);
    case 'expo':
      return new ExpoPushSender(config.EXPO_ACCESS_TOKEN, fetchImpl);
    case 'none':
      return new DisabledPushSender();
  }
}
