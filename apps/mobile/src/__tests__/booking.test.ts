import { type Booking } from '@voyago/shared';
import {
  bookingNote,
  checkoutOutcome,
  clampSeats,
  maxSeats,
  priceLine,
} from '../commercial/booking';

const base: Booking = {
  id: '00000000-0000-4000-8000-000000000001',
  status: 'PENDING_PAYMENT',
  seats: 2,
  unitPricePaise: 349_900,
  totalAmountPaise: 699_800,
  refundedAmountPaise: 0,
  currency: 'INR',
  createdAt: '2026-11-23T00:00:00.000Z',
  expiresAt: '2026-11-23T00:15:00.000Z',
  confirmedAt: null,
  cancelledAt: null,
  cancelledBy: null,
  cancellationReason: null,
  cancellationPolicy: 'Full refund up to 7 days before.',
  refundTiers: [{ hoursBefore: 168, refundPercent: 100 }],
  package: {
    id: '00000000-0000-4000-8000-000000000002',
    title: 'Kudremukh trek',
    destinationName: 'Kudremukh',
    startsAt: null,
    endsAt: null,
    operator: { slug: 'ghats', displayName: 'Ghats Treks' },
    meetingPoint: null,
  },
  payment: { status: 'CREATED', failureReason: null },
  refunds: [],
  cancellation: { refundPercent: 0, refundPaise: 0 },
  checkoutUrl: 'http://localhost:3000/api/v1/checkout/x',
  actions: ['pay', 'cancel'],
};

describe('booking helpers', () => {
  it('limits places to what is left and the per-booking cap', () => {
    expect(maxSeats(3)).toBe(3);
    expect(maxSeats(40)).toBe(10);
    expect(maxSeats(0)).toBe(0);
    expect(clampSeats(0, 5)).toBe(1);
    expect(clampSeats(7, 5)).toBe(5);
    expect(clampSeats(12, 40)).toBe(10);
  });

  it('previews the total in rupees', () => {
    expect(priceLine(1, 349_900)).toBe('₹3,499');
    expect(priceLine(2, 349_900)).toBe('2 × ₹3,499 = ₹6,998');
  });

  it('reads what the payment page sent back', () => {
    expect(checkoutOutcome('voyago://bookings?booking=abc&payment=paid')).toEqual({
      bookingId: 'abc',
      payment: 'paid',
    });
    expect(checkoutOutcome('voyago://bookings')).toEqual({ bookingId: null, payment: null });
  });

  it('explains each state', () => {
    const now = Date.parse('2026-11-23T00:05:00.000Z');
    expect(bookingNote(base, now)).toBe('Places are held for 10 more min while you pay.');
    expect(
      bookingNote({ ...base, payment: { status: 'FAILED', failureReason: 'Declined' } }, now),
    ).toContain('did not go through: Declined');
    expect(bookingNote({ ...base, status: 'REFUNDED', refundedAmountPaise: 699_800 })).toContain(
      '₹6,998 was refunded',
    );
    expect(
      bookingNote({
        ...base,
        status: 'CANCELLED',
        refunds: [
          {
            id: base.id,
            amountPaise: 1,
            status: 'PENDING',
            initiator: 'CUSTOMER',
            refundPercent: 100,
            createdAt: base.createdAt,
            processedAt: null,
          },
        ],
      }),
    ).toBe('Cancelled. Your refund is on its way.');
    expect(bookingNote({ ...base, status: 'EXPIRED' })).toContain('Nothing was charged');
  });
});
