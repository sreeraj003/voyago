import { Logger } from '@nestjs/common';
import { type AppConfig } from '../../config/app-config.js';
import { type HttpFetch, PROVIDER_TIMEOUT_MS } from '../../integrations/http-fetch.js';

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Sends transactional email: Resend or Postmark in production, the dev adapter locally. */
export interface EmailSender {
  readonly enabled: boolean;
  send(message: EmailMessage): Promise<void>;
}

export class DisabledEmailSender implements EmailSender {
  readonly enabled = false;
  send(): Promise<void> {
    return Promise.reject(new Error('No email provider is configured'));
  }
}

/** Development and test only; see DevSmsSender. */
export class DevEmailSender implements EmailSender {
  readonly enabled = true;
  private readonly logger = new Logger('DevEmailSender');
  private readonly outbox: EmailMessage[] = [];

  constructor(private readonly nodeEnv: AppConfig['NODE_ENV']) {
    if (nodeEnv === 'production') {
      throw new Error('The development email adapter cannot be used in production');
    }
  }

  send(message: EmailMessage): Promise<void> {
    this.outbox.push(message);
    if (this.outbox.length > 200) this.outbox.shift();
    if (this.nodeEnv === 'development') {
      this.logger.warn(`[dev email to ${message.to}] ${message.subject}\n${message.text}`);
    }
    return Promise.resolve();
  }

  /** Test helper: messages sent to an address, oldest first. */
  messagesTo(address: string): EmailMessage[] {
    return this.outbox.filter((message) => message.to === address.toLowerCase());
  }
}

/** Resend (resend.com). EMAIL_FROM must be on a domain verified there. */
export class ResendEmailSender implements EmailSender {
  readonly enabled = true;

  constructor(
    private readonly config: Pick<AppConfig, 'RESEND_API_KEY' | 'EMAIL_FROM'>,
    private readonly fetchImpl: HttpFetch = fetch,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.config.EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Resend responded ${res.status}`);
  }
}

/** Postmark (postmarkapp.com), transactional stream. EMAIL_FROM must be a verified sender. */
export class PostmarkEmailSender implements EmailSender {
  readonly enabled = true;

  constructor(
    private readonly config: Pick<AppConfig, 'POSTMARK_SERVER_TOKEN' | 'EMAIL_FROM'>,
    private readonly fetchImpl: HttpFetch = fetch,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const res = await this.fetchImpl('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'x-postmark-server-token': this.config.POSTMARK_SERVER_TOKEN,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        From: this.config.EMAIL_FROM,
        To: message.to,
        Subject: message.subject,
        TextBody: message.text,
        MessageStream: 'outbound',
      }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Postmark responded ${res.status}`);
  }
}

export function createEmailSender(config: AppConfig, fetchImpl: HttpFetch = fetch): EmailSender {
  switch (config.EMAIL_PROVIDER) {
    case 'dev':
      return new DevEmailSender(config.NODE_ENV);
    case 'resend':
      return new ResendEmailSender(config, fetchImpl);
    case 'postmark':
      return new PostmarkEmailSender(config, fetchImpl);
    default:
      return new DisabledEmailSender();
  }
}
