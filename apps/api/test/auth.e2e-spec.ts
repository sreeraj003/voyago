import 'reflect-metadata';
import 'dotenv/config';
import { type INestApplication } from '@nestjs/common';
import {
  ApiErrorSchema,
  AuthTokensSchema,
  PrivateProfileSchema,
  type SignInResult,
  SignInResultSchema,
} from '@voyago/shared';
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  bearer,
  lastEmailToken,
  login,
  outboxes,
  registerAndLogin,
  startAuthApp,
  TEST_PASSWORD,
} from './support/auth-helpers.js';

/**
 * Sign-in, sessions and recovery against the real database and Redis, using the
 * development SMS/email adapters. Rows created here are deleted afterwards.
 */
const prefix = `au_${randomUUID().slice(0, 6)}`;
const emailFor = (name: string) => `${prefix}_${name}@example.test`;
const usernameFor = (name: string) => `${prefix}_${name}`;
const testPhones: string[] = [];
const newPhone = () => {
  const phone = `+9190${randomInt(10_000_000, 99_999_999)}`;
  testPhones.push(phone);
  return phone;
};

describe('authentication (e2e)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await startAuthApp();
  });

  afterAll(async () => {
    const prisma = app.get(PrismaService);
    await prisma.user.deleteMany({ where: { username: { startsWith: prefix } } });
    await prisma.otpChallenge.deleteMany({ where: { phone: { in: testPhones } } });
    await app?.close();
  });

  it('lists the sign-in methods this server supports', async () => {
    const res = await http().get('/api/v1/auth/methods').expect(200);
    expect(res.body).toEqual({
      data: { password: true, phoneOtp: true, google: false, apple: false, emailDelivery: true },
    });
  });

  describe('register and login', () => {
    it('registers, signs in and returns the private profile', async () => {
      const tokens = await registerAndLogin(app, {
        email: emailFor('reg'),
        username: usernameFor('reg'),
      });
      AuthTokensSchema.parse(tokens);
      expect(tokens.expiresIn).toBe(900);

      const me = await http().get('/api/v1/me').set('authorization', bearer(tokens)).expect(200);
      const profile = PrivateProfileSchema.parse((me.body as { data: unknown }).data);
      expect(profile.email).toBe(emailFor('reg'));
      expect(profile.verification).toEqual({ email: false, phone: false });
      expect(profile.role).toBe('USER');
      expect(JSON.stringify(me.body)).not.toMatch(/passwordHash|password_hash|argon2/);

      const stored = await app
        .get(PrismaService)
        .user.findUniqueOrThrow({ where: { email: emailFor('reg') } });
      expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
      expect(stored.passwordHash).not.toContain(TEST_PASSWORD);
    });

    it('does not reveal whether an email is registered', async () => {
      const email = emailFor('enum');
      const first = await http()
        .post('/api/v1/auth/register')
        .send({ email, password: TEST_PASSWORD, username: usernameFor('enum1'), displayName: 'A' })
        .expect(202);
      const again = await http()
        .post('/api/v1/auth/register')
        .send({ email, password: TEST_PASSWORD, username: usernameFor('enum2'), displayName: 'B' })
        .expect(202);
      expect(again.body).toEqual(first.body);
      // The real owner is told someone tried; no second account was created.
      const subjects = outboxes(app)
        .email.messagesTo(email)
        .map((m) => m.subject);
      expect(subjects).toContain('Someone tried to sign up with your email');
      expect(
        await app.get(PrismaService).user.count({ where: { username: usernameFor('enum2') } }),
      ).toBe(0);

      const wrongPassword = await http()
        .post('/api/v1/auth/login')
        .send({ email, password: 'wrong password!' })
        .expect(401);
      const unknownEmail = await http()
        .post('/api/v1/auth/login')
        .send({ email: emailFor('nobody'), password: 'wrong password!' })
        .expect(401);
      expect(ApiErrorSchema.parse(wrongPassword.body).message).toBe('Invalid email or password');
      expect(ApiErrorSchema.parse(unknownEmail.body).message).toBe('Invalid email or password');
    });

    it('rejects a taken username (case-insensitive) and invalid input', async () => {
      await registerAndLogin(app, { email: emailFor('taken'), username: usernameFor('taken') });
      await http()
        .post('/api/v1/auth/register')
        .send({
          email: emailFor('taken2'),
          password: TEST_PASSWORD,
          username: usernameFor('TAKEN'),
          displayName: 'X',
        })
        .expect(409);
      const res = await http()
        .post('/api/v1/auth/register')
        .send({ email: 'nope', password: 'short', username: 'admin', displayName: '' })
        .expect(400);
      expect(
        ApiErrorSchema.parse(res.body)
          .details?.map((d) => d.path)
          .sort(),
      ).toEqual(['displayName', 'email', 'password', 'username']);
    });

    it('locks an account after 10 failed passwords, even with the right one', async () => {
      const email = emailFor('lock');
      await registerAndLogin(app, { email, username: usernameFor('lock') });
      for (let i = 0; i < 10; i++) {
        await http()
          .post('/api/v1/auth/login')
          .send({ email, password: `wrong-${i}-password` })
          .expect(401);
      }
      await http().post('/api/v1/auth/login').send({ email, password: TEST_PASSWORD }).expect(429);
    });
  });

  describe('sessions', () => {
    it('rotates refresh tokens and revokes the family when an old token is reused', async () => {
      const first = await registerAndLogin(app, {
        email: emailFor('rot'),
        username: usernameFor('rot'),
      });
      const res = await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(200);
      const second = AuthTokensSchema.parse((res.body as { data: unknown }).data);
      expect(second.refreshToken).not.toBe(first.refreshToken);
      // The earlier access token of the same sign-in keeps working until it expires.
      await http().get('/api/v1/me').set('authorization', bearer(first)).expect(200);
      await http().get('/api/v1/me').set('authorization', bearer(second)).expect(200);

      // Reusing the rotated token looks like theft: every token of this sign-in stops working.
      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(401);
      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: second.refreshToken })
        .expect(401);
      await http().get('/api/v1/me').set('authorization', bearer(second)).expect(401);

      const sessions = await app.get(PrismaService).authSession.findMany({
        where: { user: { username: usernameFor('rot') } },
      });
      expect(sessions.map((s) => s.revokedReason).sort()).toEqual(['reuse_detected', 'rotated']);
      // Only hashes are stored.
      expect(sessions.map((s) => s.refreshTokenHash)).not.toContain(first.refreshToken);
    });

    it('logs out one device, or all of them', async () => {
      const email = emailFor('out');
      const a = await registerAndLogin(app, { email, username: usernameFor('out') });
      const b = await login(app, email);
      const c = await login(app, email);

      await http().post('/api/v1/auth/logout').set('authorization', bearer(a)).expect(204);
      await http().get('/api/v1/me').set('authorization', bearer(a)).expect(401);
      await http().post('/api/v1/auth/refresh').send({ refreshToken: a.refreshToken }).expect(401);
      await http().get('/api/v1/me').set('authorization', bearer(b)).expect(200);

      await http().post('/api/v1/auth/logout-all').set('authorization', bearer(b)).expect(204);
      await http().get('/api/v1/me').set('authorization', bearer(b)).expect(401);
      await http().get('/api/v1/me').set('authorization', bearer(c)).expect(401);
      await http().post('/api/v1/auth/refresh').send({ refreshToken: c.refreshToken }).expect(401);
    });

    it('rejects missing, malformed and tampered access tokens', async () => {
      const tokens = await registerAndLogin(app, {
        email: emailFor('tamper'),
        username: usernameFor('tamper'),
      });
      await http().get('/api/v1/me').expect(401);
      await http().get('/api/v1/me').set('authorization', 'Basic abc').expect(401);
      const [header, payload, signature] = tokens.accessToken.split('.');
      const forged = Buffer.from(payload!, 'base64url')
        .toString()
        .replace(/"sub":"[^"]+"/, `"sub":"${randomUUID()}"`);
      await http()
        .get('/api/v1/me')
        .set(
          'authorization',
          `Bearer ${header}.${Buffer.from(forged).toString('base64url')}.${signature}`,
        )
        .expect(401);
    });

    it('blocks suspended accounts immediately', async () => {
      const email = emailFor('susp');
      const tokens = await registerAndLogin(app, { email, username: usernameFor('susp') });
      await app.get(PrismaService).user.update({ where: { email }, data: { status: 'SUSPENDED' } });
      await http().get('/api/v1/me').set('authorization', bearer(tokens)).expect(401);
      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);
      const res = await http()
        .post('/api/v1/auth/login')
        .send({ email, password: TEST_PASSWORD })
        .expect(403);
      expect(ApiErrorSchema.parse(res.body).message).toContain('not active');
    });
  });

  describe('verification and recovery', () => {
    it('verifies an email address with a single-use link', async () => {
      const email = emailFor('verify');
      const tokens = await registerAndLogin(app, { email, username: usernameFor('verify') });
      const token = lastEmailToken(app, email);
      await http().post('/api/v1/auth/email/verify').send({ token }).expect(204);
      await http().post('/api/v1/auth/email/verify').send({ token }).expect(400);
      const me = await http().get('/api/v1/me').set('authorization', bearer(tokens)).expect(200);
      expect((me.body as { data: { verification: unknown } }).data.verification).toEqual({
        email: true,
        phone: false,
      });
      const again = await http()
        .post('/api/v1/auth/email/verify/request')
        .set('authorization', bearer(tokens))
        .expect(202);
      expect(again.body).toEqual({ data: { status: 'already_verified' } });
    });

    it('resets a forgotten password and signs out every device', async () => {
      const email = emailFor('reset');
      const tokens = await registerAndLogin(app, { email, username: usernameFor('reset') });
      const unknown = await http()
        .post('/api/v1/auth/password/forgot')
        .send({ email: emailFor('ghost') })
        .expect(202);
      const known = await http().post('/api/v1/auth/password/forgot').send({ email }).expect(202);
      expect(known.body).toEqual(unknown.body);

      const token = lastEmailToken(app, email);
      const newPassword = 'a brand new passphrase';
      await http()
        .post('/api/v1/auth/password/reset')
        .send({ token, password: 'short' })
        .expect(400);
      await http()
        .post('/api/v1/auth/password/reset')
        .send({ token, password: newPassword })
        .expect(204);
      await http()
        .post('/api/v1/auth/password/reset')
        .send({ token, password: newPassword })
        .expect(400);

      await http().get('/api/v1/me').set('authorization', bearer(tokens)).expect(401);
      await http().post('/api/v1/auth/login').send({ email, password: TEST_PASSWORD }).expect(401);
      await login(app, email, newPassword);
    });

    it('changes the password and signs out other devices only', async () => {
      const email = emailFor('chg');
      const current = await registerAndLogin(app, { email, username: usernameFor('chg') });
      const other = await login(app, email);
      const wrong = await http()
        .post('/api/v1/auth/password/change')
        .set('authorization', bearer(current))
        .send({ currentPassword: 'not my password', newPassword: 'another long password' })
        .expect(400);
      expect(ApiErrorSchema.parse(wrong.body).details?.[0]?.path).toBe('currentPassword');

      await http()
        .post('/api/v1/auth/password/change')
        .set('authorization', bearer(current))
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'another long password' })
        .expect(204);
      await http().get('/api/v1/me').set('authorization', bearer(current)).expect(200);
      await http().get('/api/v1/me').set('authorization', bearer(other)).expect(401);
      await login(app, email, 'another long password');
    });
  });

  describe('phone OTP', () => {
    const verify = async (phone: string, code: string) =>
      http().post('/api/v1/auth/otp/verify').send({ phone, code });
    const lastCode = (phone: string) => {
      const code = /\b(\d{6})\b/.exec(outboxes(app).sms.lastMessageTo(phone) ?? '')?.[1];
      if (!code) throw new Error('no code sent');
      return code;
    };

    it('signs up a new number, then signs it in', async () => {
      const phone = newPhone();
      // Spaces are accepted and normalised.
      const sent = await http()
        .post('/api/v1/auth/otp/request')
        .send({ phone: `${phone.slice(0, 3)} ${phone.slice(3)}` })
        .expect(202);
      expect(sent.body).toEqual({ data: { expiresIn: 300 } });
      const code = lastCode(phone);
      const wrong = code === '000000' ? '111111' : '000000';
      expect((await verify(phone, wrong)).status).toBe(400);

      const res = await verify(phone, code);
      expect(res.status).toBe(200);
      const result = SignInResultSchema.parse((res.body as { data: unknown }).data);
      expect(result.status).toBe('SIGNUP_REQUIRED');
      const { signupToken } = result as Extract<SignInResult, { status: 'SIGNUP_REQUIRED' }>;
      // A code works once.
      expect((await verify(phone, code)).status).toBe(400);
      // A signup token is not an access token.
      await http().get('/api/v1/me').set('authorization', `Bearer ${signupToken}`).expect(401);

      const created = await http()
        .post('/api/v1/auth/signup/complete')
        .send({ signupToken, username: usernameFor('phone'), displayName: 'Phone Rider' })
        .expect(201);
      const tokens = AuthTokensSchema.parse((created.body as { data: unknown }).data);
      const me = await http().get('/api/v1/me').set('authorization', bearer(tokens)).expect(200);
      expect((me.body as { data: { phone: string; hasPassword: boolean } }).data).toMatchObject({
        phone,
        hasPassword: false,
        verification: { email: false, phone: true },
      });
      await http()
        .post('/api/v1/auth/signup/complete')
        .send({ signupToken, username: usernameFor('phone2'), displayName: 'Again' })
        .expect(409);

      await http().post('/api/v1/auth/otp/request').send({ phone }).expect(202);
      const again = await verify(phone, lastCode(phone));
      expect((again.body as { data: SignInResult }).data.status).toBe('AUTHENTICATED');
    });

    it('locks a code after 5 wrong attempts', async () => {
      const phone = newPhone();
      await http().post('/api/v1/auth/otp/request').send({ phone }).expect(202);
      const code = lastCode(phone);
      const wrong = code === '123456' ? '654321' : '123456';
      for (let i = 0; i < 5; i++) expect((await verify(phone, wrong)).status).toBe(400);
      expect((await verify(phone, code)).status).toBe(400);
    });

    it('limits codes per number', async () => {
      const phone = newPhone();
      for (let i = 0; i < 3; i++) {
        await http().post('/api/v1/auth/otp/request').send({ phone }).expect(202);
      }
      await http().post('/api/v1/auth/otp/request').send({ phone }).expect(429);
      // Only the newest code works.
      const challenges = await app
        .get(PrismaService)
        .otpChallenge.findMany({ where: { phone, consumedAt: null } });
      expect(challenges).toHaveLength(1);
      expect(challenges[0]?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('refuses Google and Apple sign-in when not configured', async () => {
    const res = await http()
      .post('/api/v1/auth/social/google')
      .send({ idToken: 'x'.repeat(40) })
      .expect(503);
    expect(ApiErrorSchema.parse(res.body).message).toBe('Google sign-in is not available');
    await http()
      .post('/api/v1/auth/social/facebook')
      .send({ idToken: 'x'.repeat(40) })
      .expect(400);
  });
});

describe('authentication without providers (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await startAuthApp({ SMS_PROVIDER: 'none', EMAIL_PROVIDER: 'none' });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('does not pretend SMS or email work', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .send({ phone: '+919000000000' })
      .expect(503);
    await request(app.getHttpServer())
      .post('/api/v1/auth/password/forgot')
      .send({ email: 'someone@example.test' })
      .expect(503);
    const methods = await request(app.getHttpServer()).get('/api/v1/auth/methods').expect(200);
    expect(methods.body).toMatchObject({ data: { phoneOtp: false, emailDelivery: false } });
  });
});

describe('sign-in rate limit (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await startAuthApp({ AUTH_RATE_LIMIT_MAX: '3' });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns 429 after AUTH_RATE_LIMIT_MAX attempts per minute', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'limit@example.test', password: 'whatever-password' })
        .expect(401);
    }
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'limit@example.test', password: 'whatever-password' })
      .expect(429);
    // Other routes keep the general limit.
    await request(app.getHttpServer()).get('/api/v1/auth/methods').expect(200);
  });
});
