import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWK } from 'jose';
import { validateEnv } from '../config/env.schema.js';
import { createEmailSender, DevEmailSender } from './delivery/email-sender.js';
import { createSmsSender, DevSmsSender } from './delivery/sms-sender.js';
import { type HttpFetch } from '../integrations/http-fetch.js';
import { PasswordService } from './password.service.js';
import { SocialTokenVerifier } from './social/social-token.verifier.js';
import { TokenService } from './token.service.js';

const baseEnv = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'unit-test-access-secret-0123456789abcdef',
  OTP_HMAC_SECRET: 'unit-test-otp-secret-0123456789abcdefghij',
  GOOGLE_CLIENT_IDS: 'voyago-android.apps.googleusercontent.com',
};
const config = validateEnv(baseEnv);

describe('PasswordService', () => {
  const passwords = new PasswordService();

  it('hashes with argon2id and verifies', async () => {
    const hash = await passwords.hash('a long enough password');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    await expect(passwords.verify(hash, 'a long enough password')).resolves.toBe(true);
    await expect(passwords.verify(hash, 'a long enough passw0rd')).resolves.toBe(false);
  });

  it('returns false (not an error) for missing or corrupt hashes', async () => {
    await expect(passwords.verify(null, 'anything')).resolves.toBe(false);
    await expect(passwords.verify('not-a-hash', 'anything')).resolves.toBe(false);
  });
});

describe('TokenService', () => {
  const tokens = new TokenService(config);
  const claims = { userId: crypto.randomUUID(), sessionFamilyId: crypto.randomUUID() };

  it('round-trips access tokens', async () => {
    const token = await tokens.signAccessToken(claims);
    await expect(tokens.verifyAccessToken(token)).resolves.toEqual(claims);
  });

  it('rejects tokens signed with another key or used for the wrong purpose', async () => {
    const other = new TokenService({ ...config, JWT_ACCESS_SECRET: 'x'.repeat(40) });
    await expect(tokens.verifyAccessToken(await other.signAccessToken(claims))).rejects.toThrow(
      'Authentication required',
    );
    const signup = await tokens.signSignupToken({ kind: 'phone', phone: '+919000000001' });
    await expect(tokens.verifyAccessToken(signup)).rejects.toThrow();
    await expect(tokens.verifySignupToken(signup)).resolves.toEqual({
      kind: 'phone',
      phone: '+919000000001',
    });
    await expect(tokens.verifySignupToken(await tokens.signAccessToken(claims))).rejects.toThrow();
  });

  it('rejects alg=none tokens', async () => {
    const unsigned = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: claims.userId, sid: claims.sessionFamilyId })).toString(
        'base64url',
      ),
      '',
    ].join('.');
    await expect(tokens.verifyAccessToken(unsigned)).rejects.toThrow();
  });
});

describe('development delivery adapters', () => {
  it('cannot be created in production', () => {
    expect(() => new DevSmsSender('production')).toThrow(/cannot be used in production/);
    expect(() => new DevEmailSender('production')).toThrow(/cannot be used in production/);
  });

  it('are disabled unless selected', () => {
    expect(createSmsSender(config).enabled).toBe(false);
    expect(createEmailSender(config).enabled).toBe(false);
    expect(createSmsSender({ ...config, SMS_PROVIDER: 'dev' }).enabled).toBe(true);
  });
});

