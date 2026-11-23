import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  type AdminEndSubscriptionSchema,
  type AdminPlan,
  type AdminSubscription,
  AdminSubscriptionSchema,
  type AdminSubscriptionsQuerySchema,
  formatPaise,
  type PageResponse,
  type UpdatePlanSchema,
} from '@voyago/shared';
import { type z } from 'zod';
import { recordAudit } from '../admin/audit.js';
import { type Actor } from '../admin/permissions.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { PrismaService } from '../database/prisma.service.js';
import { type Prisma } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PaymentGateway } from '../payments/payment-gateway.js';
import { isEntitled } from './entitlements.service.js';
import {
  subscriptionSelect,
  type SubscriptionRow,
  SubscriptionsService,
} from './subscriptions.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const adminSelect = {
  ...subscriptionSelect,
  user: { select: { id: true, username: true, displayName: true } },
} as const satisfies Prisma.SubscriptionSelect;
type AdminRow = Prisma.SubscriptionGetPayload<{ select: typeof adminSelect }>;

/** A payment that was taken and not yet given back in full. */
const refundable = (row: SubscriptionRow) =>
  row.payments.find(
    (p) =>
      (p.status === 'CAPTURED' || p.status === 'PARTIALLY_REFUNDED') &&
      p.refundedAmountPaise < p.amountPaise,
  );

/**
 * Staff side of subscriptions: plan prices (new subscriptions only), finding a member's
 * subscription, re-checking it with the provider, and ending it now with a refund when support
 * agrees one is owed (for example a renewal the member didn't mean). Every change is audited.
 */
