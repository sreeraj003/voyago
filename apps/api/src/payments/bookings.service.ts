import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  type Booking,
  BOOKING_HOLD_MINUTES,
  type BookingsQuerySchema,
  type CreateBookingSchema,
  formatPaise,
  type OperatorBooking,
  type OperatorBookingsQuerySchema,
  type PageResponse,
  refundPercentFor,
  type RefundTier,
  RefundTiersSchema,
  splitBooking,
} from '@voyago/shared';
import { type z } from 'zod';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { CheckoutTokens } from './checkout-tokens.js';
import { PaymentGateway, PaymentProviderError } from './payment-gateway.js';
import { isCapacityError, PaymentsService } from './payments.service.js';

const HOUR_MS = 3_600_000;
const HOLDING: Prisma.EnumBookingStatusFilter<'Booking'> = { in: ['PENDING_PAYMENT', 'CONFIRMED'] };

const bookingSelect = {
  id: true,
  userId: true,
  status: true,
  seats: true,
  unitPricePaise: true,
  totalAmountPaise: true,
  refundedAmountPaise: true,
  currency: true,
  createdAt: true,
  expiresAt: true,
  confirmedAt: true,
  cancelledAt: true,
  cancelledBy: true,
  cancellationReason: true,
  cancellationPolicy: true,
  refundTiers: true,
  package: {
    select: {
      id: true,
      title: true,
      destinationName: true,
      startsAt: true,
      endsAt: true,
      meetingPointName: true,
      operator: { select: { slug: true, displayName: true } },
    },
  },
  payments: {
    select: { status: true, failureReason: true },
    orderBy: { createdAt: 'desc' },
    take: 1,
  },
  refunds: {
    select: {
      id: true,
      amountPaise: true,
      status: true,
      initiator: true,
      refundPercent: true,
      createdAt: true,
      processedAt: true,
    },
    orderBy: { createdAt: 'asc' },
  },
} as const satisfies Prisma.BookingSelect;

type BookingRow = Prisma.BookingGetPayload<{ select: typeof bookingSelect }>;

const tiersOf = (value: unknown): RefundTier[] => {
  const parsed = RefundTiersSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
};

/**
 * Customers booking paid experiences, and businesses seeing (and cancelling) their bookings.
 * The server prices every booking from the package; the client only chooses the places. Places
 * are held for BOOKING_HOLD_MINUTES while the customer pays; a database trigger refuses any
 * booking that would oversell.
 */