describe('real delivery providers', () => {
  const recorder = (status = 200, json: unknown = {}) => {
    const calls: { url: string; init: RequestInit & { body: string } }[] = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push({ url, init: init as RequestInit & { body: string } });
      return Promise.resolve(new Response(JSON.stringify(json), { status }));
    }) as unknown as HttpFetch;
    return { calls, fetchImpl };
  };

  it('sends SMS through Twilio with basic auth', async () => {
    const { calls, fetchImpl } = recorder(201);
    const sms = createSmsSender(
      {
        ...config,
        SMS_PROVIDER: 'twilio',
        TWILIO_ACCOUNT_SID: 'AC123',
        TWILIO_AUTH_TOKEN: 'tok',
        TWILIO_FROM: '+15550001111',
      },
      fetchImpl,
    );
    expect(sms.enabled).toBe(true);
    await sms.send('+919876543210', '123456 is your Voyago code.', { code: '123456' });
    expect(calls[0]?.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    const body = new URLSearchParams(calls[0]?.init.body ?? '');
    expect(body.get('To')).toBe('+919876543210');
    expect(body.get('From')).toBe('+15550001111');
  });

  it('sends the DLT template through MSG91 with the code variable', async () => {
    const { calls, fetchImpl } = recorder(200, { type: 'success' });
    const sms = createSmsSender(
      { ...config, SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_ID: 't1' },
      fetchImpl,
    );
    await sms.send('+919876543210', 'ignored', { code: '654321' });
    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual({
      template_id: 't1',
      short_url: '0',
      recipients: [{ mobiles: '919876543210', otp: '654321' }],
    });
    const failing = recorder(200, { type: 'error' });
    await expect(
      createSmsSender(
        { ...config, SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_ID: 't1' },
        failing.fetchImpl,
      ).send('+919876543210', 'x', { code: '1' }),
    ).rejects.toThrow('MSG91');
  });

  it('texts SOS through its own MSG91 template, and only when one is set up', async () => {
    const base = { ...config, SMS_PROVIDER: 'msg91' as const, MSG91_AUTH_KEY: 'k' };
    const without = createSmsSender({ ...base, MSG91_TEMPLATE_ID: 't1' });
    expect(without.sosEnabled).toBe(false);
    expect(without.freeText).toBe(false);
    await expect(without.send('+919876543210', 'x', { template: 'sos' })).rejects.toThrow(
      'SOS template',
    );
    const { calls, fetchImpl } = recorder(200, { type: 'success' });
    const sms = createSmsSender(
      { ...base, MSG91_TEMPLATE_ID: 't1', MSG91_SOS_TEMPLATE_ID: 'sos1' },
      fetchImpl,
    );
    expect(sms.sosEnabled).toBe(true);
    await sms.send('+919876543210', 'ignored', {
      template: 'sos',
      name: 'Asha',
      trip: 'Nandi Hills',
      link: 'https://maps.google.com/?q=13.1,77.6',
    });
    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual({
      template_id: 'sos1',
      short_url: '0',
      recipients: [
        {
          mobiles: '919876543210',
          name: 'Asha',
          trip: 'Nandi Hills',
          link: 'https://maps.google.com/?q=13.1,77.6',
        },
      ],
    });
    // No provider: SOS still reaches members in the app, but nobody is texted.
    expect(createSmsSender(config).sosEnabled).toBe(false);
  });

  it('sends email through Resend or Postmark and reports failures', async () => {
    const resend = recorder();
    await createEmailSender(
      {
        ...config,
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_1',
        EMAIL_FROM: 'Voyago <a@b.in>',
      },
      resend.fetchImpl,
    ).send({ to: 'x@y.in', subject: 'Hi', text: 'Body' });
    expect(resend.calls[0]?.url).toBe('https://api.resend.com/emails');
    expect(JSON.parse(resend.calls[0]?.init.body ?? '')).toMatchObject({ to: ['x@y.in'] });

    const postmark = recorder(422);
    await expect(
      createEmailSender(
        { ...config, EMAIL_PROVIDER: 'postmark', POSTMARK_SERVER_TOKEN: 'p', EMAIL_FROM: 'a@b.in' },
        postmark.fetchImpl,
      ).send({ to: 'x@y.in', subject: 'Hi', text: 'Body' }),
    ).rejects.toThrow('Postmark responded 422');
  });

  it('refuses to start with a provider but no keys', () => {
    expect(() => validateEnv({ ...baseEnv, SMS_PROVIDER: 'twilio' })).toThrow(/TWILIO_ACCOUNT_SID/);
    expect(() => validateEnv({ ...baseEnv, EMAIL_PROVIDER: 'resend' })).toThrow(/RESEND_API_KEY/);
  });
});

describe('SocialTokenVerifier', () => {
  async function setup() {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' };
    const keys = createLocalJWKSet({ keys: [jwk] });
    const verifier = new SocialTokenVerifier(config, { google: keys, apple: keys });
    const sign = (claims: Record<string, unknown>, options: { aud?: string; iss?: string } = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setIssuer(options.iss ?? 'https://accounts.google.com')
        .setAudience(options.aud ?? 'voyago-android.apps.googleusercontent.com')
        .setSubject('google-user-1')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
    return { verifier, sign };
  }

  it('accepts a valid Google token and keeps only a verified email', async () => {
    const { verifier, sign } = await setup();
    await expect(
      verifier.verify(
        'google',
        await sign({ email: 'A@Example.com', email_verified: true, name: 'A' }),
      ),
    ).resolves.toEqual({
      provider: 'GOOGLE',
      providerUserId: 'google-user-1',
      email: 'a@example.com',
      name: 'A',
    });
    const unverified = await verifier.verify(
      'google',
      await sign({ email: 'a@example.com', email_verified: false }),
    );
    expect(unverified.email).toBeNull();
  });

  it('rejects wrong audience, issuer or signature', async () => {
    const { verifier, sign } = await setup();
    await expect(
      verifier.verify('google', await sign({}, { aud: 'someone-else' })),
    ).rejects.toThrow('Sign-in could not be verified');
    await expect(
      verifier.verify('google', await sign({}, { iss: 'https://evil.example' })),
    ).rejects.toThrow('Sign-in could not be verified');
    const other = await setup();
    await expect(verifier.verify('google', await other.sign({}))).rejects.toThrow();
  });

  it('is unavailable when the provider has no client ids', async () => {
    const { verifier } = await setup();
    expect(verifier.isEnabled('apple')).toBe(false);
    await expect(verifier.verify('apple', 'x'.repeat(40))).rejects.toThrow(
      'Apple sign-in is not available',
    );
  });
});
