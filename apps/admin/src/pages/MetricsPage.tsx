import { useQuery } from '@tanstack/react-query';
import { type BusinessMetrics } from '@voyago/shared';
import { type ReactNode, useState } from 'react';
import { adminApi } from '../admin-api';
import { ErrorText, label, Loading, Section, when } from '../components';

const PERIODS = [7, 30, 90, 365] as const;

const rupees = (paise: number) =>
  (paise / 100).toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  });
const pct = (value: number | null) => (value === null ? 'No data' : `${value.toFixed(1)}%`);
const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** Business metrics from the product's own records (see docs/ANALYTICS.md for definitions). */
export function MetricsPage() {
  const [days, setDays] = useState<number>(30);
  const { data, error, isPending } = useQuery({
    queryKey: ['admin', 'metrics', days],
    queryFn: () => adminApi.metrics(days),
  });

  return (
    <>
      <h1>Metrics</h1>
      <div className="filters">
        <label>
          Period{' '}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {PERIODS.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorText error={error} />
      {isPending ? <Loading /> : null}
      {data ? <MetricsBody data={data} /> : null}
    </>
  );
}

function MetricsBody({ data }: { data: BusinessMetrics }) {
  const { northStar, engagement, growth, trips, money } = data;
  const starPeak = Math.max(1, ...northStar.months.map((m) => m.value));
  const activePeak = Math.max(1, ...engagement.daily.map((d) => d.active));
  return (
    <>
      <p className="muted">
        {data.period.from} to {data.period.to} (India time) · Updated {when(data.generatedAt)}
      </p>

      <Section title="North Star: completed group experiences">
        <p className="muted">{northStar.label}</p>
        <table>
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col">Completed with 2+ people</th>
              <th scope="col" aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {northStar.months.map((m) => (
              <tr key={m.month}>
                <td>{monthName(m.month)}</td>
                <td>{m.value}</td>
                <td aria-hidden="true" style={{ width: '50%' }}>
                  <span className="hbar" style={{ width: `${(m.value / starPeak) * 100}%` }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <h2>Engagement</h2>
      <div className="metrics">
        <Metric title="Daily active" value={engagement.dau}>
          members active today
        </Metric>
        <Metric title="Monthly active" value={engagement.mau}>
          in the last 30 days
        </Metric>
        <Metric title="Stickiness" value={pct(engagement.stickiness)}>
          daily ÷ monthly active
        </Metric>
      </div>
      <Section title="Active members per day">
        <div className="bars" role="img" aria-label="Active members per day">
          {engagement.daily.map((day) => (
            <div key={day.date} className="bar-day" title={`${day.date}: ${day.active} active`}>
              <span
                className="bar bar--users"
                style={{ height: `${(day.active / activePeak) * 100}%` }}
              />
            </div>
          ))}
        </div>
      </Section>

      <h2>Growth</h2>
      <div className="metrics">
        <Metric title="Sign-ups" value={growth.registrations}>
          in the period
        </Metric>
        <Metric title="Sign-up conversion" value={pct(growth.registrationConversion)}>
          asked to join or created a trip within 30 days
        </Metric>
        <Metric title="Profile completion" value={pct(growth.profileCompletion)}>
          of those sign-ups
        </Metric>
        <Metric title="30-day retention" value={pct(growth.retention30)}>
          joined 30–60 days ago, active 30+ days later
        </Metric>
      </div>

      <h2>Trips</h2>
      <div className="metrics">
        <Metric title="Created" value={trips.created}>
          {trips.published} published
        </Metric>
        <Metric title="With join requests" value={pct(trips.withJoinRequests)}>
          of trips published in the period
        </Metric>
        <Metric title="Completion rate" value={pct(trips.completionRate)}>
          of trips that departed and ended
        </Metric>
        <Metric title="Repeat organisers" value={pct(trips.repeatOrganiserRate)}>
          had published before
        </Metric>
      </div>

      <h2>Money</h2>
      <div className="metrics">
        <Metric title="GMV" value={rupees(money.gmvPaise)}>
          confirmed bookings, before refunds
        </Metric>
        <Metric title="Commission" value={rupees(money.commissionPaise)}>
          net of reversals, before tax
        </Metric>
        <Metric title="Subscription MRR" value={rupees(money.mrrPaise)}>
          plans that will renew
        </Metric>
        <Metric title="Subscription revenue" value={rupees(money.subscriptionRevenuePaise)}>
          in the period, net of refunds
        </Metric>
        <Metric title="Contribution margin" value={rupees(money.contributionMarginPaise)}>
          after {rupees(money.providerFeesPaise)} payment fees
        </Metric>
        <Metric title="Refund rate" value={pct(money.refundRate)}>
          of captured money
        </Metric>
        <Metric title="Payment success" value={pct(money.paymentSuccessRate)}>
          of payment attempts
        </Metric>
      </div>

      <Section title="Events recorded">
        {data.events.length === 0 ? (
          <p className="muted">No events in this period.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Count</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((e) => (
                <tr key={e.name}>
                  <td>{label(e.name)}</td>
                  <td>{e.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}

function Metric({
  title,
  value,
  children,
}: {
  title: string;
  value: number | string;
  children: ReactNode;
}) {
  return (
    <div className="card metric">
      <div className="muted">{title}</div>
      <div className="metric-value">{value}</div>
      <div className="metric-note">{children}</div>
    </div>
  );
}
