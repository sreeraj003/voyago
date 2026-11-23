import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { PaymentGateway } from './payment-gateway.js';
import { type ApplyResult, PaymentsService } from './payments.service.js';

const INTERVAL_MS = 60_000;
/** A refund still pending after this long is checked with the provider. */
const REFUND_CHECK_AFTER_MS = 10 * 60_000;

export type ReconcileSummary = {
  payments: ApplyResult[];
  refunds: string[];
  expired: boolean;
};

/**
 * Brings bookings in line with the provider when callbacks or webhooks are late, lost or arrive
 * out of order: unpaid holds whose time ran out are checked for payments before they lapse,
 * pending refunds are re-checked, and refunds that failed to send are retried by staff. Runs every
 * minute, and on demand from the admin app.
 */
@Injectable()
export class ReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGateway,
    private readonly payments: PaymentsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.runSafely(), INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async reconcileBooking(bookingId: string): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = { payments: [], refunds: [], expired: false };
    const payment = await this.prisma.payment.findFirst({
      where: { bookingId, provider: this.gateway.name },
      select: { providerOrderId: true },
      orderBy: { createdAt: 'desc' },
    });
    if (this.gateway.enabled && payment?.providerOrderId) {
      const found = await this.gateway.orderPayments(payment.providerOrderId);
      // Captured first, so a later failed attempt never hides a successful one.
      const order = { captured: 0, refunded: 0, authorized: 1, failed: 2, created: 3 } as const;
      for (const gp of found.sort((a, b) => order[a.status] - order[b.status])) {
        summary.payments.push(await this.payments.applyPayment(gp));
      }
    }
    if (this.gateway.enabled) {
      const refunds = await this.prisma.refund.findMany({
        where: { bookingId, status: 'PENDING' },
        include: { payment: { select: { providerPaymentId: true } } },
      });
      for (const refund of refunds) {
        if (refund.providerRefundId && refund.payment.providerPaymentId) {
          const gr = await this.gateway.fetchRefund(
            refund.payment.providerPaymentId,
            refund.providerRefundId,
          );
          const applied = await this.payments.applyRefund(gr);
          summary.refunds.push(applied?.status ?? 'unknown');
        } else {
          const sent = await this.payments.sendRefund(refund.id);
          summary.refunds.push(sent.status);
        }
      }
    }
    const lapsed = await this.prisma.booking.updateMany({
      where: { id: bookingId, status: 'PENDING_PAYMENT', expiresAt: { lt: new Date() } },
      data: { status: 'EXPIRED' },
    });
    summary.expired = lapsed.count > 0;
    return summary;
  }

  async sweep(now = new Date()): Promise<void> {
    const lapsed = await this.prisma.booking.findMany({
      where: { status: 'PENDING_PAYMENT', expiresAt: { lt: now } },
      select: { id: true },
      take: 50,
    });
    for (const booking of lapsed) {
      try {
        await this.reconcileBooking(booking.id);
      } catch (error) {
        this.logger.warn(`Could not reconcile booking ${booking.id}: ${(error as Error).message}`);
      }
    }
    const stale = await this.prisma.refund.findMany({
      where: {
        status: 'PENDING',
        updatedAt: { lt: new Date(now.getTime() - REFUND_CHECK_AFTER_MS) },
      },
      select: { bookingId: true },
      distinct: ['bookingId'],
      take: 50,
    });
    for (const refund of stale) {
      try {
        await this.reconcileBooking(refund.bookingId);
      } catch (error) {
        this.logger.warn(
          `Could not check refunds of ${refund.bookingId}: ${(error as Error).message}`,
        );
      }
    }
    // Experiences that have ended: their confirmed bookings are complete.
    await this.prisma.booking.updateMany({
      where: { status: 'CONFIRMED', package: { endsAt: { lt: now } } },
      data: { status: 'COMPLETED' },
    });
  }

  private async runSafely(): Promise<void> {
    try {
      await this.sweep();
    } catch (error) {
      this.logger.warn(`Payment sweep failed: ${(error as Error).message}`);
    }
  }
}
