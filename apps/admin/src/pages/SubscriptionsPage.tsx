import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AdminPlan,
  type AdminSubscriptionsQuery,
  formatPaise,
  SubscriptionStatusSchema,
} from '@voyago/shared';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '../admin-api';
import { Badge, ErrorText, label, LoadMore, Loading, Section, when } from '../components';
import { useAdmin } from '../use-admin';
import { usePaged } from '../use-paged';

/** Plans (prices for new subscriptions) and members' subscriptions. */
export function SubscriptionsPage() {
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<AdminSubscriptionsQuery>({});
  const plans = useQuery({ queryKey: ['admin', 'plans'], queryFn: () => adminApi.plans() });
  const { rows, query } = usePaged(['admin', 'subscriptions', filters], (cursor) =>
    adminApi.subscriptions({ ...filters, cursor }),
  );
  return (
    <>
      <h1>Subscriptions</h1>
      <p className="muted">
        Explorer Pro and Organiser Pro. A price change applies to new subscriptions only; members
        keep the price they signed up at.
      </p>
      <Section title="Plans">
        <ErrorText error={plans.error} />
        {plans.isPending ? <Loading /> : null}
        <table>
          <thead>
            <tr>
              <th>Plan</th>
              <th>Price</th>
              <th>On sale</th>
              <th>Subscribers</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(plans.data ?? []).map((plan) => (
              <PlanRow key={plan.id} plan={plan} />
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Members">
        <form
          className="filters"
          onSubmit={(event) => {
            event.preventDefault();
            setFilters((f) => ({ ...f, q: search.trim() || undefined }));
          }}
        >
          <input
            type="search"
            aria-label="Search subscriptions"
            placeholder="Username, subscription id or provider id"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select
            aria-label="Subscription status"
            value={filters.status ?? ''}
            onChange={(event) =>
              setFilters((f) => ({
                ...f,
                status: SubscriptionStatusSchema.safeParse(event.target.value).data,
              }))
            }
          >
            <option value="">Any status</option>
            {SubscriptionStatusSchema.options.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        </form>
        <ErrorText error={query.error} />
        {query.isPending ? <Loading /> : null}
        <table>
          <thead>
            <tr>
              <th>Member</th>
              <th>Plan</th>
              <th>Status</th>
              <th>Paid until</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((sub) => (
              <tr key={sub.id}>
                <td>
                  <Link to={`/subscriptions/${sub.id}`}>
                    {sub.user.displayName} (@{sub.user.username})
                  </Link>
                </td>
                <td>
                  {sub.plan.name}
                  <div className="muted">{formatPaise(sub.pricePaise)} a month</div>
                </td>
                <td>
                  <Badge value={sub.status} />
                  {sub.entitled ? null : <div className="muted">No paid features</div>}
                </td>
                <td>{when(sub.currentPeriodEnd)}</td>
                <td>{when(sub.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!query.isPending && rows.length === 0 ? <p className="muted">No subscriptions.</p> : null}
        <LoadMore
          hasMore={query.hasNextPage}
          loading={query.isFetchingNextPage}
          onMore={() => void query.fetchNextPage()}
        />
      </Section>
    </>
  );
}

function PlanRow({ plan }: { plan: AdminPlan }) {
  const { can } = useAdmin();
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [rupees, setRupees] = useState(String(plan.pricePaise / 100));
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: (input: { pricePaise?: number; isActive?: boolean; reason: string }) =>
      adminApi.updatePlan(plan.id, input),
    onSuccess: () => {
      setEditing(false);
      setReason('');
      void client.invalidateQueries({ queryKey: ['admin', 'plans'] });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({ pricePaise: Math.round(Number(rupees) * 100), reason: reason.trim() });
  };
  return (
    <tr>
      <td>
        {plan.name}
        <div className="muted">
          <code>{plan.code}</code>
        </div>
      </td>
      <td>
        {editing ? (
          <form className="reason-form" onSubmit={submit}>
            <label>
              Price in rupees, for new subscriptions
              <input
                type="number"
                min={1}
                step="1"
                value={rupees}
                onChange={(event) => setRupees(event.target.value)}
                required
              />
            </label>
            <label>
              Reason
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Reason (saved in the audit log)"
                minLength={5}
                maxLength={500}
                rows={2}
                required
              />
            </label>
            <div className="row">
              <button type="submit" disabled={save.isPending || reason.trim().length < 5}>
                Save price
              </button>
              <button type="button" className="link" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
            <ErrorText error={save.error} />
          </form>
        ) : (
          <>
            {formatPaise(plan.pricePaise)} a month
            {can('payments.manage') ? (
              <div>
                <button type="button" className="link" onClick={() => setEditing(true)}>
                  Change price
                </button>
              </div>
            ) : null}
          </>
        )}
      </td>
      <td>
        <Badge
          value={plan.isActive ? 'ON_SALE' : 'OFF_SALE'}
          tone={plan.isActive ? 'ok' : 'muted'}
        />
        {can('payments.manage') ? (
          <div>
            <button
              type="button"
              className="link"
              disabled={save.isPending}
              onClick={() =>
                save.mutate({
                  isActive: !plan.isActive,
                  reason: plan.isActive
                    ? 'Taken off sale from the admin app'
                    : 'Put back on sale from the admin app',
                })
              }
            >
              {plan.isActive ? 'Take off sale' : 'Put on sale'}
            </button>
          </div>
        ) : null}
      </td>
      <td>{plan.subscribers}</td>
      <td className="muted">{plan.entitlements.map(label).join(', ')}</td>
    </tr>
  );
}
