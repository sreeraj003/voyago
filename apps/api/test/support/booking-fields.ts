import { splitBooking } from '@voyago/shared';
import { randomUUID } from 'node:crypto';

/**
 * The money and policy columns every booking row needs, for tests that insert bookings directly.
 * Commission 10% plus 18% tax on it, taken from the operator's share, as the API does.
 */
export function bookingFields(
  totalAmountPaise: number,
  opts: { status?: 'PENDING_PAYMENT' | 'CONFIRMED'; platformFeePaise?: number } = {},
) {
  const split = splitBooking(totalAmountPaise - (opts.platformFeePaise ?? 0), 1000, 1800);
  return {
    idempotencyKey: `test-${randomUUID()}`,
    commissionBps: 1000,
    commissionPaise: split.commissionPaise,
    commissionTaxBps: 1800,
    commissionTaxPaise: split.commissionTaxPaise,
    operatorPayablePaise: split.operatorPayablePaise,
    cancellationPolicy: 'Test policy',
    ...(opts.status === 'CONFIRMED'
      ? { confirmedAt: new Date() }
      : { expiresAt: new Date(Date.now() + 15 * 60_000) }),
  };
}
