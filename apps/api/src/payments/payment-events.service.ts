import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  fromRazorpayPayment,
  fromRazorpayRefund,
  type GatewayPayment,
  type RazorpaySubscriptionEntity,
  PaymentGateway,
} from './payment-gateway.js';
import { PaymentsService } from './payments.service.js';
import { AlertsService } from '../observability/alerts.service.js';
import { MetricsRegistry } from '../observability/metrics.registry.js';

export type RazorpayWebhook = {
  event?: string;
  payload?: {
    payment?: { entity?: Parameters<typeof fromRazorpayPayment>[0] };
    refund?: { entity?: Parameters<typeof fromRazorpayRefund>[0] };
    subscription?: { entity?: RazorpaySubscriptionEntity };
  };
};

/** Applies one kind of provider event; returns what it did and the subscription it touched. */
export type EventHandler = (
  eventType: string,
  body: RazorpayWebhook,
) => Promise<{ result: string; subscriptionId: string | null }>;

/** Only what is needed to audit a provider event: ids, status, amounts, error codes. */
function summarise(body: RazorpayWebhook): Prisma.InputJsonValue {
  const p = body.payload?.payment?.entity;
  const r = body.payload?.refund?.entity;
  const sub = body.payload?.subscription?.entity;
  return {
    ...(p
      ? {
          payment: {
            id: p.id,
            orderId: p.order_id ?? null,
            status: p.status,
            amount: p.amount,
            currency: p.currency,
            method: p.method ?? null,
            errorCode: p.error_code ?? null,
          },
        }
      : {}),
    ...(r
      ? { refund: { id: r.id, paymentId: r.payment_id, status: r.status, amount: r.amount } }
      : {}),
    ...(sub ? { subscription: { id: sub.id, planId: sub.plan_id, status: sub.status } } : {}),
  };
}

/**
 * Provider webhooks: verified by signature, stored once per provider event id, then applied.
 * A repeat of an event that was applied is acknowledged and ignored; one that failed half-way is
 * applied again, since every step it takes is idempotent.
 */
@Injectable()
export class PaymentEventsService {
  private readonly logger = new Logger(PaymentEventsService.name);
  private subscriptionHandler: EventHandler | null = null;

  /** Subscriptions register here, so this module needn't depend on them. */
  onSubscriptionEvent(handler: EventHandler) {
    this.subscriptionHandler = handler;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGateway,
    private readonly payments: PaymentsService,
    private readonly metrics: MetricsRegistry,
    private readonly alerts: AlertsService,
  ) {}

  async razorpayWebhook(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    eventId: string | undefined,
  ): Promise<{ status: 'processed' | 'duplicate' | 'ignored' | 'invalid'; result?: string }> {
    let body: RazorpayWebhook;
    try {
      body = JSON.parse(rawBody?.toString('utf8') ?? '{}') as RazorpayWebhook;
    } catch {
      body = {};
    }
    const valid =
      Boolean(rawBody && signature) && this.gateway.verifyWebhookSignature(rawBody!, signature!);
    const eventType = (body.event ?? 'unknown').slice(0, 60);
    if (!valid) {
      // Kept for investigation under its own id, so a forged id can't block the real event.
      await this.prisma.paymentEvent.create({
        data: {
          provider: this.gateway.name,
          eventId: `invalid:${randomUUID()}`,
          eventType,
          signatureValid: false,
          summary: summarise(body),
          result: 'Signature did not match; ignored',
          processedAt: new Date(),
        },
      });
      this.logger.warn(`Rejected a ${this.gateway.name} webhook with a bad signature`);
      this.count('invalid_signature');
      return { status: 'invalid' };
    }
    const id = (
      eventId?.trim() ||
      `${eventType}:${body.payload?.payment?.entity?.id ?? body.payload?.refund?.entity?.id ?? randomUUID()}`
    ).slice(0, 120);
    const recorded = await this.record(id, eventType, body);
    if (recorded === 'duplicate') {
      this.count('duplicate');
      return { status: 'duplicate' };
    }
    let result: string;
    let subscriptionId: string | null = null;
    try {
      if (eventType.startsWith('subscription.') && this.subscriptionHandler) {
        ({ result, subscriptionId } = await this.subscriptionHandler(eventType, body));
      } else {
        result = await this.apply(eventType, body);
      }
    } catch (error) {
      // Left unprocessed: the provider retries, and /admin/system shows it as stuck meanwhile.
      this.count('failed');
      await this.alerts.raise(
        'payment-webhook',
        `A ${this.gateway.name} ${eventType} webhook could not be applied: ${(error as Error).message.slice(0, 200)}`,
      );
      throw error;
    }
    this.count(result === 'ignored' ? 'ignored' : 'processed');
    await this.prisma.paymentEvent.update({
      where: { provider_eventId: { provider: this.gateway.name, eventId: id } },
      data: {
        result: result.slice(0, 300),
        processedAt: new Date(),
        bookingId: subscriptionId ? null : await this.bookingFor(body),
        subscriptionId,
      },
    });
    return { status: result === 'ignored' ? 'ignored' : 'processed', result };
  }

