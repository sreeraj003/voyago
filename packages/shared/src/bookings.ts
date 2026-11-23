import { z } from 'zod';
import { CursorPageQuerySchema, PageInfoSchema } from './pagination.js';

/**
 * Bookings and payments for paid experiences. Amounts are whole paise (integers) with an explicit
 * currency; nothing here uses floating-point money. The server works out every amount: the
 * client only says how many places it wants.
 */

// ── Refund schedule ─────────────────────────────────────────────────────────

/** "Cancel at least `hoursBefore` hours before the start and get `refundPercent`% back." */
export const RefundTierSchema = z.object({
  hoursBefore: z.number().int().min(0).max(8760),
  refundPercent: z.number().int().min(0).max(100),
});
export type RefundTier = z.infer<typeof RefundTierSchema>;

export const MAX_REFUND_TIERS = 6;

/** Tiers sorted from the earliest cancellation (most hours before) to the latest. */
export const RefundTiersSchema = z
  .array(RefundTierSchema)
  .max(MAX_REFUND_TIERS)
  .superRefine((tiers, ctx) => {
    const hours = tiers.map((t) => t.hoursBefore);
    if (new Set(hours).size !== hours.length) {
      ctx.addIssue({ code: 'custom', message: 'Use each number of hours once' });
    }
    const sorted = [...tiers].sort((a, b) => b.hoursBefore - a.hoursBefore);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.refundPercent > sorted[i - 1]!.refundPercent) {
        ctx.addIssue({
          code: 'custom',
          message: 'Refunds can only stay the same or go down closer to the start',
        });
        break;
      }
    }
  })
  .transform((tiers) => [...tiers].sort((a, b) => b.hoursBefore - a.hoursBefore));

/**
 * The refund for cancelling `hoursLeft` hours before the start: the tier with the most hours
 * that is still met. No tier met, or the experience has started: nothing back.
 */
export function refundPercentFor(tiers: readonly RefundTier[], hoursLeft: number): number {
  if (hoursLeft <= 0) return 0;
  let best: RefundTier | undefined;
  for (const tier of tiers) {
    if (hoursLeft >= tier.hoursBefore && (!best || tier.hoursBefore > best.hoursBefore)) {
      best = tier;
    }
  }
  return best?.refundPercent ?? 0;
}

