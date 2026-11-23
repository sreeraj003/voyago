import 'reflect-metadata';
import 'dotenv/config';
import { type INestApplication } from '@nestjs/common';
import {
  AdminBookingDetailSchema,
  AdminBookingSummarySchema,
  type AuthTokens,
  type Booking,
  BookingSchema,
  OperatorBookingSchema,
  PackageDetailSchema,
  type StaffRole,
} from '@voyago/shared';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { type App } from 'supertest/types.js';
import { z } from 'zod';
import { PrismaService } from '../src/database/prisma.service.js';
import { setPointSql } from '../src/database/geo.js';
import { PaymentGateway } from '../src/payments/payment-gateway.js';
import { ReconciliationService } from '../src/payments/reconciliation.service.js';
import { bearer, login, registerAndLogin, startAuthApp } from './support/auth-helpers.js';

/**
 * Bookings and payments against a stand-in for Razorpay's API: confirmation only from the
 * provider's record, signatures, duplicate and late webhooks, refunds by the published schedule,
 * overselling, reconciliation, and the ledger adding up.
 */
const prefix = `pay_${randomUUID().slice(0, 6)}`;
const KEY_SECRET = 'e2e-key-secret';
const WEBHOOK_SECRET = 'e2e-webhook-secret';
const HOUR = 3_600_000;
const PRICE = 250_000;

const dataOf = <T>(schema: z.ZodType<T>, res: { body: unknown }) =>
  schema.parse((res.body as { data: unknown }).data);
const listOf = <T>(schema: z.ZodType<T>, res: { body: unknown }): T[] =>
  z.array(schema).parse((res.body as { data: unknown }).data);
const hmac = (secret: string, payload: string) =>
  createHmac('sha256', secret).update(payload).digest('hex');
const newKey = () => `k${randomUUID().replace(/-/g, '')}`;

const NAMES = ['owner', 'alice', 'bob', 'carol', 'dan', 'ops', 'support'] as const;
type Name = (typeof NAMES)[number];
const ROLES: Partial<Record<Name, StaffRole>> = { ops: 'OPERATIONS', support: 'SUPPORT' };
const email = (name: Name) => `${prefix}_${name}@example.test`;

type FakePayment = {
  id: string;
  order_id: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  amount: number;
  currency: string;
  fee: number | null;
  tax: number | null;
  method: string;
  error_code: string | null;
  error_description: string | null;
};
type FakeRefund = {
  id: string;
  payment_id: string;
  amount: number;
  status: 'pending' | 'processed' | 'failed';
};

/** Razorpay's Orders, Payments and Refunds APIs, in memory. */
class FakeRazorpay {
  orders = new Map<string, { id: string; amount: number; currency: string }>();
  payments = new Map<string, FakePayment>();
  refunds = new Map<string, FakeRefund>();
  /** How the next refunds answer. */
  refundMode: 'processed' | 'pending' | 'error' = 'processed';
  failOrders = false;
  calls: string[] = [];
  private n = 0;