@Injectable()
export class AdminSubscriptionsService {
  private readonly logger = new Logger(AdminSubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGateway,
    private readonly subscriptions: SubscriptionsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Plans ─────────────────────────────────────────────────────────────────

  async plans(): Promise<AdminPlan[]> {
    const now = new Date();
    const rows = await this.prisma.subscriptionPlan.findMany({ orderBy: { pricePaise: 'asc' } });
    const live = await this.prisma.subscription.groupBy({
      by: ['planId'],
      where: {
        OR: [
          { status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
          { status: 'CANCELLED', currentPeriodEnd: { gt: now } },
        ],
      },
      _count: { _all: true },
    });
    const counts = new Map(live.map((l) => [l.planId, l._count._all]));
    return rows.map((p) => ({
      ...this.subscriptions.toPlan(p),
      isActive: p.isActive,
      providerPlanId: p.providerPlanId,
      subscribers: counts.get(p.id) ?? 0,
    }));
  }

  async updatePlan(actor: Actor, id: string, input: z.output<typeof UpdatePlanSchema>) {
    await this.prisma.$transaction(async (tx) => {
      const plan = await tx.subscriptionPlan.findUnique({ where: { id } });
      if (!plan) throw new NotFoundException('Plan not found');
      const priceChanged = input.pricePaise !== undefined && input.pricePaise !== plan.pricePaise;
      await tx.subscriptionPlan.update({
        where: { id },
        data: {
          ...(input.pricePaise !== undefined ? { pricePaise: input.pricePaise } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          // A new provider plan is made at the new price the next time someone subscribes.
          ...(priceChanged ? { providerPlanId: null, providerPlanPricePaise: null } : {}),
        },
      });
      await recordAudit(tx, actor, {
        action: 'subscription_plan.update',
        entityType: 'subscription_plan',
        entityId: id,
        reason: input.reason,
        metadata: {
          before: { pricePaise: plan.pricePaise, isActive: plan.isActive },
          after: {
            pricePaise: input.pricePaise ?? plan.pricePaise,
            isActive: input.isActive ?? plan.isActive,
          },
        },
      });
    });
    return (await this.plans()).find((p) => p.id === id)!;
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  async list(
    query: z.output<typeof AdminSubscriptionsQuerySchema>,
  ): Promise<PageResponse<AdminSubscription>> {
    const now = new Date();
    const cursor = decodeCursor(query.cursor);
    const q = query.q?.trim();
    const rows = await this.prisma.subscription.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        AND: [
          q
            ? {
                OR: [
                  ...(UUID_RE.test(q) ? [{ id: q }, { userId: q }] : []),
                  { user: { username: { contains: q, mode: 'insensitive' as const } } },
                  { providerSubscriptionId: q },
                  { payments: { some: { providerPaymentId: q } } },
                ],
              }
            : {},
          cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {},
        ],
      },
      select: adminSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map((r) => this.toAdmin(r, now)), page: page.page };
  }

  async get(id: string): Promise<AdminSubscription> {
    const row = await this.prisma.subscription.findUnique({ where: { id }, select: adminSelect });
    if (!row) throw new NotFoundException('Subscription not found');
    return this.toAdmin(row, new Date());
  }

  async reconcile(actor: Actor, id: string) {
    const result = await this.subscriptions.reconcile(id);
    await this.prisma.$transaction((tx) =>
      recordAudit(tx, actor, {
        action: 'subscription.reconcile',
        entityType: 'subscription',
        entityId: id,
        metadata: { result },
      }),
    );
    return { result, subscription: await this.get(id) };
  }

  /**
   * Ends the plan now: renewals stop at the provider, paid features stop, and optionally the last
   * payment is refunded in full. Running it again on an ended subscription only retries the refund.
   */
  async endNow(actor: Actor, id: string, input: z.output<typeof AdminEndSubscriptionSchema>) {
    const sub = await this.prisma.subscription.findUnique({ where: { id }, select: adminSelect });
    if (!sub) throw new NotFoundException('Subscription not found');
    const now = new Date();
    const alreadyEnded = sub.endedAt !== null || sub.status === 'EXPIRED';
    if (alreadyEnded && !input.refundLast)
      throw new ConflictException('This subscription has already ended');
    const payment = input.refundLast ? refundable(sub) : undefined;
    if (input.refundLast && !payment)
      throw new ConflictException('There is no payment left to refund');

    if (!alreadyEnded) {
      if (sub.providerSubscriptionId && this.gateway.enabled) {
        try {
          await this.gateway.cancelSubscription(sub.providerSubscriptionId, false);
        } catch (error) {
          // Already over at the provider is fine; anything else must not end it only here.
          const gs = await this.gateway
            .fetchSubscription(sub.providerSubscriptionId)
            .catch(() => null);
          if (!gs || !['cancelled', 'completed', 'expired'].includes(gs.status)) {
            this.logger.warn(`Admin cancel at provider failed: ${(error as Error).message}`);
            throw new ServiceUnavailableException(
              'Could not reach the payment provider. Nothing was changed.',
            );
          }
        }
      }
      await this.prisma.$transaction(async (tx) => {
        const trimEnd =
          sub.currentPeriodEnd &&
          sub.currentPeriodEnd > now &&
          (!sub.currentPeriodStart || sub.currentPeriodStart < now);
        await tx.subscription.update({
          where: { id },
          data: {
            status: 'CANCELLED',
            cancelAtPeriodEnd: true,
            cancelledAt: sub.cancelledAt ?? now,
            cancellationReason:
              sub.cancellationReason ?? `Ended by support: ${input.reason}`.slice(0, 500),
            endedAt: now,
            ...(trimEnd ? { currentPeriodEnd: now } : {}),
          },
        });
        await recordAudit(tx, actor, {
          action: 'subscription.end_now',
          entityType: 'subscription',
          entityId: id,
          reason: input.reason,
          metadata: { before: sub.status, refundLast: input.refundLast },
        });
        await this.notifications.notify(tx, [sub.userId], {
          type: 'PAYMENT_UPDATE',
          title: `${sub.plan.name} has ended`,
          body: payment
            ? `Support ended it and is refunding ${formatPaise(payment.amountPaise - payment.refundedAmountPaise)}.`
            : "Support ended it. You won't be charged again.",
          data: { screen: 'subscription' },
        });
      });
    }

    if (payment) await this.refund(actor, sub, payment.id, input.reason);
    return this.get(id);
  }

  private async refund(actor: Actor, sub: AdminRow, paymentId: string, reason: string) {
    const payment = await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const amount = payment.amountPaise - payment.refundedAmountPaise;
    if (!payment.providerPaymentId || amount <= 0)
      throw new ConflictException('There is no payment left to refund');
    let refund: { id: string; status: string };
    try {
      refund = await this.gateway.refund({
        paymentId: payment.providerPaymentId,
        amountPaise: amount,
        receipt: `sub-refund-${payment.id}`.slice(0, 40),
        notes: { subscriptionId: sub.id, paymentId: payment.id },
      });
    } catch (error) {
      this.logger.warn(`Subscription refund failed: ${(error as Error).message}`);
      throw new ServiceUnavailableException(
        'The plan is ended but the refund did not go through. Try the refund again shortly.',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: { refundedAmountPaise: payment.amountPaise, status: 'REFUNDED' },
      });
      await recordAudit(tx, actor, {
        action: 'subscription.refund',
        entityType: 'subscription',
        entityId: sub.id,
        reason,
        metadata: {
          paymentId: payment.id,
          amountPaise: amount,
          providerRefundId: refund.id,
          providerStatus: refund.status,
        },
      });
      await this.notifications.notify(tx, [sub.userId], {
        type: 'PAYMENT_UPDATE',
        title: `Refund of ${formatPaise(amount)} on its way`,
        body: 'It usually reaches your account in 5 to 7 working days.',
        data: { screen: 'subscription' },
      });
    });
  }

  private toAdmin(row: AdminRow, now: Date): AdminSubscription {
    const member = this.subscriptions.toSubscription(row, now, null);
    const base = AdminSubscriptionSchema.omit({
      user: true,
      provider: true,
      providerSubscriptionId: true,
      cancellationReason: true,
      actions: true,
    }).parse(member);
    const actions: AdminSubscription['actions'] = [];
    if (row.providerSubscriptionId) actions.push('reconcile');
    if (row.endedAt === null && row.status !== 'EXPIRED') actions.push('cancel_now');
    if (refundable(row)) actions.push('refund_last');
    return {
      ...base,
      entitled: isEntitled(row, now),
      user: row.user,
      provider: row.provider,
      providerSubscriptionId: row.providerSubscriptionId,
      cancellationReason: row.cancellationReason,
      actions,
    };
  }
}
