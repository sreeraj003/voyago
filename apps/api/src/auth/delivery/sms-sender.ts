import { Logger } from '@nestjs/common';
import { type AppConfig } from '../../config/app-config.js';
import { type HttpFetch, PROVIDER_TIMEOUT_MS } from '../../integrations/http-fetch.js';

export const SMS_SENDER = Symbol('SMS_SENDER');

/** Template variables for providers that send registered templates (MSG91 in India). */
export interface SmsVariables {
  code?: string;
}

/** Sends text messages: Twilio or MSG91 in production, the dev adapter locally. */
export interface SmsSender {
  /** False when no provider is configured: phone sign-in then returns 503 instead of pretending. */
  readonly enabled: boolean;
  /** `to` is E.164 (+91…). */
  send(to: string, body: string, variables?: SmsVariables): Promise<void>;
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

/** Twilio Programmable Messaging. Uses a Messaging Service SID or a From number. */
export class TwilioSmsSender implements SmsSender {
  readonly enabled = true;

  constructor(
    private readonly config: Pick<
      AppConfig,
      'TWILIO_ACCOUNT_SID' | 'TWILIO_AUTH_TOKEN' | 'TWILIO_FROM' | 'TWILIO_MESSAGING_SERVICE_SID'
    >,
    private readonly fetchImpl: HttpFetch = fetch,
  ) {}

  async send(to: string, body: string): Promise<void> {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token } = this.config;
    const form = new URLSearchParams({ To: to, Body: body });
    if (this.config.TWILIO_MESSAGING_SERVICE_SID) {
      form.set('MessagingServiceSid', this.config.TWILIO_MESSAGING_SERVICE_SID);
    } else {
      form.set('From', this.config.TWILIO_FROM);
    }
    const res = await this.fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new Error(`Twilio responded ${res.status}`);
  }
}

/**
 * MSG91 Flow API, which sends a DLT-registered template (required for SMS in India). The
 * template must contain the variable named by MSG91_OTP_VARIABLE (default `otp`).
 */
export class Msg91SmsSender implements SmsSender {
  readonly enabled = true;

  constructor(
    private readonly config: Pick<
      AppConfig,
      'MSG91_AUTH_KEY' | 'MSG91_TEMPLATE_ID' | 'MSG91_OTP_VARIABLE'
    >,
    private readonly fetchImpl: HttpFetch = fetch,
  ) {}

  async send(to: string, _body: string, variables: SmsVariables = {}): Promise<void> {
    const res = await this.fetchImpl('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: { authkey: this.config.MSG91_AUTH_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        template_id: this.config.MSG91_TEMPLATE_ID,
        short_url: '0',
        recipients: [
          {
            mobiles: to.replace(/^\+/, ''),
            ...(variables.code ? { [this.config.MSG91_OTP_VARIABLE]: variables.code } : {}),
          },
        ],
      }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    const result = (await res.json().catch(() => ({}))) as { type?: string };
    if (!res.ok || result.type === 'error') throw new Error(`MSG91 responded ${res.status}`);
  }
}

export function createSmsSender(config: AppConfig, fetchImpl: HttpFetch = fetch): SmsSender {
  switch (config.SMS_PROVIDER) {
    case 'dev':
      return new DevSmsSender(config.NODE_ENV);
    case 'twilio':
      return new TwilioSmsSender(config, fetchImpl);
    case 'msg91':
      return new Msg91SmsSender(config, fetchImpl);
    default:
      return new DisabledSmsSender();
  }
}
