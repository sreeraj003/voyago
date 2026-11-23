import {
  type Booking,
  BookingSchema,
  type OperatorBooking,
  OperatorBookingSchema,
  type OperatorBookingsQuery,
  pageEnvelope,
  type PageResponse,
} from '@voyago/shared';
import { z } from 'zod';
import { apiRequest } from './http';

const BookingPage = pageEnvelope(BookingSchema);
const OperatorBookingPage = pageEnvelope(OperatorBookingSchema);

const qs = (query: Record<string, unknown>) => {
  const parts = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
};

/** Holds places and starts paying. Send a fresh key per attempt; a retry with it is safe. */
export const createBooking = (
  packageId: string,
  input: { seats: number; idempotencyKey: string; returnUrl?: string },
): Promise<Booking> =>
  apiRequest(`/packages/${packageId}/bookings`, {
    method: 'POST',
    body: input,
    schema: BookingSchema,
  });

export const getBooking = (id: string, returnUrl?: string): Promise<Booking> =>
  apiRequest(`/bookings/${id}${qs({ returnUrl })}`, { schema: BookingSchema });

export const listMyBookings = async (cursor?: string): Promise<PageResponse<Booking>> =>
  BookingPage.parse(
    await apiRequest(`/me/bookings${qs({ limit: 20, cursor })}`, {
      schema: z.unknown(),
      raw: true,
    }),
  );

export const cancelBooking = (id: string, reason?: string): Promise<Booking> =>
  apiRequest(`/bookings/${id}/cancel`, {
    method: 'POST',
    body: reason?.trim() ? { reason: reason.trim() } : {},
    schema: BookingSchema,
  });

export const listOperatorBookings = async (
  query: OperatorBookingsQuery = {},
): Promise<PageResponse<OperatorBooking>> =>
  OperatorBookingPage.parse(
    await apiRequest(`/me/operator/bookings${qs({ limit: 20, ...query })}`, {
      schema: z.unknown(),
      raw: true,
    }),
  );

export const operatorCancelBooking = (id: string, reason: string): Promise<void> =>
  apiRequest(`/me/operator/bookings/${id}/cancel`, { method: 'POST', body: { reason } });
