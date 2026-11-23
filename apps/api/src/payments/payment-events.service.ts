import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  fromRazorpayPayment,
  fromRazorpayRefund,
  type GatewayPayment,
  PaymentGateway,
} from './payment-gateway.js';
import { PaymentsService } from './payments.service.js';

type RazorpayWebhook = {
  event?: string;
  payload?: {
    payment?: { entity?: Parameters<typeof fromRazorpayPayment>[0] };
    refund?: { entity?: Parameters<typeof fromRazorpayRefund>[0] };
  };
};

/** Only what is needed to audit a provider event: ids, status, amounts, error codes. */
function summarise(body: RazorpayWebhook): Prisma.InputJsonValue {
  const p = body.payload?.payment?.entity;
  const r = body.payload?.refund?.entity;
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGateway,
    private readonly payments: PaymentsService,
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
      return { status: 'invalid' };
    }
    const id = (
      eventId?.trim() ||
      `${eventType}:${body.payload?.payment?.entity?.id ?? body.payload?.refund?.entity?.id ?? randomUUID()}`
    ).slice(0, 120);
    const recorded = await this.record(id, eventType, body);
    if (recorded === 'duplicate') return { status: 'duplicate' };
    const result = await this.apply(eventType, body);
    await this.prisma.paymentEvent.update({
      where: { provider_eventId: { provider: this.gateway.name, eventId: id } },
      data: {
        result: result.slice(0, 300),
        processedAt: new Date(),
        bookingId: await this.bookingFor(body),
      },
    });
    return { status: result === 'ignored' ? 'ignored' : 'processed', result };
  }

  /** Records the checkout's return (signature already verified) for the booking's history. */
  async recordCheckout(bookingId: string, paymentId: string, result: string) {
    await this.prisma.paymentEvent
      .create({
        data: {
          provider: this.gateway.name,
          eventId: `checkout:${paymentId}`.slice(0, 120),
          eventType: 'checkout.return',
          bookingId,
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