/** "Full refund up to 7 days before; 50% up to 2 days before; no refund after." */
export function describeRefundTiers(tiers: readonly RefundTier[]): string {
  if (tiers.length === 0) return 'No refunds';
  const span = (hours: number) =>
    hours === 0
      ? 'until the start'
      : hours % 24 === 0
        ? `up to ${hours / 24} ${hours === 24 ? 'day' : 'days'} before the start`
        : `up to ${hours} ${hours === 1 ? 'hour' : 'hours'} before the start`;
  const sorted = [...tiers].sort((a, b) => b.hoursBefore - a.hoursBefore);
  const parts = sorted.map((t) =>
    t.refundPercent === 100
      ? `full refund ${span(t.hoursBefore)}`
      : t.refundPercent === 0
        ? `no refund ${span(t.hoursBefore)}`
        : `${t.refundPercent}% back ${span(t.hoursBefore)}`,
  );
  const last = sorted.at(-1)!;
  if (last.hoursBefore > 0 && last.refundPercent > 0) parts.push('no refund after that');
  const text = parts.join('; ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ── Money ───────────────────────────────────────────────────────────────────

/** `amount × bps / 10,000`, rounded half up, in integers only. */
export function basisPoints(amountPaise: number, bps: number): number {
  if (!Number.isSafeInteger(amountPaise) || !Number.isSafeInteger(bps)) {
    throw new Error('Money values must be whole numbers');
  }
  return Math.floor((amountPaise * bps + 5_000) / 10_000);
}

export type BookingSplit = {
  totalPaise: number;
  commissionPaise: number;
  commissionTaxPaise: number;
  operatorPayablePaise: number;
};

/** What the platform keeps (commission and the tax on it) and what the business is owed. */
export function splitBooking(
  totalPaise: number,
  commissionBps: number,
  commissionTaxBps: number,
): BookingSplit {
  const commissionPaise = basisPoints(totalPaise, commissionBps);
  const commissionTaxPaise = basisPoints(commissionPaise, commissionTaxBps);
  return {
    totalPaise,
    commissionPaise,
    commissionTaxPaise,
    operatorPayablePaise: totalPaise - commissionPaise - commissionTaxPaise,
  };
}

/**
 * The share of `part` that belongs to `refunded` of `total`, so that refunds in several steps add
 * up exactly to the original once everything is refunded.
 */
export function proportional(part: number, refunded: number, total: number): number {
  if (total <= 0) return 0;
  return Math.floor((part * refunded) / total);
}

// ── Bookings ────────────────────────────────────────────────────────────────

export const MAX_SEATS_PER_BOOKING = 10;
/** How long places are held while the customer pays. */
export const BOOKING_HOLD_MINUTES = 15;

export const BookingStatusSchema = z.enum([
  'PENDING_PAYMENT',
  'CONFIRMED',
  'CANCELLED',
  'REFUNDED',
  'COMPLETED',
  'EXPIRED',
]);
export type BookingStatus = z.infer<typeof BookingStatusSchema>;

export const RefundStatusSchema = z.enum(['PENDING', 'PROCESSED', 'FAILED']);
export const CancellationActorSchema = z.enum(['CUSTOMER', 'OPERATOR', 'ADMIN', 'SYSTEM']);

export const CreateBookingSchema = z.object({
  seats: z.number().int().min(1).max(MAX_SEATS_PER_BOOKING),
  /** A fresh random key per checkout attempt; retrying with the same key returns the same booking. */
  idempotencyKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{16,100}$/, 'Send a random key of 16 to 100 letters, digits, - or _'),
  /** Where the checkout page sends the customer afterwards (the app or the web app). */
  returnUrl: z.string().max(500).optional(),
});
export type CreateBookingInput = z.input<typeof CreateBookingSchema>;

export const CancelBookingSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const BookingRefundSchema = z.object({
  id: z.uuid(),
  amountPaise: z.number().int(),
  status: RefundStatusSchema,
  initiator: CancellationActorSchema,
  refundPercent: z.number().int().nullable(),
  createdAt: z.string(),
  processedAt: z.string().nullable(),
});
export type BookingRefund = z.infer<typeof BookingRefundSchema>;

/** A customer's booking. */
export const BookingSchema = z.object({
  id: z.uuid(),
  status: BookingStatusSchema,
  seats: z.number().int(),
  unitPricePaise: z.number().int(),
  totalAmountPaise: z.number().int(),
  refundedAmountPaise: z.number().int(),
  currency: z.string(),
  createdAt: z.string(),
  /** Places are held until then while the payment is pending. */
  expiresAt: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelledBy: CancellationActorSchema.nullable(),
  cancellationReason: z.string().nullable(),
  /** The terms agreed when booking. */
  cancellationPolicy: z.string(),
  refundTiers: z.array(RefundTierSchema),
  package: z.object({
    id: z.uuid(),
    title: z.string(),
    destinationName: z.string(),
    startsAt: z.string().nullable(),
    endsAt: z.string().nullable(),
    operator: z.object({ slug: z.string(), displayName: z.string() }),
    /** Exact meeting point, shared once the booking is confirmed. */
    meetingPoint: z
      .object({
        name: z.string(),
        point: z.object({ latitude: z.number(), longitude: z.number() }),
      })
      .nullable(),
  }),
  payment: z
    .object({
      status: z.enum([
        'CREATED',
        'AUTHORIZED',
        'CAPTURED',
        'FAILED',
        'REFUNDED',
        'PARTIALLY_REFUNDED',
      ]),
      failureReason: z.string().nullable(),
    })
    .nullable(),
  refunds: z.array(BookingRefundSchema),
  /** What cancelling now would return; null when it can't be cancelled. */
  cancellation: z
    .object({ refundPercent: z.number().int(), refundPaise: z.number().int() })
    .nullable(),
  /** The payment page, while the payment is pending. */
  checkoutUrl: z.string().nullable(),
  actions: z.array(z.enum(['pay', 'cancel'])),
});
export type Booking = z.infer<typeof BookingSchema>;

export const BookingsQuerySchema = CursorPageQuerySchema;

/** Where the payment page should send the customer back to (the app's own addresses only). */
export const BookingViewQuerySchema = z.object({ returnUrl: z.string().max(500).optional() });

/** A booking as the business sees it: who (name only), places and money, read-only. */
export const OperatorBookingSchema = z.object({
  id: z.uuid(),
  status: BookingStatusSchema,
  seats: z.number().int(),
  totalAmountPaise: z.number().int(),
  refundedAmountPaise: z.number().int(),
  commissionPaise: z.number().int(),
  commissionTaxPaise: z.number().int(),
  operatorPayablePaise: z.number().int(),
  currency: z.string(),
  createdAt: z.string(),
  confirmedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  customer: z.object({ username: z.string(), displayName: z.string() }),
  package: z.object({ id: z.uuid(), title: z.string(), startsAt: z.string().nullable() }),
  actions: z.array(z.enum(['cancel'])),
});
export type OperatorBooking = z.infer<typeof OperatorBookingSchema>;

export const OperatorBookingsQuerySchema = CursorPageQuerySchema.extend({
  packageId: z.uuid().optional(),
  status: BookingStatusSchema.optional(),
});
export type OperatorBookingsQuery = z.input<typeof OperatorBookingsQuerySchema>;

// ── Admin ───────────────────────────────────────────────────────────────────

export const LedgerKindSchema = z.enum([
  'GROSS',
  'COMMISSION',
  'COMMISSION_TAX',
  'PROVIDER_FEE',
  'PROVIDER_FEE_TAX',
  'OPERATOR_PAYABLE',
  'REFUND',
  'COMMISSION_REVERSAL',
  'COMMISSION_TAX_REVERSAL',
  'OPERATOR_PAYABLE_REVERSAL',
]);

export const AdminBookingSummarySchema = z.object({
  id: z.uuid(),
  status: BookingStatusSchema,
  seats: z.number().int(),
  totalAmountPaise: z.number().int(),
  refundedAmountPaise: z.number().int(),
  currency: z.string(),
  createdAt: z.string(),
  customer: z.object({ id: z.uuid(), username: z.string(), displayName: z.string() }),
  package: z.object({ id: z.uuid(), title: z.string() }),
  operator: z.object({ id: z.uuid(), displayName: z.string() }),
  paymentStatus: z.string().nullable(),
  /** Something needs a person: a failed refund, or money taken for a booking that isn't confirmed. */
  needsAttention: z.boolean(),
});
export type AdminBookingSummary = z.infer<typeof AdminBookingSummarySchema>;
export const AdminBookingPageSchema = z.object({
  data: z.array(AdminBookingSummarySchema),
  page: PageInfoSchema,
});

export const AdminBookingsQuerySchema = CursorPageQuerySchema.extend({
  status: BookingStatusSchema.optional(),
  attention: z.enum(['true']).optional(),
  q: z.string().trim().max(100).optional(),
});
export type AdminBookingsQuery = z.input<typeof AdminBookingsQuerySchema>;

export const AdminBookingDetailSchema = AdminBookingSummarySchema.extend({
  unitPricePaise: z.number().int(),
  commissionBps: z.number().int(),
  commissionPaise: z.number().int(),
  commissionTaxBps: z.number().int(),
  commissionTaxPaise: z.number().int(),
  operatorPayablePaise: z.number().int(),
  expiresAt: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelledBy: CancellationActorSchema.nullable(),
  cancellationReason: z.string().nullable(),
  refundTiers: z.array(RefundTierSchema),
  payments: z.array(
    z.object({
      id: z.uuid(),
      provider: z.string(),
      providerOrderId: z.string().nullable(),
      providerPaymentId: z.string().nullable(),
      status: z.string(),
      amountPaise: z.number().int(),
      refundedAmountPaise: z.number().int(),
      providerFeePaise: z.number().int().nullable(),
      providerTaxPaise: z.number().int().nullable(),
      method: z.string().nullable(),
      failureReason: z.string().nullable(),
      capturedAt: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  refunds: z.array(
    BookingRefundSchema.extend({
      providerRefundId: z.string().nullable(),
      reason: z.string().nullable(),
      failureReason: z.string().nullable(),
    }),
  ),
  ledger: z.array(
    z.object({
      id: z.uuid(),
      kind: LedgerKindSchema,
      amountPaise: z.number().int(),
      currency: z.string(),
      createdAt: z.string(),
    }),
  ),
  events: z.array(
    z.object({
      id: z.uuid(),
      provider: z.string(),
      eventType: z.string(),
      signatureValid: z.boolean(),
      result: z.string().nullable(),
      receivedAt: z.string(),
    }),
  ),
  actions: z.array(z.enum(['reconcile', 'refund', 'retry_refund'])),
});
export type AdminBookingDetail = z.infer<typeof AdminBookingDetailSchema>;

export const AdminRefundSchema = z.object({
  /** Omit for everything not yet refunded. */
  amountPaise: z.number().int().positive().optional(),
  reason: z.string().trim().min(5).max(500),
});
export type AdminRefundInput = z.input<typeof AdminRefundSchema>;

/** What a reconciliation found and did. */
export const ReconcileResultSchema = z.object({
  summary: z.object({
    payments: z.array(z.string()),
    refunds: z.array(z.string()),
    expired: z.boolean(),
  }),
  booking: AdminBookingDetailSchema,
});
export type ReconcileResult = z.infer<typeof ReconcileResultSchema>;
