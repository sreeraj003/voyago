import { type AdminBookingsQuery, BookingStatusSchema, formatPaise } from '@voyago/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '../admin-api';
import { Badge, ErrorText, label, LoadMore, Loading, when } from '../components';
import { usePaged } from '../use-paged';

export function BookingsPage() {
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<AdminBookingsQuery>({});
  const { rows, query } = usePaged(['admin', 'bookings', filters], (cursor) =>
    adminApi.bookings({ ...filters, cursor }),
  );
  return (
    <>
      <h1>Payments</h1>
      <p className="muted">
        Bookings for paid experiences. A booking is confirmed only from the payment provider&apos;s
        own record. Card details never reach Voyago.
      </p>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters((f) => ({ ...f, q: search.trim() || undefined }));
        }}
      >
        <input
          type="search"
          aria-label="Search bookings"
          placeholder="Username, package, booking id or provider id"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          aria-label="Booking status"
          value={filters.status ?? ''}
          onChange={(event) =>
            setFilters((f) => ({
              ...f,
              status: BookingStatusSchema.safeParse(event.target.value).data,
            }))
          }
        >
          <option value="">Any status</option>
          {BookingStatusSchema.options.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </select>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={filters.attention === 'true'}
            onChange={(event) =>
              setFilters((f) => ({ ...f, attention: event.target.checked ? 'true' : undefined }))
            }
          />
          Needs attention
        </label>
      </form>
      <ErrorText error={query.error} />
      {query.isPending ? <Loading /> : null}
      <table>
        <thead>
          <tr>
            <th>Booking</th>
            <th>Status</th>
            <th>Customer</th>
            <th>Amount</th>
            <th>Payment</th>
            <th>Made</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((booking) => (
            <tr key={booking.id}>
              <td>
                <Link to={`/bookings/${booking.id}`}>{booking.package.title}</Link>
                <div className="muted">{booking.operator.displayName}</div>
                {booking.needsAttention ? <Badge value="NEEDS_ATTENTION" tone="bad" /> : null}
              </td>
              <td>
                <Badge value={booking.status} />
              </td>
              <td>
                <Link to={`/users/${booking.customer.id}`}>
                  {booking.customer.displayName} (@{booking.customer.username})
                </Link>
              </td>
              <td>
                {formatPaise(booking.totalAmountPaise)}
                {booking.refundedAmountPaise > 0 ? (
                  <div className="muted">{formatPaise(booking.refundedAmountPaise)} refunded</div>
                ) : null}
              </td>
              <td>{booking.paymentStatus ? <Badge value={booking.paymentStatus} /> : 'None'}</td>
              <td>{when(booking.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!query.isPending && rows.length === 0 ? <p className="muted">No bookings.</p> : null}
      <LoadMore
        hasMore={query.hasNextPage}
        loading={query.isFetchingNextPage}
        onMore={() => void query.fetchNextPage()}
      />
    </>
  );
}
