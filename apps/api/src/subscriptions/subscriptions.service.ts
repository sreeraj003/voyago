import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ALWAYS_FREE,
  ENTITLEMENTS_BY_TIER,
  formatPaise,
  type MySubscription,
  type Plan,
  type PlansResponse,
  RENEWAL_REMINDER_DAYS,
  type SubscribeSchema,
  type Subscription,
  SUBSCRIPTION_TERMS,
} from '@voyago/shared';
import { type z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { CheckoutTokens } from '../payments/checkout-tokens.js';
import { type RazorpayWebhook, PaymentEventsService } from '../payments/payment-events.service.js';
import {
  fromRazorpayPayment,
  type GatewayPayment,
  type GatewaySubscription,
  PaymentGateway,
  PaymentProviderError,
} from '../payments/payment-gateway.js';
import { isEntitled } from './entitlements.service.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** The first-payment link works this long; an unpaid subscription is dropped after a day. */
const CHECKOUT_LINK_MS = HOUR_MS;
const PENDING_TTL_MS = DAY_MS;
/** Monthly charges the provider is allowed to make before the member must subscribe again. */
const TOTAL_CYCLES = { MONTHLY: 60, YEARLY: 5 } as const;
const SWEEP_MS = 10 * 60_000;

export const subscriptionSelect = {
  id: true,
  userId: true,
  status: true,
  pricePaise: true,
  currency: true,
  currentPeriodStart: true,
  currentPeriodEnd: true,
  cancelAtPeriodEnd: true,
  cancelledAt: true,
  cancellationReason: true,
  endedAt: true,
  provider: true,
  providerSubscriptionId: true,
  providerStatus: true,
  createdAt: true,
  plan: { select: { code: true, tier: true, name: true, billingInterval: true } },
  payments: {
    select: {
      id: true,
      amountPaise: true,
      refundedAmountPaise: true,
      currency: true,
      status: true,
      failureReason: true,
      createdAt: true,
      capturedAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 12,
  },
} as const satisfies Prisma.SubscriptionSelect;

export type SubscriptionRow = Prisma.SubscriptionGetPayload<{ select: typeof subscriptionSelect }>;

const LIVE = ['PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE'] as const;

/**
 * Explorer Pro and Organiser Pro, billed monthly through Razorpay Subscriptions. The member pays
 * the first month on the provider's checkout (which sets up the mandate for renewals); renewals,
 * failures and cancellations arrive as signed webhooks. Every change is applied from the
 * provider's own record of the subscription, fetched by the server, so events can repeat or
 * arrive out of order. Entitlements follow from the stored state and the clock
 * (EntitlementsService), so a lapsed plan stops working even if a webhook never comes.
 */
@Injectable()
export class SubscriptionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionsService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGateway,
    private readonly tokens: CheckoutTokens,
    private readonly notifications: NotificationsService,
    private readonly events: PaymentEventsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.events.onSubscriptionEvent((type, body) => this.applyWebhook(type, body));
    this.timer = setInterval(() => void this.runSafely(), SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  get open(): boolean {
    return this.config.SUBSCRIPTIONS_ENABLED && this.gateway.enabled;
  }

  // ── Plans ─────────────────────────────────────────────────────────────────

  async plans(): Promise<PlansResponse> {
    const rows = await this.prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: { pricePaise: 'asc' },
    });
    return {
      plans: rows.map((p) => this.toPlan(p)),
      alwaysFree: [...ALWAYS_FREE],
      terms: [...SUBSCRIPTION_TERMS],
      unavailableReason: !this.config.SUBSCRIPTIONS_ENABLED
        ? 'Paid plans are not on sale yet'
        : !this.gateway.enabled
          ? 'Payments are not set up yet'
          : null,
    };
  }

  toPlan(p: {
    id: string;
    code: string;
    tier: 'EXPLORER_PRO' | 'ORGANISER_PRO';
    name: string;
    description: string | null;
    pricePaise: number;
    currency: string;
    billingInterval: 'MONTHLY' | 'YEARLY';
    isActive: boolean;
  }): Plan {
    return {
      id: p.id,
      code: p.code,
      tier: p.tier,
      name: p.name,
      description: p.description,
      pricePaise: p.pricePaise,
      currency: p.currency,
      interval: p.billingInterval,
      entitlements: [...ENTITLEMENTS_BY_TIER[p.tier]],
      available: p.isActive && this.open,
    };
  }

  // ── The member's subscription ─────────────────────────────────────────────

  async mine(userId: string, returnUrl?: string): Promise<MySubscription> {
    const checked = this.tokens.checkReturnUrl(returnUrl);
    const now = new Date();
    const rows = await this.prisma.subscription.findMany({
      where: { userId },
      select: subscriptionSelect,
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    const entitled = rows.filter((r) => isEntitled(r, now));
    const tier = entitled.some((r) => r.plan.tier === 'ORGANISER_PRO')
      ? 'ORGANISER_PRO'
      : entitled.length > 0
        ? 'EXPLORER_PRO'
        : 'FREE';
    // The one to show: in progress or still entitled, else the latest.
    const current =
      rows.find((r) => (LIVE as readonly string[]).includes(r.status)) ?? entitled[0] ?? rows[0];
    return {
      tier,
      entitlements: [...ENTITLEMENTS_BY_TIER[tier]],
      subscription: current ? this.toSubscription(current, now, checked) : null,
    };
  }

  async subscribe(
    userId: string,
    input: z.output<typeof SubscribeSchema>,
  ): Promise<MySubscription> {
    if (!this.config.SUBSCRIPTIONS_ENABLED) {
      throw new ServiceUnavailableException('Paid plans are not on sale yet');
    }
    if (!this.gateway.enabled) throw new ServiceUnavailableException('Payments are not set up yet');
    const returnUrl = this.tokens.checkReturnUrl(input.returnUrl) ?? undefined;
    const repeat = await this.prisma.subscription.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } },
      select: { id: true },
    });
    if (repeat) return this.mine(userId, returnUrl);

    const plan = await this.prisma.subscriptionPlan.findUnique({ where: { code: input.planCode } });
    if (!plan || !plan.isActive) throw new NotFoundException('Plan not found');

    const now = new Date();
    const existing = await this.prisma.subscription.findMany({
      where: { userId, status: { in: [...LIVE, 'CANCELLED'] } },
      select: { ...subscriptionSelect, planId: true },
      orderBy: { createdAt: 'desc' },
    });
    for (const sub of existing) {
      if (sub.status === 'PENDING') {
        if (sub.planId === plan.id && now.getTime() - sub.createdAt.getTime() < PENDING_TTL_MS) {
          return this.mine(userId, returnUrl);
        }
        await this.dropPending(sub.id, sub.providerSubscriptionId);
        continue;
      }
      if (isEntitled(sub, now)) {
        const until = sub.currentPeriodEnd!.toISOString().slice(0, 10);
        throw new ConflictException(
          sub.cancelAtPeriodEnd || sub.status === 'CANCELLED'
            ? `Your ${sub.plan.name} runs until ${until}. You can subscribe again after that.`
            : `You already have ${sub.plan.name}. Cancel it first; it runs until the end of the month you paid for.`,
        );
      }
    }

    const providerPlanId = await this.providerPlan(plan);
    let id: string;
    try {
      ({ id } = await this.prisma.subscription.create({
        data: {
          userId,
          planId: plan.id,
          status: 'PENDING',
          pricePaise: plan.pricePaise,
          currency: plan.currency,
          idempotencyKey: input.idempotencyKey,
          provider: this.gateway.name,
        },
        select: { id: true },
      }));
    } catch (error) {
      // A parallel request with the same key, or a second subscription started at once.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.mine(userId, returnUrl);
      }
      throw error;
    }
    try {
      const gs = await this.gateway.createSubscription({
        planId: providerPlanId,
        totalCount: TOTAL_CYCLES[plan.billingInterval],
        notes: { subscriptionId: id, plan: plan.code },
      });
      await this.prisma.subscription.update({
        where: { id },
        data: { providerSubscriptionId: gs.id, providerStatus: gs.status },
      });
    } catch (error) {
      await this.prisma.subscription.update({
        where: { id },
        data: { status: 'EXPIRED', endedAt: new Date() },
      });
      this.logger.warn(`Could not create a provider subscription: ${(error as Error).message}`);
      throw new ServiceUnavailableException(
        'Payments are not available right now. Try again shortly.',
      );
    }
    return this.mine(userId, returnUrl);
  }

  /** Stops renewals. The paid month stays usable; an unpaid subscription is simply dropped. */
  async cancel(userId: string, reason: string | undefined): Promise<MySubscription> {
    const sub = await this.prisma.subscription.findFirst({
      where: { userId, status: { in: [...LIVE] } },
      select: subscriptionSelect,
      orderBy: { createdAt: 'desc' },
    });
    if (!sub) throw new ConflictException('There is no subscription to cancel');
    if (sub.status === 'PENDING') {
      await this.dropPending(sub.id, sub.providerSubscriptionId, 'CANCELLED', reason);
      return this.mine(userId);
    }
    // Renewals stop at the provider first; if that fails, nothing changes here.
    const immediate = sub.status === 'PAST_DUE';
    if (sub.providerSubscriptionId && this.gateway.enabled) {
      try {
        await this.gateway.cancelSubscription(sub.providerSubscriptionId, !immediate);
      } catch (error) {
        this.logger.warn(`Cancel at provider failed: ${(error as Error).message}`);
        throw new ServiceUnavailableException(
          'Could not reach the payment provider. Try again shortly.',
        );
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id: sub.id },
        data: {
          status: 'CANCELLED',
          cancelAtPeriodEnd: true,
          cancelledAt: new Date(),
          cancellationReason: reason?.slice(0, 500) ?? null,
        },
      });
      const until = sub.currentPeriodEnd ? this.day(sub.currentPeriodEnd) : null;
      await this.notifications.notify(tx, [userId], {
        type: 'PAYMENT_UPDATE',
        title: `${sub.plan.name} cancelled`,
        body:
          until && !immediate
            ? `You keep it until ${until} and won't be charged again.`
            : "You won't be charged again.",
        data: { screen: 'subscription' },
      });
    });
    return this.mine(userId);
  }

  // ── Provider state ────────────────────────────────────────────────────────

  /** Webhooks for subscriptions (registered with PaymentEventsService). */
  async applyWebhook(
    eventType: string,
    body: RazorpayWebhook,
  ): Promise<{ result: string; subscriptionId: string | null }> {
    const entity = body.payload?.subscription?.entity;
    if (!entity?.id) return { result: 'ignored', subscriptionId: null };
    const local = await this.byProviderId(entity.id);
    if (!local) return { result: 'subscription not ours', subscriptionId: null };
    const payment = body.payload?.payment?.entity
      ? fromRazorpayPayment(body.payload.payment.entity)
      : null;
    // The provider's current record decides, so events in any order end in the same state.
    const gs = await this.gateway.fetchSubscription(entity.id);
    const result = await this.apply(local.id, gs, payment);
    return { result: `${eventType}: ${result}`, subscriptionId: local.id };
  }

  /** The checkout's return for the first payment: signature, then the provider's records. */
  async applyCheckout(
    subscriptionId: string,
    fields: { paymentId: string; providerSubscriptionId: string; signature: string },
  ): Promise<'paid' | 'failed' | 'processing'> {
    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      select: { providerSubscriptionId: true },
    });
    if (
      !sub?.providerSubscriptionId ||
      sub.providerSubscriptionId !== fields.providerSubscriptionId ||
      !this.gateway.verifySubscriptionSignature(
        sub.providerSubscriptionId,
        fields.paymentId,
        fields.signature,
      )
    ) {
      return 'failed';
    }
    const [gs, gp] = await Promise.all([
      this.gateway.fetchSubscription(sub.providerSubscriptionId),
      this.gateway.fetchPayment(fields.paymentId),
    ]);
    const result = await this.apply(subscriptionId, gs, gp);
    await this.events.recordCheckout(
      null,
      fields.paymentId,
      `subscription ${result}`,
      subscriptionId,
    );
    if (result === 'active' || result === 'unchanged') {
      const now = await this.prisma.subscription.findUniqueOrThrow({
        where: { id: subscriptionId },
        select: { status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
      });
      return isEntitled(now) ? 'paid' : 'processing';
    }
    return result === 'mismatch' || result === 'payment failed' ? 'failed' : 'processing';
  }

  async reconcile(subscriptionId: string): Promise<string> {
    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      select: { providerSubscriptionId: true },
    });
    if (!sub) throw new NotFoundException('Subscription not found');
    if (!sub.providerSubscriptionId || !this.gateway.enabled) return 'nothing to check';
    return this.apply(
      subscriptionId,
      await this.gateway.fetchSubscription(sub.providerSubscriptionId),
      null,
    );
  }

  /**
   * Applies the provider's view of the subscription (and, with it, one payment). Idempotent: the
   * same input gives the same state.
   */
  private async apply(
    subscriptionId: string,
    gs: GatewaySubscription,
    gp: GatewayPayment | null,
  ): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "subscriptions" WHERE "id" = ${subscriptionId}::uuid FOR UPDATE`;
      const sub = await tx.subscription.findUniqueOrThrow({
        where: { id: subscriptionId },
        select: subscriptionSelect,
      });

      if (gp) {
        const recorded = await this.recordPayment(tx, sub, gp);
        if (recorded === 'mismatch') return 'mismatch';
      }

      const before = { status: sub.status, end: sub.currentPeriodEnd?.getTime() ?? null };
      const data: Prisma.SubscriptionUpdateInput = { providerStatus: gs.status };
      let status = sub.status;
      const periodFromProvider = () => {
        if (gs.currentStart && gs.currentEnd && gs.currentEnd > gs.currentStart) {
          data.currentPeriodStart = gs.currentStart;
          data.currentPeriodEnd = gs.currentEnd;
        }
      };
      switch (gs.status) {
        case 'created':
        case 'authenticated':
          break;
        case 'active':
          periodFromProvider();
          // Cancelled here at the period end: the provider stays active until then.
          if (!sub.cancelAtPeriodEnd && sub.status !== 'CANCELLED') status = 'ACTIVE';
          break;
        case 'pending':
        case 'halted':
          periodFromProvider();
          if (sub.status !== 'CANCELLED') status = 'PAST_DUE';
          break;
        case 'cancelled': {
          status = 'CANCELLED';
          data.cancelledAt = sub.cancelledAt ?? new Date();
          data.cancelAtPeriodEnd = true;
          // Cancelled immediately at the provider: the paid features stop then too.
          const ended = gs.endedAt;
          if (
            ended &&
            sub.currentPeriodEnd &&
            ended < sub.currentPeriodEnd &&
            (!sub.currentPeriodStart || ended > sub.currentPeriodStart)
          ) {
            data.currentPeriodEnd = ended;
          }
          if (!sub.currentPeriodEnd) data.endedAt = ended ?? new Date();
          break;
        }
        case 'completed':
        case 'expired':
          status = 'EXPIRED';
          data.endedAt = sub.endedAt ?? gs.endedAt ?? new Date();
          break;
        case 'paused':
          break;
      }
      // A subscription never becomes active without a period.
      if (
        (status === 'ACTIVE' || status === 'PAST_DUE') &&
        !data.currentPeriodEnd &&
        !sub.currentPeriodEnd
      ) {
        status = sub.status;
      }
      data.status = status;
      await tx.subscription.update({ where: { id: sub.id }, data });

      const end = (data.currentPeriodEnd as Date | undefined)?.getTime() ?? before.end;
      if (before.status === 'PENDING' && status === 'ACTIVE') {
        await this.notifications.notify(tx, [sub.userId], {
          type: 'PAYMENT_UPDATE',
          title: `${sub.plan.name} is on`,
          body: `Renews on ${this.day(new Date(end!))} for ${formatPaise(sub.pricePaise)}. Cancel any time.`,
          data: { screen: 'subscription' },
        });
      } else if (before.status !== 'PAST_DUE' && status === 'PAST_DUE') {
        await this.notifications.notify(tx, [sub.userId], {
          type: 'PAYMENT_UPDATE',
          title: `Your ${sub.plan.name} renewal didn't go through`,
          body: 'The payment provider will try again. Paid features stop if it keeps failing.',
          data: { screen: 'subscription' },
        });
      }
      if (gp?.status === 'failed') return 'payment failed';
      if (status === before.status && end === before.end) return 'unchanged';
      return status.toLowerCase();
    });
  }

  /** One provider payment on the subscription, stored once (unique per provider payment id). */
  private async recordPayment(
    tx: Prisma.TransactionClient,
    sub: SubscriptionRow,
    gp: GatewayPayment,
  ): Promise<'ok' | 'mismatch'> {
    const mismatch =
      gp.status !== 'failed' && (gp.amountPaise !== sub.pricePaise || gp.currency !== sub.currency);
    const status =
      gp.status === 'failed'
        ? 'FAILED'
        : gp.status === 'captured' || gp.status === 'refunded'
          ? 'CAPTURED'
          : 'AUTHORIZED';
    const existing = await tx.payment.findUnique({
      where: {
        provider_providerPaymentId: { provider: this.gateway.name, providerPaymentId: gp.id },
      },
      select: { id: true, subscriptionId: true },
    });
    if (existing) {
      if (existing.subscriptionId !== sub.id) return 'mismatch';
      return mismatch ? 'mismatch' : 'ok';
    }
    await tx.payment.create({
      data: {
        userId: sub.userId,
        subscriptionId: sub.id,
        provider: this.gateway.name,
        providerPaymentId: gp.id,
        amountPaise: gp.amountPaise > 0 ? gp.amountPaise : sub.pricePaise,
        currency: gp.currency,
        status,
        idempotencyKey: `sub-pay:${gp.id}`.slice(0, 100),
        providerFeePaise: gp.feePaise,
        providerTaxPaise: gp.taxPaise,
        method: gp.method,
        failureCode: mismatch
          ? 'AMOUNT_MISMATCH'
          : gp.status === 'failed'
            ? (gp.errorCode ?? 'FAILED')
            : null,
        failureReason: mismatch
          ? `Provider reported ${gp.amountPaise} ${gp.currency}, expected ${sub.pricePaise} ${sub.currency}`
          : gp.status === 'failed'
            ? (gp.errorDescription ?? 'The payment did not go through')
            : null,
        capturedAt: status === 'CAPTURED' ? new Date() : null,
      },
    });
    if (mismatch) this.logger.warn(`Subscription payment amount mismatch on ${sub.id}`);
    return mismatch ? 'mismatch' : 'ok';
  }

  // ── Sweeps ────────────────────────────────────────────────────────────────

  async sweep(now = new Date()): Promise<void> {
    // Renewal reminders, once per period.
    const soon = await this.prisma.subscription.findMany({
      where: {
        status: 'ACTIVE',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: {
          gt: now,
          lte: new Date(now.getTime() + RENEWAL_REMINDER_DAYS * DAY_MS),
        },
      },
      select: {
        id: true,
        userId: true,
        pricePaise: true,
        currentPeriodEnd: true,
        remindedForPeriodEnd: true,
        plan: { select: { name: true } },
      },
      take: 200,
    });
    for (const sub of soon) {
      if (sub.remindedForPeriodEnd?.getTime() === sub.currentPeriodEnd!.getTime()) continue;
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.subscription.updateMany({
          where: {
            id: sub.id,
            OR: [
              { remindedForPeriodEnd: null },
              { remindedForPeriodEnd: { not: sub.currentPeriodEnd! } },
            ],
          },
          data: { remindedForPeriodEnd: sub.currentPeriodEnd },
        });
        if (claimed.count === 0) return;
        await this.notifications.notify(tx, [sub.userId], {
          type: 'PAYMENT_UPDATE',
          title: `${sub.plan.name} renews on ${this.day(sub.currentPeriodEnd!)}`,
          body: `You'll be charged ${formatPaise(sub.pricePaise)}. Cancel before then if you don't want it.`,
          data: { screen: 'subscription' },
        });
      });
    }

    // Past the period (and grace) without a renewal: ask the provider, then end it.
    const overdue = await this.prisma.subscription.findMany({
      where: {
        status: { in: ['ACTIVE', 'PAST_DUE', 'TRIALING'] },
        currentPeriodEnd: { lt: new Date(now.getTime() - DAY_MS) },
      },
      select: { id: true },
      take: 100,
    });
    for (const { id } of overdue) {
      try {
        await this.reconcile(id);
      } catch (error) {
        this.logger.warn(`Could not check subscription ${id}: ${(error as Error).message}`);
      }
      await this.endIfLapsed(id, now);
    }

    // Cancelled plans whose paid month is over.
    const finished = await this.prisma.subscription.findMany({
      where: { status: 'CANCELLED', endedAt: null, currentPeriodEnd: { lt: now } },
      select: { id: true, userId: true, plan: { select: { name: true } } },
      take: 200,
    });
    for (const sub of finished) {
      await this.prisma.$transaction(async (tx) => {
        const c = await tx.subscription.updateMany({
          where: { id: sub.id, endedAt: null },
          data: { endedAt: now },
        });
        if (c.count === 0) return;
        await this.notifications.notify(tx, [sub.userId], {
          type: 'PAYMENT_UPDATE',
          title: `${sub.plan.name} has ended`,
          body: 'Your account is on the free plan. Safety, messages and free trips are unchanged.',
          data: { screen: 'subscription' },
        });
      });
    }

    // Never paid: drop it so the member can start again.
    const stale = await this.prisma.subscription.findMany({
      where: { status: 'PENDING', createdAt: { lt: new Date(now.getTime() - PENDING_TTL_MS) } },
      select: { id: true, providerSubscriptionId: true },
      take: 100,
    });
    for (const sub of stale) await this.dropPending(sub.id, sub.providerSubscriptionId);
  }

  private async endIfLapsed(id: string, now: Date) {
    await this.prisma.$transaction(async (tx) => {
      const sub = await tx.subscription.findUniqueOrThrow({
        where: { id },
        select: {
          status: true,
          userId: true,
          currentPeriodEnd: true,
          plan: { select: { name: true } },
        },
      });
      if (!['ACTIVE', 'PAST_DUE', 'TRIALING'].includes(sub.status)) return;
      if (!sub.currentPeriodEnd || sub.currentPeriodEnd.getTime() >= now.getTime() - DAY_MS) return;
      await tx.subscription.update({ where: { id }, data: { status: 'EXPIRED', endedAt: now } });
      await this.notifications.notify(tx, [sub.userId], {
        type: 'PAYMENT_UPDATE',
        title: `${sub.plan.name} has ended`,
        body: "The renewal payment didn't go through. Your account is on the free plan; you can subscribe again any time.",
        data: { screen: 'subscription' },
      });
    });
  }

  private async dropPending(
    id: string,
    providerId: string | null,
    status: 'EXPIRED' | 'CANCELLED' = 'EXPIRED',
    reason?: string,
  ) {
    if (providerId && this.gateway.enabled) {
      await this.gateway.cancelSubscription(providerId, false).catch((error: unknown) => {
        // An unpaid provider subscription charges nothing; it lapses on its own.
        this.logger.warn(
          `Could not cancel unpaid subscription at provider: ${(error as Error).message}`,
        );
      });
    }
    await this.prisma.subscription.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status,
        endedAt: new Date(),
        ...(status === 'CANCELLED'
          ? { cancelledAt: new Date(), cancellationReason: reason?.slice(0, 500) ?? null }
          : {}),
      },
    });
  }

  private async runSafely() {
    try {
      await this.sweep();
    } catch (error) {
      this.logger.warn(`Subscription sweep failed: ${(error as Error).message}`);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** The provider's plan at the current price, created the first time it is needed. */
  private async providerPlan(plan: {
    id: string;
    name: string;
    description: string | null;
    pricePaise: number;
    currency: string;
    billingInterval: 'MONTHLY' | 'YEARLY';
    providerPlanId: string | null;
    providerPlanPricePaise: number | null;
  }): Promise<string> {
    if (plan.providerPlanId && plan.providerPlanPricePaise === plan.pricePaise)
      return plan.providerPlanId;
    let created: { id: string };
    try {
      created = await this.gateway.createPlan({
        name: `Voyago ${plan.name}`,
        description: plan.description ?? plan.name,
        amountPaise: plan.pricePaise,
        currency: plan.currency,
        interval: plan.billingInterval,
      });
    } catch (error) {
      const message = error instanceof PaymentProviderError ? error.message : 'unreachable';
      this.logger.warn(`Could not create the provider plan: ${message}`);
      throw new ServiceUnavailableException(
        'Payments are not available right now. Try again shortly.',
      );
    }
    await this.prisma.subscriptionPlan.update({
      where: { id: plan.id },
      data: { providerPlanId: created.id, providerPlanPricePaise: plan.pricePaise },
    });
    return created.id;
  }

  byProviderId(providerSubscriptionId: string) {
    return this.prisma.subscription.findUnique({
      where: {
        provider_providerSubscriptionId: {
          provider: this.gateway.name,
          providerSubscriptionId,
        },
      },
      select: { id: true },
    });
  }

  toSubscription(row: SubscriptionRow, now: Date, returnUrl: string | null): Subscription {
    const pending = row.status === 'PENDING' && Boolean(row.providerSubscriptionId);
    const renews =
      (row.status === 'ACTIVE' || row.status === 'PAST_DUE') && !row.cancelAtPeriodEnd
        ? row.currentPeriodEnd
        : null;
    const actions: Subscription['actions'] = [];
    if (pending) actions.push('pay');
    if ((LIVE as readonly string[]).includes(row.status)) actions.push('cancel');
    return {
      id: row.id,
      status: row.status,
      plan: { code: row.plan.code, tier: row.plan.tier, name: row.plan.name },
      pricePaise: row.pricePaise,
      currency: row.currency,
      currentPeriodStart: row.currentPeriodStart?.toISOString() ?? null,
      currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      renewsAt: renews?.toISOString() ?? null,
      entitled: isEntitled(row, now),
      payments: row.payments.map((p) => ({
        ...p,
        createdAt: p.createdAt.toISOString(),
        capturedAt: p.capturedAt?.toISOString() ?? null,
      })),
      checkoutUrl: pending
        ? this.tokens.subscriptionCheckoutUrl(
            row.id,
            new Date(now.getTime() + CHECKOUT_LINK_MS),
            returnUrl,
          )
        : null,
      createdAt: row.createdAt.toISOString(),
      actions,
    };
  }

  private day(date: Date) {
    return date.toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'Asia/Kolkata',
    });
  }
}
