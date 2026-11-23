import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type AdminBookingDetail,
  type AdminBookingsQuerySchema,
  type AdminBookingSummary,
  type AdminRefundSchema,
  type PageResponse,
  RefundTiersSchema,
} from '@voyago/shared';
import { randomUUID } from 'node:crypto';
import { type z } from 'zod';
import { recordAudit } from '../admin/audit.js';
import { type Actor } from '../admin/permissions.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { PrismaService } from '../database/prisma.service.js';
import { type Prisma } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PaymentGateway } from './payment-gateway.js';
import { PaymentsService } from './payments.service.js';
import { type ReconcileSummary, ReconciliationService } from './reconciliation.service.js';

/** A refund still pending after this long needs a person to look. */
const STALE_REFUND_MS = 60 * 60_000;

const summarySelect = {
  id: true,
  status: true,
  seats: true,
  totalAmountPaise: true,
  refundedAmountPaise: true,
  currency: true,
  createdAt: true,
  user: { select: { id: true, username: true, displayName: true } },
  package: {
    select: { id: true, title: true, operator: { select: { id: true, displayName: true } } },
  },
  payments: {
    select: { status: true, capturedAt: true, failureCode: true },
    orderBy: { createdAt: 'desc' },
  },
  refunds: { select: { status: true, createdAt: true } },
} as const satisfies Prisma.BookingSelect;

type SummaryRow = Prisma.BookingGetPayload<{ select: typeof summarySelect }>;

/** The same rule as `needsAttention`, as a database filter. */
function attentionWhere(now: Date): Prisma.BookingWhereInput {
  return {
    OR: [
      { refunds: { some: { status: 'FAILED' } } },
      {
        refunds: {
          some: { status: 'PENDING', createdAt: { lt: new Date(now.getTime() - STALE_REFUND_MS) } },
        },
      },
      { payments: { some: { failureCode: 'AMOUNT_MISMATCH' } } },
      // Money taken for a booking that never held its places, and not yet given back.
      {
        status: { in: ['PENDING_PAYMENT', 'EXPIRED'] },
        payments: { some: { capturedAt: { not: null } } },
      },
    ],
  };
}

function needsAttention(row: SummaryRow, now: Date): boolean {
  return (
    row.refunds.some(
      (r) =>
        r.status === 'FAILED' ||
        (r.status === 'PENDING' && r.createdAt.getTime() < now.getTime() - STALE_REFUND_MS),
    ) ||
    row.payments.some((p) => p.failureCode === 'AMOUNT_MISMATCH') ||
    ((row.status === 'PENDING_PAYMENT' || row.status === 'EXPIRED') &&
      row.payments.some((p) => p.capturedAt !== null))
  );
}

