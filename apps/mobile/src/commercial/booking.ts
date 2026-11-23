import {
  type Booking,
  type BookingStatus,
  formatPaise,
  MAX_SEATS_PER_BOOKING,
} from '@voyago/shared';

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  PENDING_PAYMENT: 'Waiting for payment',
  CONFIRMED: 'Confirmed',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Hold ended',
  REFUNDED: 'Refunded',
  COMPLETED: 'Completed',
};

/** How many places can be picked: at least one, at most what is left and the per-booking cap. */
export const maxSeats = (seatsLeft: number) =>
  Math.max(0, Math.min(seatsLeft, MAX_SEATS_PER_BOOKING));

export const clampSeats = (seats: number, seatsLeft: number) =>
  Math.max(1, Math.min(Math.round(seats), Math.max(1, maxSeats(seatsLeft))));

/** "2 × ₹3,499 = ₹6,998". The server prices the booking; this is only the preview. */
export function priceLine(seats: number, pricePaise: number): string {
  const total = formatPaise(seats * pricePaise);
  return seats === 1 ? total : `${seats} × ${formatPaise(pricePaise)} = ${total}`;
}

/** What the payment page said when it sent the customer back (a hint; the server decides). */
export function checkoutOutcome(url: string): { bookingId: string | null; payment: string | null } {
  const query = url.split('?')[1] ?? '';
  const params = new URLSearchParams(query.split('#')[0]);
  return { bookingId: params.get('booking'), payment: params.get('payment') };
}

/** The line under a booking: what happens next or what happened. */
export function bookingNote(b: Booking, now = Date.now()): string {
  switch (b.status) {
    case 'PENDING_PAYMENT': {
      const minutes = b.expiresAt
        ? Math.max(0, Math.ceil((Date.parse(b.expiresAt) - now) / 60_000))
        : 0;
      if (b.payment?.status === 'FAILED') {
        return `The last payment did not go through${b.payment.failureReason ? `: ${b.payment.failureReason}` : ''}. Places are held for ${minutes} more min.`;
      }
      return `Places are held for ${minutes} more min while you pay.`;
    }
    case 'CONFIRMED':
      return 'You are booked. The exact meeting point is below.';
    case 'CANCELLED': {
      const pending = b.refunds.some((r) => r.status === 'PENDING');
      const failed = b.refunds.some((r) => r.status === 'FAILED');
      if (failed) return 'Cancelled. Your refund hit a problem; Voyago support is on it.';
      if (pending) return 'Cancelled. Your refund is on its way.';
      return b.refundedAmountPaise > 0
        ? `Cancelled. ${formatPaise(b.refundedAmountPaise)} was refunded.`
        : 'Cancelled. No refund was due under the schedule.';
    }
    case 'REFUNDED':
      return `${formatPaise(b.refundedAmountPaise)} was refunded. Banks can take 5 to 7 working days to show it.`;
    case 'EXPIRED':
      return 'The hold ended before payment. Nothing was charged.';
    case 'COMPLETED':
      return 'This experience has ended.';
  }
}
