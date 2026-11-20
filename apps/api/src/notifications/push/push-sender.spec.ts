import { validateEnv } from '../../config/env.schema.js';
import { createPushSender, DisabledPushSender, ExpoPushSender } from './push-sender.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  OTP_HMAC_SECRET: 'b'.repeat(40),
};
const TOKEN_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const TOKEN_B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';

const recorder = (status: number, json: unknown) => {
  const calls: { url: string; init: RequestInit & { body: string } }[] = [];
  const fetchImpl = ((url: string, init: RequestInit & { body: string }) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(json), { status }));
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

describe('push senders', () => {
  it('is chosen by PUSH_PROVIDER, and the dev adapter is refused in production', () => {
    expect(createPushSender(validateEnv(base))).toBeInstanceOf(DisabledPushSender);
    expect(createPushSender(validateEnv({ ...base, PUSH_PROVIDER: 'expo' }))).toBeInstanceOf(
      ExpoPushSender,
    );
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'x'.repeat(40),
        OTP_HMAC_SECRET: 'y'.repeat(40),
        PUSH_PROVIDER: 'dev',
      }),
    ).toThrow('PUSH_PROVIDER');
  });

  it("posts to Expo's push API and reports devices that are gone", async () => {
    const { calls, fetchImpl } = recorder(200, {
      data: [
        { status: 'ok', id: '1' },
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
      ],
    });
    const sender = new ExpoPushSender('expo-token', fetchImpl);
    const outcomes = await sender.send([
      { to: TOKEN_A, title: 'Hi', body: 'There', data: { tripId: 't' } },
      { to: TOKEN_B, title: 'Hi', data: {} },
    ]);
    expect(outcomes).toEqual(['sent', 'invalid_token']);
    expect(calls[0]?.url).toBe('https://exp.host/--/api/v2/push/send');
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer expo-token');
    expect(JSON.parse(calls[0]?.init.body ?? '[]')).toEqual([
      expect.objectContaining({ to: TOKEN_A, title: 'Hi', body: 'There', data: { tripId: 't' } }),
      expect.objectContaining({ to: TOKEN_B }),
    ]);
  });

  it('treats provider errors as failed without throwing', async () => {
    const { fetchImpl } = recorder(500, {});
    const sender = new ExpoPushSender('', fetchImpl);
    await expect(sender.send([{ to: TOKEN_A, title: 'Hi', data: {} }])).resolves.toEqual([
      'failed',
    ]);
  });
});