function toSummary(row: SummaryRow, now: Date): AdminBookingSummary {
  return {
    id: row.id,
    status: row.status,
    seats: row.seats,
    totalAmountPaise: row.totalAmountPaise,
    refundedAmountPaise: row.refundedAmountPaise,
    currency: row.currency,
    createdAt: row.createdAt.toISOString(),
    customer: row.user,
    package: { id: row.package.id, title: row.package.title },
    operator: row.package.operator,
    paymentStatus: row.payments[0]?.status ?? null,
    needsAttention: needsAttention(row, now),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Payments support for staff: find bookings, see every payment, refund, ledger line and provider
 * event, re-check a booking with the provider, and refund or retry a refund. Every change is
 * audited. Card details are never stored, so there are none to show.
 */
@Injectable()
export class AdminBookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGateway,
    private readonly payments: PaymentsService,
    private readonly reconciliation: ReconciliationService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(
    query: z.output<typeof AdminBookingsQuerySchema>,
  ): Promise<PageResponse<AdminBookingSummary>> {
    const now = new Date();
    const cursor = decodeCursor(query.cursor);
    const q = query.q?.trim();
    const rows = await this.prisma.booking.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        AND: [
          query.attention ? attentionWhere(now) : {},
          q
            ? {
                OR: [
                  ...(UUID_RE.test(q) ? [{ id: q }] : []),
                  { user: { username: { contains: q, mode: 'insensitive' } } },
                  { package: { title: { contains: q, mode: 'insensitive' } } },
                  {
                    payments: { some: { OR: [{ providerOrderId: q }, { providerPaymentId: q }] } },
                  },
                  { refunds: { some: { providerRefundId: q } } },
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
      select: summarySelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map((row) => toSummary(row, now)), page: page.page };
  }

  async get(id: string): Promise<AdminBookingDetail> {
    const now = new Date();
    const row = await this.prisma.booking.findUnique({
      where: { id },
      select: {
        ...summarySelect,
        unitPricePaise: true,
        commissionBps: true,
        commissionPaise: true,
        commissionTaxBps: true,
        commissionTaxPaise: true,
        operatorPayablePaise: true,
        expiresAt: true,
        confirmedAt: true,
        cancelledAt: true,
        cancelledBy: true,
        cancellationReason: true,
        refundTiers: true,
      },
    });
    if (!row) throw new NotFoundException('Booking not found');
    const [payments, refunds, ledger, events] = await Promise.all([
      this.prisma.payment.findMany({ where: { bookingId: id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.refund.findMany({ where: { bookingId: id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.ledgerEntry.findMany({
        where: { bookingId: id },
        orderBy: [{ createdAt: 'asc' }, { kind: 'asc' }],
      }),
      this.prisma.paymentEvent.findMany({
        where: { bookingId: id },
        orderBy: { receivedAt: 'asc' },
        take: 100,
      }),
    ]);
    const captured = payments.find((p) => p.capturedAt);
    const committed = refunds
      .filter((r) => r.status !== 'FAILED')
      .reduce((s, r) => s + r.amountPaise, 0);
    const actions: AdminBookingDetail['actions'] = [];
    if (this.gateway.enabled) actions.push('reconcile');
    if (captured && captured.amountPaise - committed > 0) actions.push('refund');
    if (refunds.some((r) => r.status === 'FAILED')) actions.push('retry_refund');
    const tiers = RefundTiersSchema.safeParse(row.refundTiers);
    return {
      ...toSummary(row, now),
      unitPricePaise: row.unitPricePaise,
      commissionBps: row.commissionBps,
      commissionPaise: row.commissionPaise,
      commissionTaxBps: row.commissionTaxBps,
      commissionTaxPaise: row.commissionTaxPaise,
      operatorPayablePaise: row.operatorPayablePaise,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      cancelledBy: row.cancelledBy,
      cancellationReason: row.cancellationReason,
      refundTiers: tiers.success ? tiers.data : [],
      payments: payments.map((p) => ({
        id: p.id,
        provider: p.provider,
        providerOrderId: p.providerOrderId,
        providerPaymentId: p.providerPaymentId,
        status: p.status,
        amountPaise: p.amountPaise,
        refundedAmountPaise: p.refundedAmountPaise,
        providerFeePaise: p.providerFeePaise,
        providerTaxPaise: p.providerTaxPaise,
        method: p.method,
        failureReason: p.failureReason,
        capturedAt: p.capturedAt?.toISOString() ?? null,
        createdAt: p.createdAt.toISOString(),
      })),
      refunds: refunds.map((r) => ({
        id: r.id,
        amountPaise: r.amountPaise,
        status: r.status,
        initiator: r.initiator,
        refundPercent: r.refundPercent,
        createdAt: r.createdAt.toISOString(),
        processedAt: r.processedAt?.toISOString() ?? null,
        providerRefundId: r.providerRefundId,
        reason: r.reason,
        failureReason: r.failureReason,
      })),
      ledger: ledger.map((l) => ({
        id: l.id,
        kind: l.kind,
        amountPaise: l.amountPaise,
        currency: l.currency,
        createdAt: l.createdAt.toISOString(),
      })),
      events: events.map((e) => ({
        id: e.id,
        provider: e.provider,
        eventType: e.eventType,
        signatureValid: e.signatureValid,
        result: e.result,
        receivedAt: e.receivedAt.toISOString(),
      })),
      actions,
    };
  }

  /** Re-checks the booking with the provider and applies whatever it says. */
  async reconcile(
    actor: Actor,
    id: string,
  ): Promise<{ summary: ReconcileSummary; booking: AdminBookingDetail }> {
    await this.mustExist(id);
    if (!this.gateway.enabled) throw new ConflictException('Payments are not set up');
    const summary = await this.reconciliation.reconcileBooking(id);
    await this.prisma.$transaction((tx) =>
      recordAudit(tx, actor, {
        action: 'booking.reconcile',
        entityType: 'booking',
        entityId: id,
        metadata: {
          payments: summary.payments,
          refunds: summary.refunds,
          expired: summary.expired,
        },
      }),
    );
    return { summary, booking: await this.get(id) };
  }

  /**
   * Refunds part of a booking (a goodwill refund; the booking stands), or everything left when no
   * amount is given, which also cancels the booking if it still holds places.
   */
  async refund(
    actor: Actor,
    id: string,
    input: z.output<typeof AdminRefundSchema>,
  ): Promise<AdminBookingDetail> {
    const booking = await this.mustExist(id);
    const full = input.amountPaise === undefined;
    if (full) {
      const paid = await this.prisma.payment.findFirst({
        where: { bookingId: id, capturedAt: { not: null } },
        select: {
          amountPaise: true,
          refunds: { where: { status: { not: 'FAILED' } }, select: { amountPaise: true } },
        },
      });
      const left = paid
        ? paid.amountPaise - paid.refunds.reduce((s, r) => s + r.amountPaise, 0)
        : 0;
      if (left <= 0) throw new ConflictException('Nothing is left to refund');
      await this.prisma.$transaction(async (tx) => {
        const cancelled = await tx.booking.updateMany({
          where: { id, status: { in: ['PENDING_PAYMENT', 'CONFIRMED'] } },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledBy: 'ADMIN',
            cancellationReason: input.reason,
          },
        });
        await recordAudit(tx, actor, {
          action: 'booking.refund',
          entityType: 'booking',
          entityId: id,
          reason: input.reason,
          metadata: { amount: 'remaining', cancelled: cancelled.count > 0 },
        });
        if (cancelled.count > 0) {
          await this.notifications.notify(tx, [booking.userId], {
            type: 'BOOKING_UPDATE',
            title: `${booking.package.title} was cancelled by Voyago`,
            body: `${input.reason} You get a full refund.`,
            data: { bookingId: id },
          });
        }
      });
      await this.payments.refundRemaining(id, {
        initiator: 'ADMIN',
        reason: input.reason,
        key: `admin:${randomUUID()}`,
        requestedById: actor.user.id,
      });
    } else {
      const refund = await this.payments.startRefund(id, {
        amountPaise: input.amountPaise!,
        initiator: 'ADMIN',
        reason: input.reason,
        key: `admin:${randomUUID()}`,
        requestedById: actor.user.id,
      });
      await this.prisma.$transaction((tx) =>
        recordAudit(tx, actor, {
          action: 'booking.refund',
          entityType: 'booking',
          entityId: id,
          reason: input.reason,
          metadata: { amountPaise: input.amountPaise!, refundId: refund.id },
        }),
      );
    }
    return this.get(id);
  }

  /** Sends a failed refund to the provider again. */
  async retryRefund(actor: Actor, refundId: string): Promise<AdminBookingDetail> {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      select: { id: true, status: true, bookingId: true },
    });
    if (!refund) throw new NotFoundException('Refund not found');
    if (refund.status !== 'FAILED')
      throw new ConflictException('Only failed refunds can be retried');
    await this.prisma.$transaction((tx) =>
      recordAudit(tx, actor, {
        action: 'refund.retry',
        entityType: 'refund',
        entityId: refund.id,
        metadata: { bookingId: refund.bookingId },
      }),
    );
    await this.payments.sendRefund(refund.id);
    return this.get(refund.bookingId);
  }

  private async mustExist(id: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      select: { id: true, status: true, userId: true, package: { select: { title: true } } },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    return booking;
  }
}
