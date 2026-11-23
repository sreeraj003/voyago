import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AdminBookingDetail,
  describeRefundTiers,
  formatPaise,
  type ReconcileResult,
} from '@voyago/shared';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { adminApi } from '../admin-api';
import {
  Badge,
  ErrorText,
  Field,
  label,
  Loading,
  ReasonAction,
  Section,
  when,
} from '../components';
import { useAdmin } from '../use-admin';

const bps = (value: number) => `${value / 100}%`;

export function BookingDetailPage() {
  const { id = '' } = useParams();
  const client = useQueryClient();
  const { can } = useAdmin();
  const key = ['admin', 'booking', id];
  const {
    data: booking,
    error,
    isPending,
  } = useQuery({
    queryKey: key,
    queryFn: () => adminApi.booking(id),
  });
  const [found, setFound] = useState<ReconcileResult['summary'] | null>(null);
  const update = (next: AdminBookingDetail) => {
    client.setQueryData(key, next);
    void client.invalidateQueries({ queryKey: ['admin', 'bookings'] });
  };
  const reconcile = useMutation({
    mutationFn: () => adminApi.reconcileBooking(id),
    onSuccess: (result) => {
      setFound(result.summary);
      update(result.booking);
    },
  });
  const retry = useMutation({
    mutationFn: (refundId: string) => adminApi.retryRefund(refundId),
    onSuccess: update,
  });
  if (isPending) return <Loading />;
  if (!booking) return <ErrorText error={error} />;
  const manage = can('payments.manage');
  const left =
    (booking.payments.find((p) => p.capturedAt)?.amountPaise ?? 0) -
    booking.refunds.filter((r) => r.status !== 'FAILED').reduce((s, r) => s + r.amountPaise, 0);

  return (
    <>
      <h1>{booking.package.title}</h1>
      <div className="row">
        <Badge value={booking.status} />
        {booking.needsAttention ? <Badge value="NEEDS_ATTENTION" tone="bad" /> : null}
      </div>
      <Section title="Booking">
        <dl className="fields">
          <Field name="Customer">
            <Link to={`/users/${booking.customer.id}`}>
              {booking.customer.displayName} (@{booking.customer.username})
            </Link>
          </Field>
          <Field name="Business">
            <Link to={`/operators/${booking.operator.id}`}>{booking.operator.displayName}</Link>
          </Field>
          <Field name="Places">
            {booking.seats} × {formatPaise(booking.unitPricePaise)}
          </Field>
          <Field name="Total">{formatPaise(booking.totalAmountPaise)}</Field>
          <Field name="Commission">
            {formatPaise(booking.commissionPaise)} ({bps(booking.commissionBps)}) + tax{' '}
            {formatPaise(booking.commissionTaxPaise)} ({bps(booking.commissionTaxBps)})
          </Field>
          <Field name="Owed to the business">{formatPaise(booking.operatorPayablePaise)}</Field>
          <Field name="Refunded">{formatPaise(booking.refundedAmountPaise)}</Field>
          <Field name="Refund schedule">{describeRefundTiers(booking.refundTiers)}</Field>
          <Field name="Made">{when(booking.createdAt)}</Field>
          {booking.expiresAt ? <Field name="Hold ends">{when(booking.expiresAt)}</Field> : null}
          <Field name="Confirmed">{when(booking.confirmedAt)}</Field>
          {booking.cancelledAt ? (
            <Field name="Cancelled">
              {when(booking.cancelledAt)} by {label(booking.cancelledBy ?? 'SYSTEM')}
              {booking.cancellationReason ? `: ${booking.cancellationReason}` : ''}
            </Field>
          ) : null}
        </dl>
        {manage ? (
          <div className="row">
            {booking.actions.includes('reconcile') ? (
              <button
                type="button"
                onClick={() => reconcile.mutate()}
                disabled={reconcile.isPending}
              >
                Check with the provider
              </button>
            ) : null}
          </div>
        ) : null}
        <ErrorText error={reconcile.error} />
        {found ? (
          <p className="notice" role="status">
            Checked: {found.payments.length} payment(s) {found.payments.join(', ') || ''};{' '}
            {found.refunds.length} pending refund(s) {found.refunds.join(', ')}
            {found.expired ? '; the hold has lapsed' : ''}.
          </p>
        ) : null}
      </Section>

      <Section title="Payments">
        {booking.payments.length === 0 ? (
          <p className="muted">No payments.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Provider ids</th>
                <th>Status</th>
                <th>Amount</th>
                <th>Provider fee</th>
                <th>Captured</th>
              </tr>
            </thead>
            <tbody>
              {booking.payments.map((p) => (
                <tr key={p.id}>
                  <td>
                    <code>{p.providerOrderId ?? 'No order'}</code>
                    <div className="muted">
                      <code>{p.providerPaymentId ?? 'Not paid'}</code>{' '}
                      {p.method ? `· ${p.method}` : ''}
                    </div>
                    {p.failureReason ? <div className="error">{p.failureReason}</div> : null}
                  </td>
                  <td>
                    <Badge value={p.status} />
                  </td>
                  <td>
                    {formatPaise(p.amountPaise)}
                    {p.refundedAmountPaise > 0 ? (
                      <div className="muted">{formatPaise(p.refundedAmountPaise)} refunded</div>
                    ) : null}
                  </td>
                  <td>
                    {p.providerFeePaise === null ? 'Not known' : formatPaise(p.providerFeePaise)}
                  </td>
                  <td>{when(p.capturedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Refunds">
        {booking.refunds.length === 0 ? (
          <p className="muted">No refunds.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Amount</th>
                <th>Status</th>
                <th>Why</th>
                <th>Requested</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {booking.refunds.map((r) => (
                <tr key={r.id}>
                  <td>
                    {formatPaise(r.amountPaise)}
                    {r.refundPercent !== null ? (
                      <div className="muted">{r.refundPercent}% by schedule</div>
                    ) : null}
                  </td>
                  <td>
                    <Badge value={r.status} />
                    {r.failureReason ? <div className="error">{r.failureReason}</div> : null}
                  </td>
                  <td>
                    {label(r.initiator)}
                    {r.reason ? <div className="muted">{r.reason}</div> : null}
                  </td>
                  <td>
                    {when(r.createdAt)}
                    {r.providerRefundId ? (
                      <div className="muted">
                        <code>{r.providerRefundId}</code>
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {manage && r.status === 'FAILED' ? (
                      <button
                        type="button"
                        onClick={() => retry.mutate(r.id)}
                        disabled={retry.isPending}
                      >
                        Retry
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <ErrorText error={retry.error} />
        {manage && booking.actions.includes('refund') ? (
          <RefundForms booking={booking} left={left} onDone={update} />
        ) : null}
      </Section>

      <Section title="Ledger">
        {booking.ledger.length === 0 ? (
          <p className="muted">
            Nothing recorded yet. Lines are added when money is captured or refunded.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Line</th>
                <th>Amount</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {booking.ledger.map((l) => (
                <tr key={l.id}>
                  <td>{label(l.kind)}</td>
                  <td>{formatPaise(l.amountPaise)}</td>
                  <td>{when(l.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Provider events">
        {booking.events.length === 0 ? (
          <p className="muted">No events.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Result</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {booking.events.map((e) => (
                <tr key={e.id}>
                  <td>
                    <code>{e.eventType}</code>
                    {!e.signatureValid ? <Badge value="BAD_SIGNATURE" tone="bad" /> : null}
                  </td>
                  <td>{e.result ?? 'Not applied yet'}</td>
                  <td>{when(e.receivedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}

function RefundForms({
  booking,
  left,
  onDone,
}: {
  booking: AdminBookingDetail;
  left: number;
  onDone: (next: AdminBookingDetail) => void;
}) {
  const [rupees, setRupees] = useState('');
  const [reason, setReason] = useState('');
  const partial = useMutation({
    mutationFn: (input: { amountPaise: number; reason: string }) =>
      adminApi.refundBooking(booking.id, input),
    onSuccess: (next) => {
      setRupees('');
      setReason('');
      onDone(next);
    },
  });
  const paise = Math.round(Number(rupees) * 100);
  const valid = Number.isFinite(paise) && paise > 0 && paise <= left && reason.trim().length >= 5;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) partial.mutate({ amountPaise: paise, reason: reason.trim() });
  };
  return (
    <div className="stack">
      <p className="muted">Up to {formatPaise(left)} can still be refunded.</p>
      <form className="reason-form" onSubmit={submit}>
        <label>
          Goodwill refund (the booking stands), in rupees
          <input
            inputMode="decimal"
            value={rupees}
            onChange={(event) => setRupees(event.target.value)}
            placeholder="500"
          />
        </label>
        <label>
          Reason
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason (saved in the audit log)"
            maxLength={500}
            rows={2}
          />
        </label>
        <ErrorText error={partial.error} />
        <button type="submit" className="primary" disabled={!valid || partial.isPending}>
          Refund {valid ? formatPaise(paise) : ''}
        </button>
      </form>
      <ReasonAction
        title={`Refund everything left (${formatPaise(left)})`}
        confirm="Refund and cancel"
        danger
        onSubmit={async (why) => onDone(await adminApi.refundBooking(booking.id, { reason: why }))}
      />
    </div>
  );
}
