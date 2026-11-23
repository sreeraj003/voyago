import 'reflect-metadata';
import 'dotenv/config';
import { type INestApplication } from '@nestjs/common';
import {
  AdminPlanSchema,
  AdminSubscriptionSchema,
  type AuthTokens,
  BulkJoinResultSchema,
  JoinRequestSchema,
  type MySubscription,
  MySubscriptionSchema,
  NotificationSchema,
  OrganiserInsightsSchema,
  PlansResponseSchema,
  ProfileStyleSchema,
  PublicProfileSchema,
  SavedSearchSchema,
  type StaffRole,
  TravelStatsSchema,
  TripCardSchema,
  TripSchema,
  UPGRADE_REQUIRED,
} from '@voyago/shared';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { z } from 'zod';
import { PrismaService } from '../src/database/prisma.service.js';
import { PaymentGateway } from '../src/payments/payment-gateway.js';
import { ProFeaturesService } from '../src/subscriptions/pro-features.service.js';
import { SubscriptionsService } from '../src/subscriptions/subscriptions.service.js';
import { bearer, login, registerAndLogin, startAuthApp } from './support/auth-helpers.js';

/**
 * Subscriptions against a stand-in for Razorpay's Plans, Subscriptions, Payments and Refunds
 * APIs: activation (checkout return and webhook), renewal, failed renewal, cancellation, expiry,
 * duplicate webhooks, amount mismatch, price changes, support refunds, and every paid feature
 * refusing members without the plan.
 */
const prefix = `sub_${randomUUID().slice(0, 6)}`;
const KEY_SECRET = 'e2e-key-secret';
const WEBHOOK_SECRET = 'e2e-webhook-secret';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A destination only this test's trips have, so trips other suites publish don't match. */
const PLACE = `Kaveri${randomUUID()
  .replace(/[^a-f]/g, '')
  .slice(0, 8)}`;
const place = { name: `${PLACE} falls`, point: { latitude: 12.2958, longitude: 76.6394 } };
const EXPLORER_PRICE = 11_900;
const ORGANISER_PRICE = 69_900;

const dataOf = <T>(schema: z.ZodType<T>, res: { body: unknown }) =>
  schema.parse((res.body as { data: unknown }).data);
const listOf = <T>(schema: z.ZodType<T>, res: { body: unknown }): T[] =>
  z.array(schema).parse((res.body as { data: unknown }).data);
const hmac = (secret: string, payload: string) =>
  createHmac('sha256', secret).update(payload).digest('hex');
const newKey = () => `k${randomUUID().replace(/-/g, '')}`;
const unix = (ms: number) => Math.floor(ms / 1000);
const ErrorBody = z.object({
  message: z.string(),
  details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

const NAMES = ['alice', 'bob', 'carol', 'dan', 'erin', 'free', 'ops', 'support'] as const;
type Name = (typeof NAMES)[number];
const ROLES: Partial<Record<Name, StaffRole>> = { ops: 'OPERATIONS', support: 'SUPPORT' };
const email = (name: Name) => `${prefix}_${name}@example.test`;

type FakeSub = {
  id: string;
  plan_id: string;
  status: string;
  current_start: number | null;
  current_end: number | null;
  charge_at: number | null;
  ended_at: number | null;
};
type FakePayment = {
  id: string;
  order_id: string;
  status: 'captured' | 'failed';
  amount: number;
  currency: string;
  fee: number | null;
  tax: number | null;
  method: string;
  error_code: string | null;
  error_description: string | null;
};

/** Razorpay's Plans, Subscriptions, Payments and Refunds APIs, in memory. */
class FakeRazorpay {
  plans = new Map<string, { id: string; amount: number }>();
  subs = new Map<string, FakeSub>();
  payments = new Map<string, FakePayment>();
  refunds: { id: string; payment_id: string; amount: number }[] = [];
  cancels: { id: string; atCycleEnd: boolean }[] = [];
  failCancel = false;
  calls: string[] = [];
  private n = 0;
  private next = (p: string) => `${p}_${++this.n}${randomUUID().slice(0, 6)}`;

  private payment(sub: FakeSub, status: FakePayment['status'], amount?: number): FakePayment {
    const amt = amount ?? this.plans.get(sub.plan_id)!.amount;
    const p: FakePayment = {
      id: this.next('pay'),
      order_id: this.next('order'),
      status,
      amount: amt,
      currency: 'INR',
      fee: status === 'captured' ? Math.round(amt * 0.02) : null,
      tax: status === 'captured' ? Math.round(amt * 0.0036) : null,
      method: 'upi',
      error_code: status === 'failed' ? 'BAD_REQUEST_ERROR' : null,
      error_description: status === 'failed' ? 'Mandate declined' : null,
    };
    this.payments.set(p.id, p);
    return p;
  }

  /** The member paid the first month on the checkout. */
  activate(id: string, amount?: number) {
    const sub = this.subs.get(id)!;
    const now = Date.now();
    Object.assign(sub, {
      status: 'active',
      current_start: unix(now),
      current_end: unix(now + 30 * DAY),
      charge_at: unix(now + 30 * DAY),
    });
    return { sub, payment: this.payment(sub, 'captured', amount) };
  }

  /** A renewal went through: the next month. */
  renew(id: string) {
    const sub = this.subs.get(id)!;
    const start = sub.current_end!;
    Object.assign(sub, {
      status: 'active',
      current_start: start,
      current_end: start + unix(30 * DAY),
      charge_at: start + unix(30 * DAY),
    });
    return { sub, payment: this.payment(sub, 'captured') };
  }

  /** A renewal failed; the provider will retry. */
  failRenewal(id: string) {
    const sub = this.subs.get(id)!;
    sub.status = 'pending';
    return { sub, payment: this.payment(sub, 'failed') };
  }

  handle = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/v1/, '');
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    this.calls.push(`${method} ${path}`);
    const auth = Buffer.from(`rzp_test_e2e:${KEY_SECRET}`).toString('base64');
    if ((init?.headers as Record<string, string>)?.authorization !== `Basic ${auth}`) {
      return json(401, { error: { description: 'Authentication failed' } });
    }
    let m: RegExpExecArray | null;
    if (method === 'POST' && path === '/plans') {
      const item = body.item as { amount: number };
      const plan = { id: this.next('plan'), amount: Number(item.amount) };
      this.plans.set(plan.id, plan);
      return json(200, { ...plan, period: body.period, interval: body.interval });
    }
    if (method === 'POST' && path === '/subscriptions') {
      if (!this.plans.has(String(body.plan_id))) {
        return json(400, { error: { description: 'No such plan' } });
      }
      const sub: FakeSub = {
        id: this.next('sub'),
        plan_id: String(body.plan_id),
        status: 'created',
        current_start: null,
        current_end: null,
        charge_at: null,
        ended_at: null,
      };
      this.subs.set(sub.id, sub);
      return json(200, sub);
    }
    if ((m = /^\/subscriptions\/([^/]+)\/cancel$/.exec(path)) && method === 'POST') {
      const sub = this.subs.get(m[1]!);
      if (!sub) return json(404, { error: { description: 'No such subscription' } });
      if (this.failCancel) return json(500, { error: { description: 'Server error' } });
      const atCycleEnd = body.cancel_at_cycle_end === 1;
      this.cancels.push({ id: sub.id, atCycleEnd });
      // At the cycle end the provider stays active until then; otherwise it ends now.
      if (!atCycleEnd) Object.assign(sub, { status: 'cancelled', ended_at: unix(Date.now()) });
      return json(200, sub);
    }
    if ((m = /^\/subscriptions\/([^/]+)$/.exec(path))) {
      const sub = this.subs.get(m[1]!);
      return sub ? json(200, sub) : json(404, { error: { description: 'No such subscription' } });
    }
    if ((m = /^\/payments\/([^/]+)\/refund$/.exec(path)) && method === 'POST') {
      const r = { id: this.next('rfnd'), payment_id: m[1]!, amount: Number(body.amount) };
      this.refunds.push(r);
      return json(200, { ...r, status: 'processed' });
    }
    if ((m = /^\/payments\/([^/]+)$/.exec(path))) {
      const p = this.payments.get(m[1]!);
      return p ? json(200, p) : json(404, { error: { description: 'No such payment' } });
    }
    return json(404, { error: { description: `Unknown route ${method} ${path}` } });
  };
}