  pay(orderId: string, status: FakePayment['status'] = 'captured', amount?: number): FakePayment {
    const order = this.orders.get(orderId)!;
    const id = `pay_${++this.n}${randomUUID().slice(0, 6)}`;
    const amt = amount ?? order.amount;
    const payment: FakePayment = {
      id,
      order_id: orderId,
      status,
      amount: amt,
      currency: order.currency,
      fee: status === 'captured' ? Math.round(amt * 0.0236) : null,
      tax: status === 'captured' ? Math.round(amt * 0.0036) : null,
      method: 'upi',
      error_code: status === 'failed' ? 'BAD_REQUEST_ERROR' : null,
      error_description: status === 'failed' ? 'Payment was declined by the bank' : null,
    };
    this.payments.set(id, payment);
    return payment;
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
      return json(401, {
        error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' },
      });
    }
    let m: RegExpExecArray | null;
    if (method === 'POST' && path === '/orders') {
      if (this.failOrders) return json(500, { error: { description: 'Server error' } });
      const order = {
        id: `order_${++this.n}${randomUUID().slice(0, 6)}`,
        amount: Number(body.amount),
        currency: String(body.currency),
      };
      this.orders.set(order.id, order);
      return json(200, { ...order, status: 'created' });
    }
    if ((m = /^\/orders\/([^/]+)\/payments$/.exec(path))) {
      return json(200, { items: [...this.payments.values()].filter((p) => p.order_id === m![1]) });
    }
    if ((m = /^\/payments\/([^/]+)\/capture$/.exec(path)) && method === 'POST') {
      const p = this.payments.get(m[1]!);
      if (!p) return json(404, { error: { description: 'No such payment' } });
      if (Number(body.amount) !== p.amount)
        return json(400, { error: { description: 'Amount mismatch' } });
      Object.assign(p, {
        status: 'captured',
        fee: Math.round(p.amount * 0.0236),
        tax: Math.round(p.amount * 0.0036),
      });
      return json(200, p);
    }
    if ((m = /^\/payments\/([^/]+)\/refund$/.exec(path)) && method === 'POST') {
      if (this.refundMode === 'error')
        return json(400, { error: { description: 'Refund could not be processed' } });
      const r: FakeRefund = {
        id: `rfnd_${++this.n}${randomUUID().slice(0, 6)}`,
        payment_id: m[1]!,
        amount: Number(body.amount),
        status: this.refundMode,
      };
      this.refunds.set(r.id, r);
      return json(200, r);
    }
    if ((m = /^\/payments\/([^/]+)\/refunds\/([^/]+)$/.exec(path))) {
      const r = this.refunds.get(m[2]!);
      return r ? json(200, r) : json(404, { error: { description: 'No such refund' } });
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

describe('bookings and payments (e2e)', () => {
  let app: INestApplication<App>;
  const tokens = {} as Record<Name, AuthTokens>;
  const ids = {} as Record<Name, string>;
  const http = () => request(app.getHttpServer());
  const prisma = () => app.get(PrismaService);
  const as = (name: Name) => ({ authorization: bearer(tokens[name]) });
  const fake = new FakeRazorpay();
  const startedAt = new Date();
  let operatorId = '';
  const packageIds: string[] = [];

  /** A published package of the verified operator, starting `hours` from now. */
  async function makePackage(opts: { hours?: number; capacity?: number } = {}) {
    const startsAt = new Date(Date.now() + (opts.hours ?? 24 * 10) * HOUR);
    const pkg = await prisma().commercialPackage.create({
      data: {
        operatorId,
        mode: 'TRAVEL',
        activityType: 'TREK',
        title: `${prefix} trek ${packageIds.length + 1}`,
        destinationName: 'Kudremukh',
        durationDays: 2,
        pricePaise: PRICE,
        maxGroupSize: opts.capacity ?? 10,
        inclusions: ['Guide'],
        cancellationPolicy: 'Full refund up to 7 days before; 50% up to 48 hours before.',
        refundTiers: [
          { hoursBefore: 168, refundPercent: 100 },
          { hoursBefore: 48, refundPercent: 50 },
        ],
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * HOUR),
        meetingPointName: 'Mullodi village',
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
    });
    await prisma().$executeRaw(
      setPointSql('commercial_packages', 'meeting_point', pkg.id, {
        latitude: 13.123456,
        longitude: 75.271234,
      }),
    );
    packageIds.push(pkg.id);
    return pkg.id;
  }

  const book = (name: Name, packageId: string, seats = 1, key = newKey()) =>
    http()
      .post(`/api/v1/packages/${packageId}/bookings`)
      .set(as(name))
      .send({ seats, idempotencyKey: key, returnUrl: 'voyago://bookings/return' });

  async function hold(name: Name, packageId: string, seats = 1): Promise<Booking> {
    return dataOf(BookingSchema, await book(name, packageId, seats).expect(201));
  }

  const view = async (name: Name, id: string) =>
    dataOf(BookingSchema, await http().get(`/api/v1/bookings/${id}`).set(as(name)).expect(200));

  const orderOf = async (bookingId: string) =>
    (
      await prisma().payment.findFirstOrThrow({
        where: { bookingId },
        orderBy: { createdAt: 'desc' },
      })
    ).providerOrderId!;

  /** The checkout's post back to the API, as the provider's page would send it. */
  function checkoutReturn(booking: Booking, fields: Record<string, string>) {
    const url = new URL(booking.checkoutUrl!);
    return http().post(`${url.pathname}/razorpay${url.search}`).type('form').send(fields);
  }

  function webhook(
    event: string,
    payload: Record<string, unknown>,
    eventId = `evt_${randomUUID()}`,
    secret = WEBHOOK_SECRET,
  ) {
    const body = JSON.stringify({ entity: 'event', event, payload });
    return http()
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', hmac(secret, body))
      .set('x-razorpay-event-id', eventId)
      .send(body);
  }

  /** Pays a hold at the provider and tells the API by webhook. */
  async function payByWebhook(booking: Booking) {
    const p = fake.pay(await orderOf(booking.id));
    await webhook('payment.captured', { payment: { entity: p } }).expect(200);
    return p;
  }

  async function ledgerOf(bookingId: string) {
    const rows = await prisma().ledgerEntry.findMany({ where: { bookingId } });
    const sum = (kind: string) =>
      rows.filter((r) => r.kind === kind).reduce((s, r) => s + r.amountPaise, 0);
    return { rows, sum };
  }

  beforeAll(async () => {
    app = await startAuthApp({
      PAYMENT_PROVIDER: 'razorpay',
      RAZORPAY_KEY_ID: 'rzp_test_e2e',
      RAZORPAY_KEY_SECRET: KEY_SECRET,
      RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PLATFORM_COMMISSION_BPS: '1000',
      COMMISSION_TAX_BPS: '1800',
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
    const operator = await prisma().commercialOperator.create({
      data: {
        category: 'TREKKING',
        ownerUserId: ids.owner,
        slug: `${prefix}-treks`,
        legalName: 'Payments Test Treks Pvt Ltd',
        displayName: `${prefix} Treks`,
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
        verifiedById: ids.ops,
      },
    });
    operatorId = operator.id;
  });

  afterAll(async () => {
    const userIds = Object.values(ids);
    const bookings = await prisma().booking.findMany({
      where: { packageId: { in: packageIds } },
      select: { id: true },
    });
    const bookingIds = bookings.map((b) => b.id);
    await prisma().$transaction(async (tx) => {
      // The ledger is append-only; test cleanup is the one sanctioned exception.
      await tx.$executeRaw`SELECT set_config('voyago.ledger_maintenance', 'on', true)`;
      await tx.ledgerEntry.deleteMany({ where: { bookingId: { in: bookingIds } } });
    });
    await prisma().paymentEvent.deleteMany({
      where: {
        OR: [
          { bookingId: { in: bookingIds } },
          { receivedAt: { gte: startedAt }, signatureValid: false },
        ],
      },
    });
    await prisma().refund.deleteMany({ where: { bookingId: { in: bookingIds } } });
    await prisma().payment.deleteMany({ where: { bookingId: { in: bookingIds } } });
    await prisma().booking.deleteMany({ where: { id: { in: bookingIds } } });
    await prisma().commercialPackage.deleteMany({ where: { id: { in: packageIds } } });
    await prisma().commercialOperator.deleteMany({ where: { id: operatorId } });
    await prisma().user.deleteMany({ where: { id: { in: userIds } } });
    await app?.close();
  });

  describe('booking', () => {
    it('shows the refund schedule and opens booking when payments are set up', async () => {
      const id = await makePackage();
      const detail = dataOf(
        PackageDetailSchema,
        await http().get(`/api/v1/packages/${id}`).set(as('alice')).expect(200),
      );
      expect(detail).toMatchObject({
        bookingOpen: true,
        bookingClosedReason: null,
        refundTiers: [
          { hoursBefore: 168, refundPercent: 100 },
          { hoursBefore: 48, refundPercent: 50 },
        ],
        viewer: { bookingId: null },
      });
      const own = dataOf(
        PackageDetailSchema,
        await http().get(`/api/v1/packages/${id}`).set(as('owner')).expect(200),
      );
      expect(own).toMatchObject({
        bookingOpen: false,
        bookingClosedReason: 'This is your package',
      });
    });

    it('validates the request and prices on the server', async () => {
      const id = await makePackage();
      for (const body of [
        { seats: 0, idempotencyKey: newKey() },
        { seats: 11, idempotencyKey: newKey() },
        { seats: 1.5, idempotencyKey: newKey() },
        { seats: 1, idempotencyKey: 'short' },
        { seats: 1 },
        { seats: 1, idempotencyKey: newKey(), returnUrl: 'https://evil.example/steal' },
      ]) {
        const res = await http()
          .post(`/api/v1/packages/${id}/bookings`)
          .set(as('alice'))
          .send(body);
        expect([res.status, body]).toEqual([400, body]);
      }
      // A price or commission in the body is ignored: the server prices from the package.
      const res = await http()
        .post(`/api/v1/packages/${id}/bookings`)
        .set(as('alice'))
        .send({ seats: 2, idempotencyKey: newKey(), totalAmountPaise: 1, commissionBps: 0 })
        .expect(201);
      const booking = dataOf(BookingSchema, res);
      expect(booking).toMatchObject({
        status: 'PENDING_PAYMENT',
        seats: 2,
        totalAmountPaise: 2 * PRICE,
        currency: 'INR',
      });
      const row = await prisma().booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(row).toMatchObject({
        commissionBps: 1000,
        commissionPaise: 50_000,
        commissionTaxPaise: 9_000,
        operatorPayablePaise: 441_000,
      });
      const order = fake.orders.get(await orderOf(booking.id))!;
      expect(order).toMatchObject({ amount: 2 * PRICE, currency: 'INR' });

      await book('owner', id).expect(403);
      await book('alice', randomUUID()).expect(404);
      await http()
        .post(`/api/v1/packages/${id}/bookings`)
        .send({ seats: 1, idempotencyKey: newKey() })
        .expect(401);
    });

    it('returns the same booking for a repeated key, and keeps one hold per package', async () => {
      const id = await makePackage();
      const key = newKey();
      const first = dataOf(BookingSchema, await book('bob', id, 1, key).expect(201));
      const again = dataOf(BookingSchema, await book('bob', id, 1, key).expect(201));
      expect(again.id).toBe(first.id);
      const other = dataOf(BookingSchema, await book('bob', id, 1).expect(201));
      expect(other.id).toBe(first.id);
      expect(fake.orders.size).toBeGreaterThan(0);
      expect(await prisma().booking.count({ where: { userId: ids.bob, packageId: id } })).toBe(1);
      // Someone else's booking is not visible.
      await http().get(`/api/v1/bookings/${first.id}`).set(as('alice')).expect(404);
      // The payment link can return to the app, and only to the app.
      await http()
        .get(`/api/v1/bookings/${first.id}`)
        .query({ returnUrl: 'https://evil.example/' })
        .set(as('bob'))
        .expect(400);
      const linked = dataOf(
        BookingSchema,
        await http()
          .get(`/api/v1/bookings/${first.id}`)
          .query({ returnUrl: 'voyago://bookings' })
          .set(as('bob'))
          .expect(200),
      );
      expect(new URL(linked.checkoutUrl!).searchParams.get('r')).toBe('voyago://bookings');
    });

    it('releases the places when the provider cannot create an order', async () => {
      const id = await makePackage({ capacity: 1 });
      fake.failOrders = true;
      await book('carol', id).expect(503);
      fake.failOrders = false;
      const ok = await hold('dan', id);
      expect(ok.status).toBe('PENDING_PAYMENT');
    });

    it('never oversells, even with parallel requests for the last places', async () => {
      const id = await makePackage({ capacity: 3 });
      const results = await Promise.all(
        (['alice', 'bob', 'carol', 'dan'] as const).map((name) => book(name, id, 2)),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409]);
      const conflict = results.find((r) => r.status === 409)!;
      expect((conflict.body as { message: string }).message).toMatch(/Only 1 place is left/);
      const held = await prisma().booking.aggregate({
        where: { packageId: id, status: { in: ['PENDING_PAYMENT', 'CONFIRMED'] } },
        _sum: { seats: true },
      });
      expect(held._sum.seats).toBe(2);
    });
  });

  describe('paying', () => {
    it('confirms from the checkout return only after checking with the provider', async () => {
      const id = await makePackage();
      const booking = await hold('alice', id, 2);
      expect(booking.actions).toContain('pay');
      expect(booking.package.meetingPoint).toBeNull();

      const page = await http()
        .get(new URL(booking.checkoutUrl!).pathname + new URL(booking.checkoutUrl!).search)
        .expect(200);
      const orderId = await orderOf(booking.id);
      expect(page.text).toContain(orderId);
      expect(page.text).toContain('rzp_test_e2e');
      expect(page.text).not.toContain(KEY_SECRET);
      expect(page.headers['content-security-policy']).toMatch(
        /script-src 'nonce-[^']+' https:\/\/checkout\.razorpay\.com/,
      );
      // A tampered link is refused.
      await http().get(`/api/v1/checkout/${booking.id}?e=1&r=&s=forged`).expect(400);

      const payment = fake.pay(orderId, 'authorized');
      // A forged signature confirms nothing.
      const forged = await checkoutReturn(booking, {
        razorpay_payment_id: payment.id,
        razorpay_order_id: orderId,
        razorpay_signature: hmac('wrong', `${orderId}|${payment.id}`),
      }).expect(303);
      expect(forged.headers.location).toContain('payment=failed');
      expect((await view('alice', booking.id)).status).toBe('PENDING_PAYMENT');

      const res = await checkoutReturn(booking, {
        razorpay_payment_id: payment.id,
        razorpay_order_id: orderId,
        razorpay_signature: hmac(KEY_SECRET, `${orderId}|${payment.id}`),
      }).expect(303);
      expect(res.headers.location).toBe(
        `voyago://bookings/return?booking=${booking.id}&payment=paid`,
      );
      expect(fake.calls).toContain(`POST /payments/${payment.id}/capture`);

      const confirmed = await view('alice', booking.id);
      expect(confirmed).toMatchObject({
        status: 'CONFIRMED',
        payment: { status: 'CAPTURED' },
        package: {
          meetingPoint: {
            name: 'Mullodi village',
            point: { latitude: 13.123456, longitude: 75.271234 },
          },
        },
        cancellation: { refundPercent: 100, refundPaise: 2 * PRICE },
        checkoutUrl: null,
      });
      expect(confirmed.actions).toEqual(['cancel']);

      const { sum, rows } = await ledgerOf(booking.id);
      expect(sum('GROSS')).toBe(2 * PRICE);
      expect(sum('COMMISSION')).toBe(50_000);
      expect(sum('COMMISSION_TAX')).toBe(9_000);
      expect(sum('OPERATOR_PAYABLE')).toBe(441_000);
      expect(sum('PROVIDER_FEE') + sum('PROVIDER_FEE_TAX')).toBe(Math.round(2 * PRICE * 0.0236));
      expect(sum('PROVIDER_FEE_TAX')).toBe(Math.round(2 * PRICE * 0.0036));
      expect(rows.every((r) => Number.isInteger(r.amountPaise) && r.currency === 'INR')).toBe(true);

      // Both sides hear about it.
      const notes = await prisma().notification.findMany({
        where: {
          userId: { in: [ids.alice, ids.owner] },
          type: 'BOOKING_UPDATE',
          createdAt: { gte: startedAt },
        },
      });
      expect(notes.map((n) => n.userId).sort()).toEqual([ids.alice, ids.owner].sort());

      // The provider's webhook for the same payment changes nothing.
      const before = rows.length;
      const eventId = `evt_${randomUUID()}`;
      const p = fake.payments.get(payment.id)!;
      await webhook('payment.captured', { payment: { entity: p } }, eventId).expect(200);
      const dup = await webhook('payment.captured', { payment: { entity: p } }, eventId).expect(
        200,
      );
      expect(dup.body).toEqual({ status: 'duplicate' });
      expect((await ledgerOf(booking.id)).rows.length).toBe(before);
      expect((await view('alice', booking.id)).status).toBe('CONFIRMED');

      // The business sees the booking with the customer's name only.
      const list = listOf(
        OperatorBookingSchema,
        await http()
          .get('/api/v1/me/operator/bookings')
          .query({ packageId: id })
          .set(as('owner'))
          .expect(200),
      );
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        seats: 2,
        operatorPayablePaise: 441_000,
        customer: { username: `${prefix}_alice` },
      });
      expect(JSON.stringify(list)).not.toContain('@example.test');
    });

    it('keeps a failed attempt on record and lets the customer pay again', async () => {
      const id = await makePackage();
      const booking = await hold('bob', id);
      const orderId = await orderOf(booking.id);
      const failed = fake.pay(orderId, 'failed');
      const res = await checkoutReturn(booking, {
        'error[code]': 'BAD_REQUEST_ERROR',
        'error[description]': 'Payment failed',
        'error[metadata]': JSON.stringify({ payment_id: failed.id, order_id: orderId }),
      }).expect(303);
      expect(res.headers.location).toContain('payment=failed');
      const after = await view('bob', booking.id);
      expect(after).toMatchObject({
        status: 'PENDING_PAYMENT',
        payment: { status: 'FAILED', failureReason: 'Payment was declined by the bank' },
      });
      expect(after.actions).toContain('pay');

      // A webhook for the failure is harmless, and a later success confirms.
      await webhook('payment.failed', { payment: { entity: failed } }).expect(200);
      await payByWebhook(booking);
      expect((await view('bob', booking.id)).status).toBe('CONFIRMED');
    });

    it('rejects webhooks with a bad signature and keeps them for investigation', async () => {
      const id = await makePackage();
      const booking = await hold('carol', id);
      const p = fake.pay(await orderOf(booking.id));
      await webhook(
        'payment.captured',
        { payment: { entity: p } },
        `evt_${randomUUID()}`,
        'not-the-secret',
      ).expect(400);
      await http()
        .post('/api/v1/webhooks/razorpay')
        .set('content-type', 'application/json')
        .send(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: p } } }))
        .expect(400);
      expect((await view('carol', booking.id)).status).toBe('PENDING_PAYMENT');
      const stored = await prisma().paymentEvent.findMany({
        where: { signatureValid: false, receivedAt: { gte: startedAt } },
      });
      expect(stored.length).toBeGreaterThanOrEqual(2);
      // Only ids, statuses and amounts are kept.
      expect(JSON.stringify(stored[0]!.summary)).not.toMatch(/email|contact|card/);
    });

    it('does not confirm a payment whose amount does not match', async () => {
      const id = await makePackage();
      const booking = await hold('dan', id);
      const p = fake.pay(await orderOf(booking.id), 'captured', 100);
      await webhook('payment.captured', { payment: { entity: p } }).expect(200);
      expect((await view('dan', booking.id)).status).toBe('PENDING_PAYMENT');
      const payment = await prisma().payment.findFirstOrThrow({ where: { bookingId: booking.id } });
      expect(payment).toMatchObject({ failureCode: 'AMOUNT_MISMATCH', capturedAt: null });
      expect(await prisma().ledgerEntry.count({ where: { bookingId: booking.id } })).toBe(0);

      const flagged = listOf(
        AdminBookingSummarySchema,
        await http()
          .get('/api/v1/admin/bookings')
          .query({ attention: 'true', limit: 50 })
          .set(as('support'))
          .expect(200),
      );
      expect(flagged.map((b) => b.id)).toContain(booking.id);
    });

    it('confirms a payment that arrives after the hold ran out, if places are left', async () => {
      const id = await makePackage({ capacity: 2 });
      const booking = await hold('alice', id);
      await prisma().booking.update({
        where: { id: booking.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      // The sweep finds no payment yet, so the hold lapses.
      fake.calls = [];
      await app.get(ReconciliationService).sweep();
      expect((await prisma().booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
        'EXPIRED',
      );

      await payByWebhook(booking);
      expect((await view('alice', booking.id)).status).toBe('CONFIRMED');
    });

    it('refunds a late payment in full when the places were taken meanwhile', async () => {
      const id = await makePackage({ capacity: 1 });
      const late = await hold('bob', id);
      await prisma().booking.update({
        where: { id: late.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      await app.get(ReconciliationService).sweep();
      const taker = await hold('carol', id);
      await payByWebhook(taker);

      fake.refundMode = 'processed';
      await payByWebhook(late);
      const after = await view('bob', late.id);
      expect(after).toMatchObject({ status: 'REFUNDED', refundedAmountPaise: PRICE });
      expect(after.refunds).toMatchObject([
        { status: 'PROCESSED', initiator: 'SYSTEM', amountPaise: PRICE },
      ]);
      const { sum } = await ledgerOf(late.id);
      expect(sum('GROSS') + sum('REFUND')).toBe(0);
      expect(sum('COMMISSION') + sum('COMMISSION_REVERSAL')).toBe(0);
      expect(sum('OPERATOR_PAYABLE') + sum('OPERATOR_PAYABLE_REVERSAL')).toBe(0);
      expect((await view('carol', taker.id)).status).toBe('CONFIRMED');
    });
  });

  describe('cancelling and refunds', () => {
    it('refunds everything when cancelled before the first cut-off', async () => {
      const id = await makePackage({ hours: 24 * 10 });
      const booking = await hold('alice', id, 2);
      await payByWebhook(booking);
      const res = await http()
        .post(`/api/v1/bookings/${booking.id}/cancel`)
        .set(as('alice'))
        .send({ reason: 'Plans changed' })
        .expect(200);
      const after = dataOf(BookingSchema, res);
      expect(after).toMatchObject({
        status: 'REFUNDED',
        refundedAmountPaise: 2 * PRICE,
        cancelledBy: 'CUSTOMER',
        payment: { status: 'REFUNDED' },
      });
      expect(after.refunds).toMatchObject([{ refundPercent: 100, status: 'PROCESSED' }]);
      // Places are free again.
      const detail = dataOf(
        PackageDetailSchema,
        await http().get(`/api/v1/packages/${id}`).set(as('bob')).expect(200),
      );
      expect(detail.seatsLeft).toBe(10);
      // Cancelling twice does nothing more.
      await http()
        .post(`/api/v1/bookings/${booking.id}/cancel`)
        .set(as('alice'))
        .send({})
        .expect(409);
      expect(await prisma().refund.count({ where: { bookingId: booking.id } })).toBe(1);
    });

    it('refunds part by the schedule, and the ledger splits it proportionally', async () => {
      const id = await makePackage({ hours: 72 });
      const booking = await hold('bob', id, 3);
      await payByWebhook(booking);
      const total = 3 * PRICE;
      expect((await view('bob', booking.id)).cancellation).toEqual({
        refundPercent: 50,
        refundPaise: total / 2,
      });
      const after = dataOf(
        BookingSchema,
        await http()
          .post(`/api/v1/bookings/${booking.id}/cancel`)
          .set(as('bob'))
          .send({})
          .expect(200),
      );
      expect(after).toMatchObject({
        status: 'CANCELLED',
        refundedAmountPaise: total / 2,
        payment: { status: 'PARTIALLY_REFUNDED' },
      });

      const { sum } = await ledgerOf(booking.id);
      const kept = sum('GROSS') + sum('REFUND');
      expect(kept).toBe(total / 2);
      const commission = sum('COMMISSION') + sum('COMMISSION_REVERSAL');
      const tax = sum('COMMISSION_TAX') + sum('COMMISSION_TAX_REVERSAL');
      const payable = sum('OPERATOR_PAYABLE') + sum('OPERATOR_PAYABLE_REVERSAL');
      expect(commission + tax + payable).toBe(kept);
      expect(commission).toBe(37_500);

      // The operator was told.
      expect(
        await prisma().notification.count({
          where: { userId: ids.owner, data: { path: ['packageId'], equals: id } },
        }),
      ).toBeGreaterThanOrEqual(2);
    });

    it('waits for the provider when a refund is pending, then settles it from the webhook', async () => {
      const id = await makePackage();
      const booking = await hold('carol', id);
      await payByWebhook(booking);
      fake.refundMode = 'pending';
      const after = dataOf(
        BookingSchema,
        await http()
          .post(`/api/v1/bookings/${booking.id}/cancel`)
          .set(as('carol'))
          .send({})
          .expect(200),
      );
      expect(after).toMatchObject({
        status: 'CANCELLED',
        refundedAmountPaise: 0,
        refunds: [{ status: 'PENDING' }],
      });
      fake.refundMode = 'processed';
      const refund = [...fake.refunds.values()].at(-1)!;
      refund.status = 'processed';
      await webhook('refund.processed', { refund: { entity: refund } }).expect(200);
      expect(await view('carol', booking.id)).toMatchObject({
        status: 'REFUNDED',
        refundedAmountPaise: PRICE,
        refunds: [{ status: 'PROCESSED' }],
      });
      // A repeat of the event (new id, same refund) changes nothing.
      await webhook('refund.processed', { refund: { entity: refund } }).expect(200);
      expect((await view('carol', booking.id)).refundedAmountPaise).toBe(PRICE);
    });

    it('lets the business cancel with a full refund, whatever the schedule says', async () => {
      const id = await makePackage({ hours: 30 });
      const booking = await hold('dan', id, 2);
      await payByWebhook(booking);
      expect((await view('dan', booking.id)).cancellation).toEqual({
        refundPercent: 0,
        refundPaise: 0,
      });
      await http()
        .post(`/api/v1/me/operator/bookings/${booking.id}/cancel`)
        .set(as('alice'))
        .send({ reason: 'Not mine' })
        .expect(404);
      await http()
        .post(`/api/v1/me/operator/bookings/${booking.id}/cancel`)
        .set(as('owner'))
        .send({ reason: 'Heavy rain warning on the trail' })
        .expect(204);
      expect(await view('dan', booking.id)).toMatchObject({
        status: 'REFUNDED',
        cancelledBy: 'OPERATOR',
        refundedAmountPaise: 2 * PRICE,
      });
    });

    it('records a failed refund, flags it, and lets operations retry it', async () => {
      const id = await makePackage();
      const booking = await hold('alice', id);
      await payByWebhook(booking);
      fake.refundMode = 'error';
      const after = dataOf(
        BookingSchema,
        await http()
          .post(`/api/v1/bookings/${booking.id}/cancel`)
          .set(as('alice'))
          .send({})
          .expect(200),
      );
      expect(after).toMatchObject({ status: 'CANCELLED', refunds: [{ status: 'FAILED' }] });

      const detail = dataOf(
        AdminBookingDetailSchema,
        await http().get(`/api/v1/admin/bookings/${booking.id}`).set(as('support')).expect(200),
      );
      expect(detail.needsAttention).toBe(true);
      expect(detail.actions).toContain('retry_refund');
      const refundId = detail.refunds[0]!.id;
      expect(detail.refunds[0]!.failureReason).toBeTruthy();
      // Support can look but not move money.
      await http().post(`/api/v1/admin/refunds/${refundId}/retry`).set(as('support')).expect(403);
      await http().get(`/api/v1/admin/bookings/${booking.id}`).set(as('bob')).expect(403);

      fake.refundMode = 'processed';
      const retried = dataOf(
        AdminBookingDetailSchema,
        await http().post(`/api/v1/admin/refunds/${refundId}/retry`).set(as('ops')).expect(200),
      );
      expect(retried).toMatchObject({
        status: 'REFUNDED',
        needsAttention: false,
        refunds: [{ status: 'PROCESSED' }],
      });
      await http().post(`/api/v1/admin/refunds/${refundId}/retry`).set(as('ops')).expect(409);
      expect(
        await prisma().auditLog.count({
          where: { actorId: ids.ops, action: 'refund.retry', entityId: refundId },
        }),
      ).toBe(1);
    });

    it('lets operations make a goodwill refund or refund everything', async () => {
      const id = await makePackage();
      const booking = await hold('bob', id, 2);
      await payByWebhook(booking);
      const url = `/api/v1/admin/bookings/${booking.id}/refund`;
      await http().post(url).set(as('ops')).send({ amountPaise: 10_000 }).expect(400);
      await http()
        .post(url)
        .set(as('ops'))
        .send({ amountPaise: 10_000.5, reason: 'Guide arrived late' })
        .expect(400);
      await http()
        .post(url)
        .set(as('ops'))
        .send({ amountPaise: 2 * PRICE + 1, reason: 'Too much money' })
        .expect(409);
      const partial = dataOf(
        AdminBookingDetailSchema,
        await http()
          .post(url)
          .set(as('ops'))
          .send({ amountPaise: 10_000, reason: 'Guide arrived late' })
          .expect(200),
      );
      expect(partial).toMatchObject({ status: 'CONFIRMED', refundedAmountPaise: 10_000 });

      const full = dataOf(
        AdminBookingDetailSchema,
        await http()
          .post(url)
          .set(as('ops'))
          .send({ reason: 'Customer was taken ill' })
          .expect(200),
      );
      expect(full).toMatchObject({
        status: 'REFUNDED',
        cancelledBy: 'ADMIN',
        refundedAmountPaise: 2 * PRICE,
      });
      expect(full.actions).not.toContain('refund');
      await http().post(url).set(as('ops')).send({ reason: 'Once more please' }).expect(409);
      const { sum } = await ledgerOf(booking.id);
      expect(sum('GROSS') + sum('REFUND')).toBe(0);
      expect(sum('COMMISSION_TAX') + sum('COMMISSION_TAX_REVERSAL')).toBe(0);
      expect(
        await prisma().auditLog.count({
          where: { actorId: ids.ops, action: 'booking.refund', entityId: booking.id },
        }),
      ).toBe(2);
    });
  });

  describe('reconciliation', () => {
    it('confirms a payment the provider has even if no return or webhook arrived', async () => {
      const id = await makePackage();
      const booking = await hold('carol', id);
      fake.pay(await orderOf(booking.id), 'authorized');
      await http()
        .post(`/api/v1/admin/bookings/${booking.id}/reconcile`)
        .set(as('support'))
        .expect(403);
      const res = await http()
        .post(`/api/v1/admin/bookings/${booking.id}/reconcile`)
        .set(as('ops'))
        .expect(200);
      expect(
        (res.body as { data: { summary: { payments: string[] } } }).data.summary.payments,
      ).toContain('confirmed');
      expect((await view('carol', booking.id)).status).toBe('CONFIRMED');
      const detail = dataOf(
        AdminBookingDetailSchema,
        await http().get(`/api/v1/admin/bookings/${booking.id}`).set(as('ops')).expect(200),
      );
      expect(detail.payments[0]).toMatchObject({ status: 'CAPTURED', method: 'upi' });
      expect(detail.ledger.length).toBe(6);
      expect(
        await prisma().auditLog.count({
          where: { action: 'booking.reconcile', entityId: booking.id },
        }),
      ).toBe(1);
    });

    it('finds bookings by customer, package or provider id', async () => {
      const id = await makePackage();
      const booking = await hold('dan', id);
      const orderId = await orderOf(booking.id);
      for (const q of [`${prefix}_dan`, orderId, booking.id]) {
        const found = listOf(
          AdminBookingSummarySchema,
          await http()
            .get('/api/v1/admin/bookings')
            .query({ q, limit: 50 })
            .set(as('support'))
            .expect(200),
        );
        expect(found.map((b) => b.id)).toContain(booking.id);
      }
    });

    it('keeps the ledger append-only', async () => {
      const entry = await prisma().ledgerEntry.findFirstOrThrow({ where: { operatorId } });
      await expect(prisma().ledgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow();
      await expect(
        prisma().ledgerEntry.update({ where: { id: entry.id }, data: { amountPaise: 1 } }),
      ).rejects.toThrow();
    });
  });

  it('refuses bookings when no payment provider is set up', async () => {
    const id = await makePackage();
    const closed = await startAuthApp();
    try {
      const server = closed.getHttpServer();
      const detail = dataOf(
        PackageDetailSchema,
        await request(server).get(`/api/v1/packages/${id}`).set(as('alice')).expect(200),
      );
      expect(detail).toMatchObject({
        bookingOpen: false,
        bookingClosedReason: 'Online booking is not available yet',
      });
      await request(server)
        .post(`/api/v1/packages/${id}/bookings`)
        .set(as('alice'))
        .send({ seats: 1, idempotencyKey: newKey() })
        .expect(503);
      await request(server)
        .post('/api/v1/webhooks/razorpay')
        .set('content-type', 'application/json')
        .send('{}')
        .expect(400);
    } finally {
      await closed.close();
    }
  });
});