  private count(outcome: string) {
    this.metrics.inc(
      'payment_webhooks_total',
      { provider: this.gateway.name, outcome },
      1,
      'Payment provider webhooks by outcome',
    );
  }

  /** Records the checkout's return (signature already verified) for the booking's history. */
  async recordCheckout(
    bookingId: string | null,
    paymentId: string,
    result: string,
    subscriptionId: string | null = null,
  ) {
    await this.prisma.paymentEvent
      .create({
        data: {
          provider: this.gateway.name,
          eventId: `checkout:${paymentId}`.slice(0, 120),
          eventType: 'checkout.return',
          bookingId,
          subscriptionId,
          signatureValid: true,
          summary: { payment: { id: paymentId } },
          result: result.slice(0, 300),
          processedAt: new Date(),
        },
      })
      .catch(() => undefined);
  }

  private async record(id: string, eventType: string, body: RazorpayWebhook) {
    try {
      await this.prisma.paymentEvent.create({
        data: {
          provider: this.gateway.name,
          eventId: id,
          eventType,
          signatureValid: true,
          summary: summarise(body),
        },
      });
      return 'new';
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'))
        throw error;
      const existing = await this.prisma.paymentEvent.findUniqueOrThrow({
        where: { provider_eventId: { provider: this.gateway.name, eventId: id } },
        select: { processedAt: true },
      });
      return existing.processedAt ? 'duplicate' : 'retry';
    }
  }

  private async apply(eventType: string, body: RazorpayWebhook): Promise<string> {
    const payment = body.payload?.payment?.entity;
    const refund = body.payload?.refund?.entity;
    switch (eventType) {
      case 'payment.authorized':
      case 'payment.captured':
      case 'payment.failed':
      case 'order.paid': {
        if (!payment) return 'ignored';
        const gp: GatewayPayment = fromRazorpayPayment(payment);
        return `payment ${await this.payments.applyPayment(gp)}`;
      }
      case 'refund.processed':
      case 'refund.failed':
      case 'refund.created': {
        if (!refund) return 'ignored';
        const applied = await this.payments.applyRefund(fromRazorpayRefund(refund));
        return applied ? `refund ${applied.status.toLowerCase()}` : 'refund not ours';
      }
      default:
        return 'ignored';
    }
  }

  private async bookingFor(body: RazorpayWebhook): Promise<string | null> {
    const orderId = body.payload?.payment?.entity?.order_id;
    const refundId = body.payload?.refund?.entity?.id;
    if (orderId) {
      const p = await this.prisma.payment.findUnique({
        where: {
          provider_providerOrderId: { provider: this.gateway.name, providerOrderId: orderId },
        },
        select: { bookingId: true },
      });
      return p?.bookingId ?? null;
    }
    if (refundId) {
      const r = await this.prisma.refund.findUnique({
        where: {
          provider_providerRefundId: { provider: this.gateway.name, providerRefundId: refundId },
        },
        select: { bookingId: true },
      });
      return r?.bookingId ?? null;
    }
    return null;
  }
}
