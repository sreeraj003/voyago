import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { formatPaise, proportional } from '@voyago/shared';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  type GatewayPayment,
  type GatewayRefund,
  PaymentGateway,
  PaymentProviderError,
} from './payment-gateway.js';

type Tx = Prisma.TransactionClient;

/** What happened when a provider payment was applied to its booking. */
export type ApplyResult =
  | 'confirmed'
  | 'already_confirmed'
  | 'late_confirmed'
  | 'late_refunded'
  | 'failed'
  | 'pending'
  | 'mismatch'
  | 'unknown_order';

export function isCapacityError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes('bookings_capacity') || text.includes('Not enough places left');
}

/**
 * The money state machine: applying provider payments to bookings, refunds, and the ledger. A
 * booking is confirmed only from the provider's own record of a captured payment (fetched from
 * the provider's API or received in a signed webhook) whose amount and currency match the
 * booking. Every step is idempotent, so callbacks, webhooks and reconciliation can all deliver
 * the same payment in any order.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGateway,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Payments ──────────────────────────────────────────────────────────────

  /** Applies the provider's view of one payment; authorised payments are captured first. */
  async applyPayment(input: GatewayPayment): Promise<ApplyResult> {
    if (!input.orderId) return 'unknown_order';
    const payment = await this.prisma.payment.findUnique({
      where: {
        provider_providerOrderId: { provider: this.gateway.name, providerOrderId: input.orderId },
      },
      select: {
        id: true,
        status: true,
        amountPaise: true,
        currency: true,
        providerPaymentId: true,
        bookingId: true,
      },
    });
    if (!payment?.bookingId) return 'unknown_order';
    const bookingId = payment.bookingId;

    if (input.amountPaise !== payment.amountPaise || input.currency !== payment.currency) {
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: { in: ['CREATED', 'FAILED'] } },
        data: {
          failureCode: 'AMOUNT_MISMATCH',
          failureReason: `Provider reported ${input.amountPaise} ${input.currency}, expected ${payment.amountPaise} ${payment.currency}`,
        },
      });
      this.logger.warn(`Payment amount mismatch on booking ${bookingId}`);
      return 'mismatch';
    }

    if (input.status === 'failed') {
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: { in: ['CREATED', 'FAILED'] } },
        data: {
          status: 'FAILED',
          providerPaymentId: payment.providerPaymentId ?? undefined,
          failureCode: input.errorCode?.slice(0, 100) ?? 'FAILED',
          failureReason: input.errorDescription ?? 'The payment did not go through',
        },
      });
      return 'failed';
    }
    if (input.status === 'created') return 'pending';

    // A second, different payment on an order that is already paid: give it straight back.
    if (payment.providerPaymentId && payment.providerPaymentId !== input.id) {
      if (input.status === 'captured') await this.refundStray(input, bookingId);
      return 'already_confirmed';
    }

    let captured = input;
    if (input.status === 'authorized') {
      captured = await this.gateway.capture(input.id, input.amountPaise, input.currency);
      if (captured.status !== 'captured') return 'pending';
    }
    if (captured.status !== 'captured' && captured.status !== 'refunded') return 'pending';
    return this.confirm(payment.id, bookingId, captured);
  }

  private async confirm(
    paymentId: string,
    bookingId: string,
    gp: GatewayPayment,
  ): Promise<ApplyResult> {
    const attempt = (allowLate: boolean) =>
      this.prisma.$transaction(async (tx) => {
        const booking = await this.lockBooking(tx, bookingId);
        const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
        const alreadyCaptured = payment.capturedAt !== null;
        if (!alreadyCaptured) {
          await tx.payment.update({
            where: { id: paymentId },
            data: {
              status: 'CAPTURED',
              providerPaymentId: gp.id,
              capturedAt: new Date(),
              providerFeePaise: gp.feePaise,
              providerTaxPaise: gp.taxPaise,
              method: gp.method,
              failureCode: null,
              failureReason: null,
            },
          });
          await this.writeCaptureLedger(tx, booking, paymentId, gp);
        }
        if (booking.status === 'CONFIRMED' || booking.status === 'COMPLETED') {
          return 'already_confirmed' as const;
        }
        if (booking.status === 'PENDING_PAYMENT' || (allowLate && booking.status === 'EXPIRED')) {
          const late = booking.status === 'EXPIRED';
          await tx.booking.update({
            where: { id: bookingId },
            data: { status: 'CONFIRMED', confirmedAt: new Date(), expiresAt: null },
          });
          await this.notifyConfirmed(tx, bookingId);
          return late ? ('late_confirmed' as const) : ('confirmed' as const);
        }
        // Cancelled, refunded, or expired with the places gone: the money goes back.
        return 'late_refunded' as const;
      });

    let result: ApplyResult;
    try {
      result = await attempt(true);
    } catch (error) {
      if (!isCapacityError(error)) throw error;
      // The hold expired and the places were sold meanwhile: record the payment, then refund it.
      result = await attempt(false);
    }
    if (result === 'late_refunded') {
      await this.refundRemaining(bookingId, {
        initiator: 'SYSTEM',
        reason: 'Paid after the booking was cancelled or its hold expired',
        key: `late:${gp.id}`,
      });
    }
    return result;
  }

  private async refundStray(gp: GatewayPayment, bookingId: string): Promise<void> {
    try {
      await this.gateway.refund({
        paymentId: gp.id,
        amountPaise: gp.amountPaise,
        receipt: `dup-${gp.id}`.slice(0, 40),
        notes: { bookingId, reason: 'duplicate payment' },
      });
      this.logger.warn(`Refunded a duplicate payment on booking ${bookingId}`);
    } catch (error) {
      this.logger.error(
        `Duplicate payment on booking ${bookingId} needs a manual refund: ${(error as Error).message}`,
      );
    }
  }

  // ── Refunds ───────────────────────────────────────────────────────────────

  /** Refunds whatever of the booking is still unrefunded (operator cancellations, late payments). */
  async refundRemaining(
    bookingId: string,
    opts: {
      initiator: 'CUSTOMER' | 'OPERATOR' | 'ADMIN' | 'SYSTEM';
      reason: string;
      key: string;
      requestedById?: string;
    },
  ) {
    const booking = await this.prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: { totalAmountPaise: true, refunds: { select: { amountPaise: true, status: true } } },
    });
    const committed = booking.refunds
      .filter((r) => r.status !== 'FAILED')
      .reduce((sum, r) => sum + r.amountPaise, 0);
    const amount = booking.totalAmountPaise - committed;
    if (amount <= 0) return null;
    return this.startRefund(bookingId, { ...opts, amountPaise: amount });
  }

  /**
   * Creates a refund for `amountPaise` of the booking's captured payment and asks the provider
   * for it. Never more than was paid and not yet refunded (pending refunds count). Idempotent by
   * `key`: the same key returns the existing refund.
   */
  async startRefund(
    bookingId: string,
    opts: {
      amountPaise: number;
      initiator: 'CUSTOMER' | 'OPERATOR' | 'ADMIN' | 'SYSTEM';
      reason: string;
      key: string;
      requestedById?: string;
      hoursBefore?: number;
      refundPercent?: number;
    },
  ) {
    const existing = await this.prisma.refund.findUnique({ where: { idempotencyKey: opts.key } });
    if (existing) return existing;
    const refund = await this.prisma.$transaction(async (tx) => {
      await this.lockBooking(tx, bookingId);
      const payment = await tx.payment.findFirst({
        where: { bookingId, capturedAt: { not: null } },
        select: { id: true, amountPaise: true, currency: true },
      });
      if (!payment) throw new RefundError('There is no captured payment to refund');
      const committed = await tx.refund.aggregate({
        where: { paymentId: payment.id, status: { not: 'FAILED' } },
        _sum: { amountPaise: true },
      });
      const available = payment.amountPaise - (committed._sum.amountPaise ?? 0);
      if (opts.amountPaise <= 0 || opts.amountPaise > available) {
        throw new RefundError(`At most ${formatPaise(Math.max(available, 0))} can be refunded`);
      }
      return tx.refund.create({
        data: {
          bookingId,
          paymentId: payment.id,
          amountPaise: opts.amountPaise,
          currency: payment.currency,
          initiator: opts.initiator,
          requestedById: opts.requestedById ?? null,
          reason: opts.reason.slice(0, 500),
          hoursBefore: opts.hoursBefore ?? null,
          refundPercent: opts.refundPercent ?? null,
          provider: this.gateway.name,
          idempotencyKey: opts.key,
        },
      });
    });
    return this.sendRefund(refund.id);
  }

  /** Asks the provider for a refund that is pending without a provider id, or failed (retry). */
  async sendRefund(refundId: string) {
    const refund = await this.prisma.refund.findUniqueOrThrow({
      where: { id: refundId },
      include: { payment: { select: { providerPaymentId: true } } },
    });
    if (refund.status === 'PROCESSED' || (refund.status === 'PENDING' && refund.providerRefundId)) {
      return refund;
    }
    if (!refund.payment.providerPaymentId) throw new RefundError('The payment has no provider id');
    if (refund.status === 'FAILED') {
      await this.prisma.refund.update({
        where: { id: refundId },
        data: { status: 'PENDING', failureReason: null },
      });
    }
    let result: GatewayRefund;
    try {
      result = await this.gateway.refund({
        paymentId: refund.payment.providerPaymentId,
        amountPaise: refund.amountPaise,
        receipt: refund.id.replace(/-/g, '').slice(0, 40),
        notes: { bookingId: refund.bookingId, refundId: refund.id },
      });
    } catch (error) {
      const message =
        error instanceof PaymentProviderError ? error.message : 'The refund could not be sent';
      return this.prisma.refund.update({
        where: { id: refundId },
        data: { status: 'FAILED', failureReason: message.slice(0, 500) },
      });
    }
    const sent = await this.prisma.refund.update({
      where: { id: refundId },
      data: { providerRefundId: result.id },
    });
    return (await this.applyRefund(result)) ?? sent;
  }

  /** Applies the provider's view of a refund (response, webhook or reconciliation). */
  async applyRefund(gr: GatewayRefund) {
    const refund = await this.prisma.refund.findUnique({
      where: {
        provider_providerRefundId: { provider: this.gateway.name, providerRefundId: gr.id },
      },
    });
    if (!refund) return null;
    if (gr.status === 'processed') return this.markRefundProcessed(refund.id);
    if (gr.status === 'failed') {
      return this.prisma.refund
        .update({
          where: { id: refund.id, status: 'PENDING' },
          data: {
            status: 'FAILED',
            failureReason: 'The payment provider could not process the refund',
          },
        })
        .catch(() => refund);
    }
    return refund;
  }

  private async markRefundProcessed(refundId: string) {
    return this.prisma.$transaction(async (tx) => {
      const head = await tx.refund.findUniqueOrThrow({
        where: { id: refundId },
        select: { bookingId: true },
      });
      const booking = await this.lockBooking(tx, head.bookingId);
      const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
      if (refund.status === 'PROCESSED') return refund;
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: refund.paymentId } });
      const before = booking.refundedAmountPaise;
      const after = before + refund.amountPaise;
      const total = booking.totalAmountPaise;
      const commissionNet = (refunded: number) =>
        booking.commissionPaise - proportional(booking.commissionPaise, refunded, total);
      const taxNet = (refunded: number) =>
        booking.commissionTaxPaise - proportional(booking.commissionTaxPaise, refunded, total);
      const payableNet = (refunded: number) =>
        total - refunded - commissionNet(refunded) - taxNet(refunded);
      const entries = [
        { kind: 'REFUND' as const, amountPaise: -refund.amountPaise },
        {
          kind: 'COMMISSION_REVERSAL' as const,
          amountPaise: commissionNet(after) - commissionNet(before),
        },
        { kind: 'COMMISSION_TAX_REVERSAL' as const, amountPaise: taxNet(after) - taxNet(before) },
        {
          kind: 'OPERATOR_PAYABLE_REVERSAL' as const,
          amountPaise: payableNet(after) - payableNet(before),
        },
      ];
      await tx.ledgerEntry.createMany({
        data: entries.map((e) => ({
          ...e,
          bookingId: booking.id,
          operatorId: booking.operatorId,
          refundId: refund.id,
          currency: refund.currency,
        })),
        skipDuplicates: true,
      });
      const updated = await tx.refund.update({
        where: { id: refundId },
        data: { status: 'PROCESSED', processedAt: new Date(), failureReason: null },
      });
      const paymentRefunded = payment.refundedAmountPaise + refund.amountPaise;
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          refundedAmountPaise: paymentRefunded,
          status: paymentRefunded >= payment.amountPaise ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
        },
      });
      const fully = after >= total;
      await tx.booking.update({
        where: { id: booking.id },
        data: {
          refundedAmountPaise: after,
          ...(fully && (booking.status === 'CANCELLED' || booking.status === 'EXPIRED')
            ? { status: 'REFUNDED' }
            : {}),
        },
      });
      await this.notifications.notify(tx, [booking.userId], {
        type: 'PAYMENT_UPDATE',
        title: `Refund of ${formatPaise(refund.amountPaise)} sent`,
        body: 'Your bank or card provider may take 5 to 7 working days to show it.',
        data: { bookingId: booking.id },
      });
      return updated;
    });
  }

  // ── Ledger and helpers ────────────────────────────────────────────────────

  private async writeCaptureLedger(
    tx: Tx,
    booking: LockedBooking,
    paymentId: string,
    gp: GatewayPayment,
  ) {
    const lines: { kind: Prisma.LedgerEntryCreateManyInput['kind']; amountPaise: number }[] = [
      { kind: 'GROSS', amountPaise: booking.totalAmountPaise },
      { kind: 'COMMISSION', amountPaise: booking.commissionPaise },
      { kind: 'COMMISSION_TAX', amountPaise: booking.commissionTaxPaise },
      { kind: 'OPERATOR_PAYABLE', amountPaise: booking.operatorPayablePaise },
    ];
    if (gp.feePaise !== null)
      lines.push({ kind: 'PROVIDER_FEE', amountPaise: gp.feePaise - (gp.taxPaise ?? 0) });
    if (gp.taxPaise !== null) lines.push({ kind: 'PROVIDER_FEE_TAX', amountPaise: gp.taxPaise });
    await tx.ledgerEntry.createMany({
      data: lines.map((line) => ({
        ...line,
        bookingId: booking.id,
        operatorId: booking.operatorId,
        paymentId,
        currency: booking.currency,
      })),
      skipDuplicates: true,
    });
  }

  private async notifyConfirmed(tx: Tx, bookingId: string) {
    const b = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: {
        userId: true,
        seats: true,
        package: { select: { id: true, title: true, operator: { select: { ownerUserId: true } } } },
      },
    });
    await this.notifications.notify(tx, [b.userId], {
      type: 'BOOKING_UPDATE',
      title: `Booking confirmed: ${b.package.title}`,
      body: `${b.seats} ${b.seats === 1 ? 'place' : 'places'} booked. The exact meeting point is now on your booking.`,
      data: { bookingId },
    });
    await this.notifications.notify(tx, [b.package.operator.ownerUserId], {
      type: 'BOOKING_UPDATE',
      title: `New booking: ${b.package.title}`,
      body: `${b.seats} ${b.seats === 1 ? 'place' : 'places'} confirmed and paid.`,
      data: { packageId: b.package.id },
    });
  }

  /** Locks the booking row for the rest of the transaction. */
  async lockBooking(tx: Tx, bookingId: string): Promise<LockedBooking> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "bookings" WHERE "id" = ${bookingId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new RefundError('Booking not found');
    const b = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: {
        id: true,
        userId: true,
        status: true,
        currency: true,
        totalAmountPaise: true,
        refundedAmountPaise: true,
        commissionPaise: true,
        commissionTaxPaise: true,
        operatorPayablePaise: true,
        package: { select: { operatorId: true } },
      },
    });
    return { ...b, operatorId: b.package.operatorId };
  }

  newKey(prefix: string) {
    return `${prefix}:${randomUUID()}`;
  }
}

export type LockedBooking = {
  id: string;
  userId: string;
  status: string;
  currency: string;
  totalAmountPaise: number;
  refundedAmountPaise: number;
  commissionPaise: number;
  commissionTaxPaise: number;
  operatorPayablePaise: number;
  operatorId: string;
};

/** A refund that can't be made as asked (shown to the person as a 409). */
export class RefundError extends ConflictException {}
