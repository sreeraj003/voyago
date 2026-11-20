import { Logger } from '@nestjs/common';
import { type AppConfig } from '../../config/app-config.js';

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Sends transactional email. A real provider (e.g. SES, Postmark) implements this later. */
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

export function createEmailSender(config: AppConfig): EmailSender {
  return config.EMAIL_PROVIDER === 'dev'
    ? new DevEmailSender(config.NODE_ENV)
    : new DisabledEmailSender();
}
