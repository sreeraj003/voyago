import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type AdminSubscription, formatPaise } from '@voyago/shared';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { adminApi } from '../admin-api';
import { Badge, ErrorText, Field, Loading, ReasonAction, Section, when } from '../components';
import { useAdmin } from '../use-admin';

export function SubscriptionDetailPage() {
  const { id = '' } = useParams();
  const client = useQueryClient();
  const { can } = useAdmin();
  const key = ['admin', 'subscription', id];
  const {
    data: sub,
    error,
    isPending,
  } = useQuery({
    queryKey: key,
    queryFn: () => adminApi.subscription(id),
  });
  const [checked, setChecked] = useState<string | null>(null);
  const update = (next: AdminSubscription) => {
    client.setQueryData(key, next);
    void client.invalidateQueries({ queryKey: ['admin', 'subscriptions'] });
  };
  const reconcile = useMutation({
    mutationFn: () => adminApi.reconcileSubscription(id),
    onSuccess: (result) => {
      setChecked(result.result);
      update(result.subscription);
    },
  });
  if (isPending) return <Loading />;
  if (!sub) return <ErrorText error={error} />;
  const manage = can('payments.manage');
  const last = sub.payments.find(
    (p) =>
      (p.status === 'CAPTURED' || p.status === 'PARTIALLY_REFUNDED') &&
      p.refundedAmountPaise < p.amountPaise,
  );

  return (
    <>
      <h1>
        {sub.plan.name} for {sub.user.displayName}
      </h1>
      <div className="row">
        <Badge value={sub.status} />
        <Badge
          value={sub.entitled ? 'PAID_FEATURES_ON' : 'PAID_FEATURES_OFF'}
          tone={sub.entitled ? 'ok' : 'muted'}
        />
      </div>
      <Section title="Subscription">
        <dl className="fields">
          <Field name="Member">
            <Link to={`/users/${sub.user.id}`}>
              {sub.user.displayName} (@{sub.user.username})
            </Link>
          </Field>
          <Field name="Price">{formatPaise(sub.pricePaise)} a month</Field>
          <Field name="Paid period">
            {sub.currentPeriodStart
              ? `${when(sub.currentPeriodStart)} to ${when(sub.currentPeriodEnd)}`
              : 'Not paid yet'}
          </Field>
          <Field name="Renews">{sub.renewsAt ? when(sub.renewsAt) : 'No'}</Field>
          {sub.cancelledAt ? (
            <Field name="Cancelled">
              {when(sub.cancelledAt)}
              {sub.cancellationReason ? `: ${sub.cancellationReason}` : ''}
            </Field>
          ) : null}
          <Field name="Provider">
            {sub.provider ?? 'None'} <code>{sub.providerSubscriptionId ?? ''}</code>
          </Field>
          <Field name="Started">{when(sub.createdAt)}</Field>
        </dl>
        {manage ? (
          <div className="row">
            {sub.actions.includes('reconcile') ? (
              <button
                type="button"
                onClick={() => reconcile.mutate()}
                disabled={reconcile.isPending}
              >
                Check with the provider
              </button>
            ) : null}
            {sub.actions.includes('cancel_now') ? (
              <ReasonAction
                title="End now"
                danger
                onSubmit={async (reason) =>
                  update(await adminApi.endSubscription(id, { refundLast: false, reason }))
                }
              />
            ) : null}
            {sub.actions.includes('refund_last') && last ? (
              <ReasonAction
                title={`End now and refund ${formatPaise(last.amountPaise - last.refundedAmountPaise)}`}
                danger
                onSubmit={async (reason) =>
                  update(await adminApi.endSubscription(id, { refundLast: true, reason }))
                }
              />
            ) : null}
          </div>
        ) : null}
        <ErrorText error={reconcile.error} />
        {checked ? (
          <p className="notice" role="status">
            Checked with the provider: {checked}.
          </p>
        ) : null}
      </Section>

      <Section title="Payments">
        {sub.payments.length === 0 ? (
          <p className="muted">No payments.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Amount</th>
                <th>Refunded</th>
                <th>Made</th>
              </tr>
            </thead>
            <tbody>
              {sub.payments.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Badge value={p.status} />
                    {p.failureReason ? <div className="error">{p.failureReason}</div> : null}
                  </td>
                  <td>{formatPaise(p.amountPaise)}</td>
                  <td>{p.refundedAmountPaise > 0 ? formatPaise(p.refundedAmountPaise) : 'None'}</td>
                  <td>{when(p.capturedAt ?? p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}