function json(status: number, body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

describe('subscriptions (e2e)', () => {
  let app: INestApplication<App>;
  const tokens = {} as Record<Name, AuthTokens>;
  const ids = {} as Record<Name, string>;
  const http = () => request(app.getHttpServer());
  const prisma = () => app.get(PrismaService);
  const as = (name: Name) => ({ authorization: bearer(tokens[name]) });
  const fake = new FakeRazorpay();
  const plan = { explorer: '', organiser: '' };
  const planIds: string[] = [];
  const tripIds: string[] = [];
  const startedAt = new Date();

  const mine = async (name: Name): Promise<MySubscription> =>
    dataOf(
      MySubscriptionSchema,
      await http()
        .get('/api/v1/me/subscription?returnUrl=voyago://subscription')
        .set(as(name))
        .expect(200),
    );

  const subscribe = (name: Name, planCode: string, key = newKey()) =>
    http()
      .post('/api/v1/me/subscription')
      .set(as(name))
      .send({ planCode, idempotencyKey: key, returnUrl: 'voyago://subscription' });

  async function started(name: Name, planCode: string) {
    const res = await subscribe(name, planCode).expect(201);
    const view = dataOf(MySubscriptionSchema, res);
    const row = await prisma().subscription.findUniqueOrThrow({
      where: { id: view.subscription!.id },
    });
    return { view, row, providerId: row.providerSubscriptionId! };
  }

  /** The checkout's post back to the API, as Razorpay's page would send it. */
  function checkoutReturn(view: MySubscription, fields: Record<string, string>) {
    const url = new URL(view.subscription!.checkoutUrl!);
    return http().post(`${url.pathname}/razorpay${url.search}`).type('form').send(fields);
  }

  function webhook(
    event: string,
    payload: Record<string, unknown>,
    eventId = `evt_${randomUUID()}`,
  ) {
    const body = JSON.stringify({ entity: 'event', event, payload });
    return http()
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', hmac(WEBHOOK_SECRET, body))
      .set('x-razorpay-event-id', eventId)
      .send(body);
  }

  /** Subscribes and activates by webhook. */
  async function active(name: Name, planCode: string) {
    const s = await started(name, planCode);
    const { sub, payment } = fake.activate(s.providerId);
    await webhook('subscription.activated', {
      subscription: { entity: sub },
      payment: { entity: payment },
    }).expect(200);
    return s;
  }

  const notifications = async (name: Name) =>
    z
      .object({ data: z.array(NotificationSchema) })
      .parse((await http().get('/api/v1/me/notifications?limit=50').set(as(name)).expect(200)).body)
      .data;

  const expectUpgrade = (res: { status: number; body: unknown }, tier: string) => {
    expect(res.status).toBe(403);
    const body = ErrorBody.parse(res.body);
    expect(body.details).toContainEqual({ path: UPGRADE_REQUIRED, message: tier });
  };

  /** Moves a subscription's paid period into the past, here and at the provider. */
  async function endPeriod(subscriptionId: string, endedMsAgo: number) {
    const end = new Date(Date.now() - endedMsAgo);
    const start = new Date(end.getTime() - 30 * DAY);
    const row = await prisma().subscription.update({
      where: { id: subscriptionId },
      data: { currentPeriodStart: start, currentPeriodEnd: end },
    });
    const sub = fake.subs.get(row.providerSubscriptionId!);
    if (sub)
      Object.assign(sub, {
        current_start: unix(start.getTime()),
        current_end: unix(end.getTime()),
      });
  }

  beforeAll(async () => {
    app = await startAuthApp({
      PAYMENT_PROVIDER: 'razorpay',
      RAZORPAY_KEY_ID: 'rzp_test_e2e',
      RAZORPAY_KEY_SECRET: KEY_SECRET,
      RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      SUBSCRIPTIONS_ENABLED: 'true',
    });
    Object.assign(app.get(PaymentGateway), { fetchImpl: fake.handle });
    for (const name of NAMES) {
      await registerAndLogin(app, { email: email(name), username: `${prefix}_${name}` });
      const user = await prisma().user.update({
        where: { username: `${prefix}_${name}` },
        data: { role: ROLES[name] ?? 'USER' },
      });
      ids[name] = user.id;
      tokens[name] = await login(app, email(name));
    }
    // Plans of this test only, so the shared seed plans are never changed.
    for (const [key, tier, price] of [
      ['explorer', 'EXPLORER_PRO', EXPLORER_PRICE],
      ['organiser', 'ORGANISER_PRO', ORGANISER_PRICE],
    ] as const) {
      const p = await prisma().subscriptionPlan.create({
        data: {
          code: `${prefix}_${key}`.toUpperCase(),
          tier,
          name: tier === 'EXPLORER_PRO' ? 'Explorer Pro' : 'Organiser Pro',
          description: `${key} (test)`,
          pricePaise: price,
          billingInterval: 'MONTHLY',
        },
      });
      plan[key] = p.code;
      planIds.push(p.id);
    }
  });

  afterAll(async () => {
    const userIds = Object.values(ids);
    const subs = await prisma().subscription.findMany({
      where: { userId: { in: userIds } },
      select: { id: true },
    });
    const subIds = subs.map((s) => s.id);
    await prisma().paymentEvent.deleteMany({
      where: {
        OR: [
          { subscriptionId: { in: subIds } },
          { receivedAt: { gte: startedAt }, eventType: { startsWith: 'subscription.' } },
        ],
      },
    });
    await prisma().payment.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await prisma().subscription.deleteMany({ where: { id: { in: subIds } } });
    await prisma().subscriptionPlan.deleteMany({ where: { id: { in: planIds } } });
    await prisma().trip.deleteMany({ where: { id: { in: tripIds } } });
    await prisma().user.deleteMany({ where: { id: { in: userIds } } });
    await app?.close();
  });

  describe('plans and the free tier', () => {
    it('lists the plans with prices, what they include, what is always free and the terms', async () => {
      const res = dataOf(
        PlansResponseSchema,
        await http().get('/api/v1/subscriptions/plans').set(as('free')).expect(200),
      );
      const explorer = res.plans.find((p) => p.code === plan.explorer)!;
      const organiser = res.plans.find((p) => p.code === plan.organiser)!;
      expect(explorer).toMatchObject({
        tier: 'EXPLORER_PRO',
        pricePaise: EXPLORER_PRICE,
        interval: 'MONTHLY',
        available: true,
      });
      expect(explorer.entitlements).toContain('saved_searches');
      expect(explorer.entitlements).not.toContain('organiser_insights');
      expect(organiser.entitlements).toEqual(
        expect.arrayContaining(['saved_searches', 'organiser_insights', 'bulk_join_requests']),
      );
      expect(res.alwaysFree.join(' ')).toMatch(/SOS/);
      expect(res.alwaysFree.join(' ')).toMatch(/Blocking and reporting/);
      expect(res.terms.join(' ')).toMatch(/Cancel any time/);
      expect(res.unavailableReason).toBeNull();
    });

    it('is free with no subscription, and every paid feature says which plan it needs', async () => {
      expect(await mine('free')).toEqual({ tier: 'FREE', entitlements: [], subscription: null });
      expectUpgrade(
        await http()
          .post('/api/v1/me/saved-searches')
          .set(as('free'))
          .send({ name: 'Rides', query: { mode: 'RIDE' } }),
        'EXPLORER_PRO',
      );
      expectUpgrade(
        await http().get('/api/v1/me/organiser/insights').set(as('free')),
        'ORGANISER_PRO',
      );
      expectUpgrade(
        await http()
          .patch('/api/v1/me/profile/style')
          .set(as('free'))
          .send({ accentColor: 'teal' }),
        'EXPLORER_PRO',
      );
      expectUpgrade(
        await http()
          .post(`/api/v1/trips/${randomUUID()}/join-requests/bulk`)
          .set(as('free'))
          .send({ action: 'approve', requestIds: [randomUUID()] }),
        'ORGANISER_PRO',
      );
      // The free parts keep working: basic stats, every discovery filter, clearing a style.
      const stats = dataOf(
        TravelStatsSchema,
        await http().get('/api/v1/me/stats').set(as('free')).expect(200),
      );
      expect(stats.enhanced).toBeNull();
      expect(stats.basic).toEqual({ tripsJoined: 0, tripsOrganised: 0, upcoming: 0 });
      await http()
        .get('/api/v1/discovery/search?mode=RIDE&difficulty=EASY&minSeats=1&sort=departure')
        .set(as('free'))
        .expect(200);
      await http()
        .patch('/api/v1/me/profile/style')
        .set(as('free'))
        .send({ accentColor: null })
        .expect(200);
      await http().get('/api/v1/me/saved-searches').set(as('free')).expect(200);
    });

    it('refuses unknown plans and bad idempotency keys', async () => {
      await subscribe('free', 'NO_SUCH_PLAN').expect(404);
      await http()
        .post('/api/v1/me/subscription')
        .set(as('free'))
        .send({ planCode: plan.explorer, idempotencyKey: 'short' })
        .expect(400);
    });
  });

  describe('activation', () => {
    it('starts waiting for the first payment, with a payment page and no paid features yet', async () => {
      const key = newKey();
      const res = await subscribe('alice', plan.explorer, key).expect(201);
      const view = dataOf(MySubscriptionSchema, res);
      expect(view.tier).toBe('FREE');
      expect(view.subscription).toMatchObject({
        status: 'PENDING',
        pricePaise: EXPLORER_PRICE,
        entitled: false,
        actions: ['pay', 'cancel'],
      });
      expect(view.subscription!.checkoutUrl).toMatch(/\/api\/v1\/checkout\/subscriptions\//);
      // The same key is the same attempt.
      const again = dataOf(
        MySubscriptionSchema,
        await subscribe('alice', plan.explorer, key).expect(201),
      );
      expect(again.subscription!.id).toBe(view.subscription!.id);
      // So is a new key while the first one waits for payment on the same plan.
      const fresh = dataOf(
        MySubscriptionSchema,
        await subscribe('alice', plan.explorer).expect(201),
      );
      expect(fresh.subscription!.id).toBe(view.subscription!.id);
      expect(fake.plans.size).toBe(1);

      const url = new URL(view.subscription!.checkoutUrl!);
      const page = await http().get(`${url.pathname}${url.search}`).expect(200);
      expect(page.text).toContain('₹119');
      expect(page.text).toContain('and subscribe');
      expect(page.text).toMatch(/Cancel any time/);
      // A tampered link is refused.
      await http()
        .get(`${url.pathname}${url.search.replace(/s=[^&]+/, 's=bad')}`)
        .expect(400);
    });

    it('switches on from the checkout return only with a valid signature and the provider records', async () => {
      const view = await mine('alice');
      const row = await prisma().subscription.findUniqueOrThrow({
        where: { id: view.subscription!.id },
      });
      const { payment } = fake.activate(row.providerSubscriptionId!);
      const forged = await checkoutReturn(view, {
        razorpay_payment_id: payment.id,
        razorpay_subscription_id: row.providerSubscriptionId!,
        razorpay_signature: hmac('wrong', `${payment.id}|${row.providerSubscriptionId}`),
      }).expect(303);
      expect(forged.headers.location).toContain('payment=failed');
      expect((await mine('alice')).subscription!.status).toBe('PENDING');

      const ok = await checkoutReturn(view, {
        razorpay_payment_id: payment.id,
        razorpay_subscription_id: row.providerSubscriptionId!,
        razorpay_signature: hmac(KEY_SECRET, `${payment.id}|${row.providerSubscriptionId}`),
      }).expect(303);
      expect(ok.headers.location).toBe(
        `voyago://subscription?subscription=${view.subscription!.id}&payment=paid`,
      );
      const now = await mine('alice');
      expect(now.tier).toBe('EXPLORER_PRO');
      expect(now.entitlements).toContain('saved_searches');
      expect(now.subscription).toMatchObject({
        status: 'ACTIVE',
        entitled: true,
        cancelAtPeriodEnd: false,
        checkoutUrl: null,
        actions: ['cancel'],
      });
      expect(now.subscription!.renewsAt).not.toBeNull();
      expect(now.subscription!.payments).toHaveLength(1);
      expect(now.subscription!.payments[0]).toMatchObject({
        amountPaise: EXPLORER_PRICE,
        status: 'CAPTURED',
      });
      const notes = await notifications('alice');
      expect(notes.some((n) => n.title === 'Explorer Pro is on')).toBe(true);
    });

    it('refuses a second subscription while one is running', async () => {
      const res = await subscribe('alice', plan.organiser).expect(409);
      expect(ErrorBody.parse(res.body).message).toMatch(/already have Explorer Pro/);
    });

    it('switches on from a webhook too, and a repeated webhook changes nothing', async () => {
      const s = await started('bob', plan.organiser);
      const { sub, payment } = fake.activate(s.providerId);
      const eventId = `evt_${randomUUID()}`;
      const payload = { subscription: { entity: sub }, payment: { entity: payment } };
      const first = await webhook('subscription.activated', payload, eventId).expect(200);
      expect(first.body).toMatchObject({ status: 'processed' });
      const dup = await webhook('subscription.activated', payload, eventId).expect(200);
      expect(dup.body).toMatchObject({ status: 'duplicate' });
      // The same event under another id is applied again, with the same result.
      await webhook('subscription.activated', payload).expect(200);
      const now = await mine('bob');
      expect(now.tier).toBe('ORGANISER_PRO');
      expect(now.subscription!.payments).toHaveLength(1);
      const events = await prisma().paymentEvent.findMany({ where: { subscriptionId: s.row.id } });
      expect(events.length).toBe(2);
      expect(events.every((e) => e.signatureValid)).toBe(true);
    });

    it('does not switch on when the provider reports a different amount', async () => {
      const s = await started('carol', plan.explorer);
      const { payment } = fake.activate(s.providerId, 100);
      const res = await checkoutReturn(s.view, {
        razorpay_payment_id: payment.id,
        razorpay_subscription_id: s.providerId,
        razorpay_signature: hmac(KEY_SECRET, `${payment.id}|${s.providerId}`),
      }).expect(303);
      expect(res.headers.location).toContain('payment=failed');
      expect((await mine('carol')).tier).toBe('FREE');
      const stored = await prisma().payment.findFirstOrThrow({
        where: { subscriptionId: s.row.id },
      });
      expect(stored.failureCode).toBe('AMOUNT_MISMATCH');
      // Cancelling an unpaid subscription just drops it.
      const cancelled = dataOf(
        MySubscriptionSchema,
        await http().post('/api/v1/me/subscription/cancel').set(as('carol')).send({}).expect(200),
      );
      expect(cancelled.subscription!.status).toBe('CANCELLED');
      expect(cancelled.tier).toBe('FREE');
    });
  });

  describe('paid features', () => {
    it('saves searches, runs them like discovery, and caps them', async () => {
      const created = dataOf(
        SavedSearchSchema,
        await http()
          .post('/api/v1/me/saved-searches')
          .set(as('alice'))
          .send({
            name: 'Weekend rides',
            query: { mode: 'RIDE', to: PLACE, sort: 'departure', limit: '5' },
            alerts: true,
          })
          .expect(201),
      );
      expect(created.query).toEqual({ mode: 'RIDE', to: PLACE, sort: 'departure' });
      await http()
        .post('/api/v1/me/saved-searches')
        .set(as('alice'))
        .send({ name: 'Weekend rides', query: {} })
        .expect(409);
      const bad = await http()
        .post('/api/v1/me/saved-searches')
        .set(as('alice'))
        .send({ name: 'Bad', query: { mode: 'BOAT' } })
        .expect(400);
      expect(ErrorBody.parse(bad.body).details?.[0]?.path).toBe('query.mode');

      const run = await http()
        .get(`/api/v1/me/saved-searches/${created.id}/trips?limit=10`)
        .set(as('alice'))
        .expect(200);
      z.array(TripCardSchema).parse((run.body as { data: unknown }).data);

      const renamed = dataOf(
        SavedSearchSchema,
        await http()
          .patch(`/api/v1/me/saved-searches/${created.id}`)
          .set(as('alice'))
          .send({ name: 'Rides' })
          .expect(200),
      );
      expect(renamed.name).toBe('Rides');
      // Someone else's saved search is not found.
      await http().get(`/api/v1/me/saved-searches/${created.id}/trips`).set(as('bob')).expect(404);

      for (let i = 0; i < 9; i++) {
        await http()
          .post('/api/v1/me/saved-searches')
          .set(as('alice'))
          .send({ name: `Search ${i}`, query: { q: `place${i}` } })
          .expect(201);
      }
      const over = await http()
        .post('/api/v1/me/saved-searches')
        .set(as('alice'))
        .send({ name: 'One too many', query: {} })
        .expect(409);
      expect(ErrorBody.parse(over.body).message).toMatch(/up to 10/);
      const list = listOf(
        SavedSearchSchema,
        await http().get('/api/v1/me/saved-searches').set(as('alice')).expect(200),
      );
      expect(list).toHaveLength(10);
      for (const s of list.filter((s) => s.name.startsWith('Search'))) {
        await http().delete(`/api/v1/me/saved-searches/${s.id}`).set(as('alice')).expect(204);
      }
    });

    it('alerts once about trips published after the search was saved', async () => {
      const [saved] = listOf(
        SavedSearchSchema,
        await http().get('/api/v1/me/saved-searches').set(as('alice')).expect(200),
      );
      const trip = await createTrip('dan', { title: `${prefix} new ride`, destination: place });
      expect(await app.get(ProFeaturesService).sendAlerts()).toBeGreaterThanOrEqual(1);
      const note = (await notifications('alice')).find((n) => n.data.savedSearchId === saved!.id);
      expect(note).toBeDefined();
      expect(note!.title).toMatch(/Rides/);
      expect(JSON.stringify(note)).toContain(trip);
      // Nothing new since: no second alert.
      const before = (await notifications('alice')).length;
      await app.get(ProFeaturesService).sendAlerts();
      expect((await notifications('alice')).length).toBe(before);
    });

    it('shows the profile style while the plan includes it', async () => {
      const style = dataOf(
        ProfileStyleSchema,
        await http()
          .patch('/api/v1/me/profile/style')
          .set(as('alice'))
          .send({ accentColor: 'indigo' })
          .expect(200),
      );
      expect(style).toEqual({ accentColor: 'indigo', headline: null });
      // A headline is Organiser Pro.
      expectUpgrade(
        await http()
          .patch('/api/v1/me/profile/style')
          .set(as('alice'))
          .send({ headline: 'Weekend rider' }),
        'ORGANISER_PRO',
      );
      await http()
        .patch('/api/v1/me/profile/style')
        .set(as('bob'))
        .send({ accentColor: 'forest', headline: 'Ride leader, Bengaluru' })
        .expect(200);
      const profile = dataOf(
        PublicProfileSchema,
        await http().get(`/api/v1/users/${prefix}_bob`).set(as('free')).expect(200),
      );
      expect(profile.style).toEqual({ accentColor: 'forest', headline: 'Ride leader, Bengaluru' });
      await http()
        .patch('/api/v1/me/profile/style')
        .set(as('erin'))
        .send({ accentColor: 'teal' })
        .expect(403);
    });

    it('gives organisers insights and bulk decisions, each checked like a single one', async () => {
      const tripId = await createTrip('bob', { maxParticipants: 3 });
      const requests: string[] = [];
      for (const name of ['carol', 'dan', 'erin'] as const) {
        const res = await http()
          .post(`/api/v1/trips/${tripId}/join-requests`)
          .set(as(name))
          .send({})
          .expect(201);
        requests.push(dataOf(JoinRequestSchema, res).id);
      }
      const other = randomUUID();
      const result = dataOf(
        BulkJoinResultSchema,
        await http()
          .post(`/api/v1/trips/${tripId}/join-requests/bulk`)
          .set(as('bob'))
          .send({ action: 'approve', requestIds: [...requests, other] })
          .expect(200),
      );
      // Organiser plus two fills the trip of three: the last approval is refused.
      expect(result.done).toEqual(requests.slice(0, 2));
      expect(result.failed.map((f) => f.id)).toEqual([requests[2], other]);
      expect(result.failed[1]!.reason).toBe('Request not found');
      // Explorer Pro doesn't include bulk decisions.
      expectUpgrade(
        await http()
          .post(`/api/v1/trips/${tripId}/join-requests/bulk`)
          .set(as('alice'))
          .send({ action: 'reject', requestIds: [requests[2]] }),
        'ORGANISER_PRO',
      );

      const insights = dataOf(
        OrganiserInsightsSchema,
        await http().get('/api/v1/me/organiser/insights').set(as('bob')).expect(200),
      );
      const row = insights.trips.find((t) => t.tripId === tripId)!;
      expect(row).toMatchObject({
        capacity: 3,
        participants: 3,
        fillPercent: 100,
        requests: { total: 3, approved: 2, pending: 1, rejected: 0, withdrawn: 0 },
      });
      expect(row.avgDecisionHours).not.toBeNull();
      expect(insights.totals.trips).toBeGreaterThanOrEqual(1);
    });

    it('adds detailed travel statistics with the plan', async () => {
      const tripId = await createTrip('bob', { title: `${prefix} done ride` });
      await prisma().tripParticipant.create({
        data: { tripId, userId: ids.alice, status: 'COMPLETED' },
      });
      await prisma().$executeRaw`
        UPDATE "trips" SET "status" = 'COMPLETED', "departure_at" = now() - interval '3 days',
          "started_at" = now() - interval '3 days', "completed_at" = now() - interval '2 days',
          "estimated_distance_km" = 64
        WHERE "id" = ${tripId}::uuid`;
      const stats = dataOf(
        TravelStatsSchema,
        await http().get('/api/v1/me/stats').set(as('alice')).expect(200),
      );
      expect(stats.enhanced).toMatchObject({
        completed: 1,
        distanceKm: 64,
        destinations: 1,
        companions: 1,
        byActivity: [{ activityType: 'MOTORCYCLE_RIDE', trips: 1 }],
      });
      expect(stats.enhanced!.byMonth).toHaveLength(1);
    });
  });

  describe('renewal, failure and expiry', () => {
    it('extends the paid period when a renewal is charged', async () => {
      const before = await mine('bob');
      const row = await prisma().subscription.findUniqueOrThrow({
        where: { id: before.subscription!.id },
      });
      const { sub, payment } = fake.renew(row.providerSubscriptionId!);
      await webhook('subscription.charged', {
        subscription: { entity: sub },
        payment: { entity: payment },
      }).expect(200);
      const after = await mine('bob');
      expect(new Date(after.subscription!.currentPeriodEnd!).getTime()).toBeGreaterThan(
        new Date(before.subscription!.currentPeriodEnd!).getTime() + 29 * DAY,
      );
      expect(after.subscription!.payments).toHaveLength(2);
      expect(after.subscription!.status).toBe('ACTIVE');
    });

    it('marks a failed renewal past due, keeps the paid month, then ends it when it lapses', async () => {
      const id = (await mine('bob')).subscription!.id;
      const row = await prisma().subscription.findUniqueOrThrow({ where: { id } });
      const { sub, payment } = fake.failRenewal(row.providerSubscriptionId!);
      await webhook('subscription.pending', {
        subscription: { entity: sub },
        payment: { entity: payment },
      }).expect(200);
      const pastDue = await mine('bob');
      expect(pastDue.subscription!.status).toBe('PAST_DUE');
      expect(pastDue.tier).toBe('ORGANISER_PRO');
      expect(pastDue.subscription!.payments[0]).toMatchObject({ status: 'FAILED' });
      expect((await notifications('bob')).some((n) => /didn't go through/.test(n.title))).toBe(
        true,
      );

      // Within the grace day after the period end, it still works.
      await endPeriod(id, 2 * HOUR);
      expect((await mine('bob')).tier).toBe('ORGANISER_PRO');
      // Past it, it stops at once, before any webhook or sweep.
      await endPeriod(id, 2 * DAY);
      expect((await mine('bob')).tier).toBe('FREE');
      expectUpgrade(
        await http().get('/api/v1/me/organiser/insights').set(as('bob')),
        'ORGANISER_PRO',
      );
      // The style is kept but no longer shown.
      const profile = dataOf(
        PublicProfileSchema,
        await http().get(`/api/v1/users/${prefix}_bob`).set(as('free')).expect(200),
      );
      expect(profile.style).toEqual({ accentColor: null, headline: null });

      // The sweep asks the provider (still retrying), then ends it.
      fake.subs.get(row.providerSubscriptionId!)!.status = 'halted';
      await app.get(SubscriptionsService).sweep();
      const ended = await mine('bob');
      expect(ended.subscription!.status).toBe('EXPIRED');
      expect(ended.subscription!.actions).toEqual([]);
      expect((await notifications('bob')).some((n) => n.title === 'Organiser Pro has ended')).toBe(
        true,
      );
    });
  });

  describe('cancellation', () => {
    it('stops renewals and keeps the paid month, then ends without another charge', async () => {
      const before = await mine('alice');
      const res = await http()
        .post('/api/v1/me/subscription/cancel')
        .set(as('alice'))
        .send({ reason: 'Trying it out' })
        .expect(200);
      const view = dataOf(MySubscriptionSchema, res);
      expect(view.tier).toBe('EXPLORER_PRO');
      expect(view.subscription).toMatchObject({
        status: 'CANCELLED',
        cancelAtPeriodEnd: true,
        renewsAt: null,
        entitled: true,
        currentPeriodEnd: before.subscription!.currentPeriodEnd,
        actions: [],
      });
      const row = await prisma().subscription.findUniqueOrThrow({
        where: { id: view.subscription!.id },
      });
      expect(fake.cancels).toContainEqual({ id: row.providerSubscriptionId, atCycleEnd: true });
      await http().post('/api/v1/me/subscription/cancel').set(as('alice')).send({}).expect(409);
      // A webhook from the provider while it runs out changes nothing.
      await webhook('subscription.updated', {
        subscription: { entity: fake.subs.get(row.providerSubscriptionId!) },
      }).expect(200);
      expect((await mine('alice')).subscription!.status).toBe('CANCELLED');
      // Subscribing again waits until the paid month ends.
      expect(
        ErrorBody.parse((await subscribe('alice', plan.explorer).expect(409)).body).message,
      ).toMatch(/runs until/);

      await endPeriod(row.id, HOUR);
      const after = await mine('alice');
      expect(after.tier).toBe('FREE');
      expect(after.subscription!.entitled).toBe(false);
      expectUpgrade(
        await http()
          .post('/api/v1/me/saved-searches')
          .set(as('alice'))
          .send({ name: 'Later', query: {} }),
        'EXPLORER_PRO',
      );
      // What was saved can still be seen and deleted; alerts stop.
      const saved = listOf(
        SavedSearchSchema,
        await http().get('/api/v1/me/saved-searches').set(as('alice')).expect(200),
      );
      expect(saved).toHaveLength(1);
      await createTrip('dan', { title: `${prefix} after cancel`, destination: place });
      const count = (await notifications('alice')).length;
      await app.get(ProFeaturesService).sendAlerts();
      expect((await notifications('alice')).length).toBe(count);

      await app.get(SubscriptionsService).sweep();
      const ended = await prisma().subscription.findUniqueOrThrow({ where: { id: row.id } });
      expect(ended.endedAt).not.toBeNull();
      expect((await notifications('alice')).some((n) => n.title === 'Explorer Pro has ended')).toBe(
        true,
      );
      // No renewal was ever charged.
      expect(fake.subs.get(row.providerSubscriptionId!)!.status).toBe('active');
      expect((await mine('alice')).subscription!.payments).toHaveLength(1);
      // And they can subscribe again.
      await subscribe('alice', plan.explorer).expect(201);
    });
  });

  describe('admin', () => {
    it('lets support read and operations change prices, for new subscriptions only', async () => {
      const plans = listOf(
        AdminPlanSchema,
        await http().get('/api/v1/admin/subscription-plans').set(as('support')).expect(200),
      );
      const explorer = plans.find((p) => p.code === plan.explorer)!;
      expect(explorer.providerPlanId).not.toBeNull();
      await http()
        .patch(`/api/v1/admin/subscription-plans/${explorer.id}`)
        .set(as('support'))
        .send({ pricePaise: 14_900, reason: 'New price' })
        .expect(403);
      await http()
        .patch(`/api/v1/admin/subscription-plans/${explorer.id}`)
        .set(as('ops'))
        .send({ pricePaise: 14_900 })
        .expect(400);
      const updated = dataOf(
        AdminPlanSchema,
        await http()
          .patch(`/api/v1/admin/subscription-plans/${explorer.id}`)
          .set(as('ops'))
          .send({ pricePaise: 14_900, reason: 'Launch price ended' })
          .expect(200),
      );
      expect(updated).toMatchObject({ pricePaise: 14_900, providerPlanId: null });
      const audit = await prisma().auditLog.findFirst({
        where: { action: 'subscription_plan.update', entityId: explorer.id },
      });
      expect(audit?.metadata).toMatchObject({ before: { pricePaise: EXPLORER_PRICE } });

      // Alice's waiting subscription keeps the price she was shown; a new one gets the new price.
      expect((await mine('alice')).subscription!.pricePaise).toBe(EXPLORER_PRICE);
      const plansBefore = fake.plans.size;
      const s = await started('erin', plan.explorer);
      expect(s.row.pricePaise).toBe(14_900);
      expect(fake.plans.size).toBe(plansBefore + 1);
      expect([...fake.plans.values()].at(-1)!.amount).toBe(14_900);
    });

    it('takes a plan off sale', async () => {
      const [organiser] = listOf(
        AdminPlanSchema,
        await http().get('/api/v1/admin/subscription-plans').set(as('ops')).expect(200),
      ).filter((p) => p.code === plan.organiser);
      await http()
        .patch(`/api/v1/admin/subscription-plans/${organiser!.id}`)
        .set(as('ops'))
        .send({ isActive: false, reason: 'Paused for review' })
        .expect(200);
      const open = dataOf(
        PlansResponseSchema,
        await http().get('/api/v1/subscriptions/plans').set(as('free')).expect(200),
      );
      expect(open.plans.some((p) => p.code === plan.organiser)).toBe(false);
      await subscribe('free', plan.organiser).expect(404);
      await http()
        .patch(`/api/v1/admin/subscription-plans/${organiser!.id}`)
        .set(as('ops'))
        .send({ isActive: true, reason: 'Back on sale' })
        .expect(200);
    });

    it('finds a subscription, ends it now and refunds the last payment', async () => {
      const s = await active('dan', plan.organiser);
      expect((await mine('dan')).tier).toBe('ORGANISER_PRO');
      const page = z
        .object({ data: z.array(AdminSubscriptionSchema) })
        .parse(
          (
            await http()
              .get(`/api/v1/admin/subscriptions?q=${prefix}_dan`)
              .set(as('support'))
              .expect(200)
          ).body,
        );
      expect(page.data).toHaveLength(1);
      expect(page.data[0]).toMatchObject({
        status: 'ACTIVE',
        actions: ['reconcile', 'cancel_now', 'refund_last'],
        user: { username: `${prefix}_dan` },
      });
      await http()
        .post(`/api/v1/admin/subscriptions/${s.row.id}/end`)
        .set(as('support'))
        .send({ refundLast: true, reason: 'Charged by mistake' })
        .expect(403);
      const ended = dataOf(
        AdminSubscriptionSchema,
        await http()
          .post(`/api/v1/admin/subscriptions/${s.row.id}/end`)
          .set(as('ops'))
          .send({ refundLast: true, reason: 'Charged by mistake' })
          .expect(200),
      );
      expect(ended).toMatchObject({ status: 'CANCELLED', entitled: false, actions: ['reconcile'] });
      expect(ended.payments[0]).toMatchObject({
        status: 'REFUNDED',
        refundedAmountPaise: ORGANISER_PRICE,
      });
      expect(fake.cancels).toContainEqual({ id: s.providerId, atCycleEnd: false });
      expect(fake.refunds.at(-1)).toMatchObject({ amount: ORGANISER_PRICE });
      expect((await mine('dan')).tier).toBe('FREE');
      const actions = await prisma().auditLog.findMany({
        where: { entityId: s.row.id },
        select: { action: true },
      });
      expect(actions.map((a) => a.action).sort()).toEqual([
        'subscription.end_now',
        'subscription.refund',
      ]);
      // Nothing more to end or refund.
      await http()
        .post(`/api/v1/admin/subscriptions/${s.row.id}/end`)
        .set(as('ops'))
        .send({ refundLast: true, reason: 'Charged by mistake' })
        .expect(409);
      // The provider's cancellation webhook arriving later doesn't bring it back.
      await webhook('subscription.cancelled', {
        subscription: { entity: fake.subs.get(s.providerId) },
      }).expect(200);
      expect((await mine('dan')).tier).toBe('FREE');
    });

    it('re-checks a subscription with the provider', async () => {
      const id = (await mine('erin')).subscription!.id;
      const res = await http()
        .post(`/api/v1/admin/subscriptions/${id}/reconcile`)
        .set(as('ops'))
        .expect(200);
      expect((res.body as { data: { result: string } }).data.result).toBe('unchanged');
    });
  });

  /** A published public ride organised by `name`. */
  async function createTrip(name: Name, overrides: Record<string, unknown> = {}) {
    const res = await http()
      .post('/api/v1/trips')
      .set(as(name))
      .send({
        mode: 'RIDE',
        activityType: 'MOTORCYCLE_RIDE',
        title: `${prefix} ride`,
        origin: { name: 'Kengeri', point: { latitude: 12.914321, longitude: 77.483456 } },
        destination: { name: 'Savandurga', point: { latitude: 12.9196, longitude: 77.2922 } },
        departureAt: new Date(Date.now() + 72 * HOUR).toISOString(),
        maxParticipants: 6,
        visibility: 'PUBLIC',
        ...overrides,
      })
      .expect(201);
    const trip = dataOf(TripSchema, res);
    await http().post(`/api/v1/trips/${trip.id}/publish`).set(as(name)).expect(200);
    tripIds.push(trip.id);
    return trip.id;
  }
});

describe('subscriptions switched off (e2e)', () => {
  let app: INestApplication<App>;
  const name = `suboff_${randomUUID().slice(0, 6)}`;

  beforeAll(async () => {
    app = await startAuthApp({
      PAYMENT_PROVIDER: 'razorpay',
      RAZORPAY_KEY_ID: 'rzp_test_e2e',
      RAZORPAY_KEY_SECRET: KEY_SECRET,
      RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      SUBSCRIPTIONS_ENABLED: 'false',
    });
  });

  afterAll(async () => {
    await app.get(PrismaService).user.deleteMany({ where: { username: name } });
    await app?.close();
  });

  it('shows the plans as not on sale and refuses to start one', async () => {
    await registerAndLogin(app, { email: `${name}@example.test`, username: name });
    const tokens = await login(app, `${name}@example.test`);
    const http = () => request(app.getHttpServer());
    const res = dataOf(
      PlansResponseSchema,
      await http()
        .get('/api/v1/subscriptions/plans')
        .set({ authorization: bearer(tokens) })
        .expect(200),
    );
    expect(res.unavailableReason).toBe('Paid plans are not on sale yet');
    expect(res.plans.every((p) => !p.available)).toBe(true);
    await http()
      .post('/api/v1/me/subscription')
      .set({ authorization: bearer(tokens) })
      .send({ planCode: 'EXPLORER_PRO_MONTHLY', idempotencyKey: newKey() })
      .expect(503);
  });
});