@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGateway,
    private readonly payments: PaymentsService,
    private readonly notifications: NotificationsService,
    private readonly tokens: CheckoutTokens,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ── Customer ──────────────────────────────────────────────────────────────

  async create(
    userId: string,
    packageId: string,
    input: z.output<typeof CreateBookingSchema>,
  ): Promise<Booking> {
    if (!this.gateway.enabled) {
      throw new ServiceUnavailableException('Online booking is not available yet');
    }
    const returnUrl = this.tokens.checkReturnUrl(input.returnUrl);
    const repeat = await this.prisma.booking.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } },
      select: { id: true, packageId: true },
    });
    if (repeat) {
      if (repeat.packageId !== packageId) {
        throw new ConflictException('This key was already used for another booking');
      }
      return this.view(userId, repeat.id, returnUrl);
    }

    const pkg = await this.prisma.commercialPackage.findUnique({
      where: { id: packageId },
      select: {
        id: true,
        title: true,
        status: true,
        startsAt: true,
        pricePaise: true,
        currency: true,
        maxGroupSize: true,
        cancellationPolicy: true,
        refundTiers: true,
        operator: { select: { ownerUserId: true, verificationStatus: true } },
      },
    });
    const now = new Date();
    if (
      !pkg ||
      pkg.status !== 'PUBLISHED' ||
      pkg.operator.verificationStatus !== 'VERIFIED' ||
      !pkg.startsAt
    ) {
      throw new NotFoundException('Package not found');
    }
    if (pkg.operator.ownerUserId === userId) {
      throw new ForbiddenException('You cannot book your own package');
    }
    if (pkg.startsAt <= now) throw new ConflictException('This experience has started');
    const tiers = tiersOf(pkg.refundTiers);
    if (tiers.length === 0)
      throw new ConflictException('This experience has no refund schedule yet');

    // A hold that is still running is the one to pay; stale holds give their places back.
    const pending = await this.prisma.booking.findFirst({
      where: { userId, packageId, status: 'PENDING_PAYMENT' },
      select: { id: true, expiresAt: true },
    });
    if (pending && pending.expiresAt && pending.expiresAt > now) {
      return this.view(userId, pending.id, returnUrl);
    }
    await this.expireStaleHolds(packageId, now);

    const total = pkg.pricePaise * input.seats;
    const split = splitBooking(
      total,
      this.config.PLATFORM_COMMISSION_BPS,
      this.config.COMMISSION_TAX_BPS,
    );
    const expiresAt = new Date(now.getTime() + BOOKING_HOLD_MINUTES * 60_000);
    let ids: { bookingId: string; paymentId: string };
    try {
      ids = await this.prisma.$transaction(async (tx) => {
        const booking = await tx.booking.create({
          data: {
            userId,
            packageId,
            seats: input.seats,
            unitPricePaise: pkg.pricePaise,
            totalAmountPaise: total,
            currency: pkg.currency,
            idempotencyKey: input.idempotencyKey,
            expiresAt,
            commissionBps: this.config.PLATFORM_COMMISSION_BPS,
            commissionPaise: split.commissionPaise,
            commissionTaxBps: this.config.COMMISSION_TAX_BPS,
            commissionTaxPaise: split.commissionTaxPaise,
            operatorPayablePaise: split.operatorPayablePaise,
            cancellationPolicy: pkg.cancellationPolicy,
            refundTiers: tiers,
          },
          select: { id: true },
        });
        const payment = await tx.payment.create({
          data: {
            userId,
            bookingId: booking.id,
            provider: this.gateway.name,
            amountPaise: total,
            currency: pkg.currency,
            idempotencyKey: `booking:${booking.id}`,
          },
          select: { id: true },
        });
        return { bookingId: booking.id, paymentId: payment.id };
      });
    } catch (error) {
      if (isCapacityError(error)) {
        const held = await this.prisma.booking.aggregate({
          where: { packageId, status: HOLDING },
          _sum: { seats: true },
        });
        const left = Math.max(0, pkg.maxGroupSize - (held._sum?.seats ?? 0));
        throw new ConflictException(
          left === 0
            ? 'This experience is fully booked'
            : `Only ${left} ${left === 1 ? 'place is' : 'places are'} left`,
        );
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // A parallel request with the same key or a second hold: answer with what exists.
        const existing = await this.prisma.booking.findFirst({
          where: {
            userId,
            OR: [
              { idempotencyKey: input.idempotencyKey },
              { packageId, status: 'PENDING_PAYMENT' },
            ],
          },
          select: { id: true },
        });
        if (existing) return this.view(userId, existing.id, returnUrl);
      }
      throw error;
    }

    try {
      const order = await this.gateway.createOrder({
        amountPaise: total,
        currency: pkg.currency,
        receipt: ids.bookingId.replace(/-/g, '').slice(0, 40),
        notes: { bookingId: ids.bookingId, packageId },
      });
      if (order.amountPaise !== total || order.currency !== pkg.currency) {
        throw new PaymentProviderError('The payment order does not match the booking', false);
      }
      await this.prisma.payment.update({
        where: { id: ids.paymentId },
        data: { providerOrderId: order.id },
      });
    } catch (error) {
      // No order, no payment: release the places at once.
      await this.prisma.$transaction([
        this.prisma.booking.update({
          where: { id: ids.bookingId },
          data: { status: 'EXPIRED', expiresAt: now },
        }),
        this.prisma.payment.update({
          where: { id: ids.paymentId },
          data: {
            status: 'FAILED',
            failureCode: 'ORDER_FAILED',
            failureReason: (error as Error).message.slice(0, 500),
          },
        }),
      ]);
      this.logger.warn(`Could not create a payment order: ${(error as Error).message}`);
      throw new ServiceUnavailableException(
        'Payments are not available right now. Try again shortly.',
      );
    }
    return this.view(userId, ids.bookingId, returnUrl);
  }

  async listMine(
    userId: string,
    query: z.output<typeof BookingsQuerySchema>,
  ): Promise<PageResponse<Booking>> {
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.booking.findMany({
      where: {
        userId,
        // Holds that were never paid are noise once they lapse.
        NOT: { status: 'EXPIRED', payments: { none: { capturedAt: { not: null } } } },
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      select: bookingSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit);
    const meeting = await this.meetingPoints(page.data);
    return {
      data: page.data.map((row) => this.toBooking(row, meeting.get(row.id) ?? null, null)),
      page: page.page,
    };
  }

  async view(userId: string, id: string, returnUrl?: string | null): Promise<Booking> {
    const row = await this.prisma.booking.findUnique({ where: { id }, select: bookingSelect });
    if (!row || row.userId !== userId) throw new NotFoundException('Booking not found');
    const meeting = await this.meetingPoints([row]);
    return this.toBooking(row, meeting.get(row.id) ?? null, returnUrl ?? null);
  }

  /** The booking, with a payment link that returns to `returnUrl` (checked) while unpaid. */
  async viewWithReturn(
    userId: string,
    id: string,
    returnUrl: string | undefined,
  ): Promise<Booking> {
    return this.view(userId, id, this.tokens.checkReturnUrl(returnUrl));
  }

  /**
   * Customer cancellation. An unpaid hold is simply released. A confirmed booking is refunded by
   * the schedule agreed when booking, counted from the hours left before the start.
   */
  async cancel(userId: string, id: string, reason: string | undefined): Promise<Booking> {
    const row = await this.prisma.booking.findUnique({
      where: { id },
      select: {
        userId: true,
        status: true,
        totalAmountPaise: true,
        refundTiers: true,
        package: {
          select: {
            id: true,
            startsAt: true,
            title: true,
            operator: { select: { ownerUserId: true } },
          },
        },
      },
    });
    if (!row || row.userId !== userId) throw new NotFoundException('Booking not found');
    const now = Date.now();
    if (row.status === 'PENDING_PAYMENT') {
      await this.prisma.booking.updateMany({
        where: { id, status: 'PENDING_PAYMENT' },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: 'CUSTOMER',
          cancellationReason: reason ?? null,
          expiresAt: null,
        },
      });
      return this.view(userId, id);
    }
    if (row.status !== 'CONFIRMED') throw new ConflictException('This booking cannot be cancelled');
    const startsAt = row.package.startsAt?.getTime() ?? 0;
    if (startsAt <= now)
      throw new ConflictException('The experience has started; it can no longer be cancelled');
    const hoursLeft = (startsAt - now) / HOUR_MS;
    const tiers = tiersOf(row.refundTiers);
    const percent = refundPercentFor(tiers, hoursLeft);
    const tier = tiers.find((t) => t.refundPercent === percent && hoursLeft >= t.hoursBefore);
    const refundPaise = Math.floor((row.totalAmountPaise * percent) / 100);

    const changed = await this.prisma.$transaction(async (tx) => {
      const c = await tx.booking.updateMany({
        where: { id, status: 'CONFIRMED' },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: 'CUSTOMER',
          cancellationReason: reason ?? null,
        },
      });
      if (c.count > 0) {
        await this.notifications.notify(tx, [row.package.operator.ownerUserId], {
          type: 'BOOKING_UPDATE',
          title: `Booking cancelled: ${row.package.title}`,
          body:
            refundPaise > 0
              ? `The customer gets ${formatPaise(refundPaise)} back under your policy.`
              : 'No refund was due under your policy.',
          data: { packageId: row.package.id },
        });
      }
      return c.count;
    });
    if (changed === 0) throw new ConflictException('This booking changed. Reload and try again.');
    if (refundPaise > 0) {
      await this.payments.startRefund(id, {
        amountPaise: refundPaise,
        initiator: 'CUSTOMER',
        requestedById: userId,
        reason: reason ?? 'Cancelled by the customer',
        key: `cancel:${id}`,
        hoursBefore: tier?.hoursBefore,
        refundPercent: percent,
      });
    }
    return this.view(userId, id);
  }

  // ── Business ──────────────────────────────────────────────────────────────

  async operatorBookings(
    userId: string,
    query: z.output<typeof OperatorBookingsQuerySchema>,
  ): Promise<PageResponse<OperatorBooking>> {
    const operator = await this.prisma.commercialOperator.findUnique({
      where: { ownerUserId: userId },
      select: { id: true },
    });
    if (!operator) throw new NotFoundException('You have no business profile yet');
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.booking.findMany({
      where: {
        package: { operatorId: operator.id },
        ...(query.packageId ? { packageId: query.packageId } : {}),
        ...(query.status ? { status: query.status } : { status: { not: 'EXPIRED' } }),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        status: true,
        seats: true,
        totalAmountPaise: true,
        refundedAmountPaise: true,
        commissionPaise: true,
        commissionTaxPaise: true,
        operatorPayablePaise: true,
        currency: true,
        createdAt: true,
        confirmedAt: true,
        cancelledAt: true,
        user: { select: { username: true, displayName: true } },
        package: { select: { id: true, title: true, startsAt: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit);
    const now = Date.now();
    return {
      data: page.data.map((b) => ({
        id: b.id,
        status: b.status,
        seats: b.seats,
        totalAmountPaise: b.totalAmountPaise,
        refundedAmountPaise: b.refundedAmountPaise,
        commissionPaise: b.commissionPaise,
        commissionTaxPaise: b.commissionTaxPaise,
        operatorPayablePaise: b.operatorPayablePaise,
        currency: b.currency,
        createdAt: b.createdAt.toISOString(),
        confirmedAt: b.confirmedAt?.toISOString() ?? null,
        cancelledAt: b.cancelledAt?.toISOString() ?? null,
        customer: b.user,
        package: {
          id: b.package.id,
          title: b.package.title,
          startsAt: b.package.startsAt?.toISOString() ?? null,
        },
        actions:
          b.status === 'CONFIRMED' && (b.package.startsAt?.getTime() ?? 0) > now
            ? ['cancel' as const]
            : [],
      })),
      page: page.page,
    };
  }

  /** The business cancels a confirmed booking: the customer always gets everything back. */
  async operatorCancel(userId: string, id: string, reason: string): Promise<void> {
    const row = await this.prisma.booking.findUnique({
      where: { id },
      select: {
        status: true,
        userId: true,
        package: {
          select: { title: true, startsAt: true, operator: { select: { ownerUserId: true } } },
        },
      },
    });
    if (!row || row.package.operator.ownerUserId !== userId)
      throw new NotFoundException('Booking not found');
    if (row.status !== 'CONFIRMED')
      throw new ConflictException('Only confirmed bookings can be cancelled');
    if ((row.package.startsAt?.getTime() ?? 0) <= Date.now()) {
      throw new ConflictException('The experience has started; contact Voyago support');
    }
    await this.prisma.$transaction(async (tx) => {
      const c = await tx.booking.updateMany({
        where: { id, status: 'CONFIRMED' },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: 'OPERATOR',
          cancellationReason: reason,
        },
      });
      if (c.count === 0) throw new ConflictException('This booking changed. Reload and try again.');
      await tx.auditLog.create({
        data: {
          actorId: userId,
          actorType: 'USER',
          action: 'booking.operator_cancel',
          entityType: 'booking',
          entityId: id,
          metadata: { reason },
        },
      });
      await this.notifications.notify(tx, [row.userId], {
        type: 'BOOKING_UPDATE',
        title: `${row.package.title} was cancelled by the business`,
        body: `${reason} You get a full refund.`,
        data: { bookingId: id },
      });
    });
    await this.payments.refundRemaining(id, {
      initiator: 'OPERATOR',
      reason,
      key: `operator-cancel:${id}`,
      requestedById: userId,
    });
  }

  // ── Holds ─────────────────────────────────────────────────────────────────

  /** Releases unpaid holds on a package whose time ran out (late payments are still honoured). */
  async expireStaleHolds(packageId: string | null, now = new Date()) {
    await this.prisma.booking.updateMany({
      where: {
        status: 'PENDING_PAYMENT',
        expiresAt: { lt: now },
        ...(packageId ? { packageId } : {}),
      },
      data: { status: 'EXPIRED' },
    });
  }

  // ── Views ─────────────────────────────────────────────────────────────────

  private async meetingPoints(rows: BookingRow[]) {
    const confirmed = rows.filter((r) => r.status === 'CONFIRMED' || r.status === 'COMPLETED');
    const map = new Map<string, { name: string; point: { latitude: number; longitude: number } }>();
    if (confirmed.length === 0) return map;
    const packageIds = [...new Set(confirmed.map((r) => r.package.id))];
    const points = await this.prisma.$queryRaw<
      { id: string; lat: number | null; lng: number | null }[]
    >(Prisma.sql`
      SELECT "id", ST_Y("meeting_point"::geometry) AS lat, ST_X("meeting_point"::geometry) AS lng
      FROM "commercial_packages" WHERE "id" = ANY(${packageIds}::uuid[])`);
    for (const row of confirmed) {
      const p = points.find((x) => x.id === row.package.id);
      if (p && p.lat !== null && p.lng !== null) {
        map.set(row.id, {
          name: row.package.meetingPointName ?? '',
          point: { latitude: p.lat, longitude: p.lng },
        });
      }
    }
    return map;
  }

  private toBooking(
    row: BookingRow,
    meetingPoint: Booking['package']['meetingPoint'],
    returnUrl: string | null,
  ): Booking {
    const now = Date.now();
    const tiers = tiersOf(row.refundTiers);
    const startsAt = row.package.startsAt?.getTime() ?? 0;
    const payment = row.payments[0] ?? null;
    const pendingLive = row.status === 'PENDING_PAYMENT' && (row.expiresAt?.getTime() ?? 0) > now;
    const cancellable = (row.status === 'CONFIRMED' && startsAt > now) || pendingLive;
    const percent =
      row.status === 'CONFIRMED' ? refundPercentFor(tiers, (startsAt - now) / HOUR_MS) : 0;
    const actions: Booking['actions'] = [];
    if (pendingLive) actions.push('pay');
    if (cancellable) actions.push('cancel');
    return {
      id: row.id,
      status: row.status,
      seats: row.seats,
      unitPricePaise: row.unitPricePaise,
      totalAmountPaise: row.totalAmountPaise,
      refundedAmountPaise: row.refundedAmountPaise,
      currency: row.currency,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.status === 'PENDING_PAYMENT' ? (row.expiresAt?.toISOString() ?? null) : null,
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      cancelledBy: row.cancelledBy,
      cancellationReason: row.cancellationReason,
      cancellationPolicy: row.cancellationPolicy,
      refundTiers: tiers,
      package: {
        id: row.package.id,
        title: row.package.title,
        destinationName: row.package.destinationName,
        startsAt: row.package.startsAt?.toISOString() ?? null,
        endsAt: row.package.endsAt?.toISOString() ?? null,
        operator: row.package.operator,
        meetingPoint,
      },
      payment: payment ? { status: payment.status, failureReason: payment.failureReason } : null,
      refunds: row.refunds.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        processedAt: r.processedAt?.toISOString() ?? null,
      })),
      cancellation: cancellable
        ? {
            refundPercent: percent,
            refundPaise: Math.floor((row.totalAmountPaise * percent) / 100),
          }
        : null,
      checkoutUrl: pendingLive ? this.tokens.checkoutUrl(row.id, row.expiresAt!, returnUrl) : null,
      actions,
    };
  }
}
