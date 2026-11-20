import { type INestApplication } from '@nestjs/common';
import { type AuthTokens } from '@voyago/shared';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { type DevEmailSender, EMAIL_SENDER } from '../../src/auth/delivery/email-sender.js';
import { type DevSmsSender, SMS_SENDER } from '../../src/auth/delivery/sms-sender.js';
import { createApp } from '../../src/bootstrap.js';
import { validateEnv } from '../../src/config/env.schema.js';

export const TEST_PASSWORD = 'correct horse battery';

/** Boots the real app with development delivery adapters and generous rate limits. */
export async function startAuthApp(overrides: Record<string, string> = {}) {
  const app = (await createApp(
    validateEnv({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      SMS_PROVIDER: 'dev',
      EMAIL_PROVIDER: 'dev',
      RATE_LIMIT_MAX: '100000',
      AUTH_RATE_LIMIT_MAX: '100000',
      GOOGLE_CLIENT_IDS: '',
      APPLE_CLIENT_IDS: '',
      ...overrides,
    }),
  )) as INestApplication<App>;
  await app.init();
  return app;
}

export function outboxes(app: INestApplication<App>) {
  return {
    sms: app.get<DevSmsSender>(SMS_SENDER),
    email: app.get<DevEmailSender>(EMAIL_SENDER),
  };
}

/** The token from the last link emailed to `address` (verification or reset). */
export function lastEmailToken(app: INestApplication<App>, address: string): string {
  const messages = outboxes(app).email.messagesTo(address);
  const match = /token=([A-Za-z0-9_-]{43})/.exec(messages.at(-1)?.text ?? '');
  if (!match?.[1]) throw new Error(`No token emailed to ${address}`);
  return match[1];
}

export async function registerAndLogin(
  app: INestApplication<App>,
  account: { email: string; username: string; displayName?: string },
): Promise<AuthTokens> {
  await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({ displayName: account.username, ...account, password: TEST_PASSWORD })
    .expect(202);
  return login(app, account.email);
}

export async function login(
  app: INestApplication<App>,
  email: string,
  password = TEST_PASSWORD,
): Promise<AuthTokens> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password })
    .expect(200);
  return (res.body as { data: AuthTokens }).data;
}

export const bearer = (tokens: AuthTokens) => `Bearer ${tokens.accessToken}`;
