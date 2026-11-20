import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { adminApi } from '../admin-api';
import { ErrorText, Loading, Section, when } from '../components';
import { HealthPanel } from '../HealthPanel';
import { useAdmin } from '../use-admin';

export function DashboardPage() {
  const { can } = useAdmin();
  const { data, error, isPending } = useQuery({
    queryKey: ['admin', 'dashboard'],
    queryFn: adminApi.dashboard,
    refetchInterval: 60_000,
  });
  const peak = Math.max(
    1,
    ...(data?.daily.map((d) => Math.max(d.registrations, d.tripsCreated)) ?? []),
  );

  return (
    <>
      <h1>Overview</h1>
      <ErrorText error={error} />
      {isPending ? <Loading /> : null}
      {data ? (
        <>
          <div className="metrics">
            <Metric title="Members" value={data.users.total}>
              {data.users.registeredLast7Days} new this week, {data.users.registeredLast30Days} in
              30 days
            </Metric>
            <Metric title="Active members" value={data.users.activeLast7Days}>
              in the last 7 days ({data.users.activeLast30Days} in 30 days)
            </Metric>
            <Metric title="Trips created" value={data.trips.createdLast30Days}>
              last 30 days, {data.trips.upcoming} upcoming
            </Metric>
            <Metric title="Trips completed" value={data.trips.completedLast30Days}>
              last 30 days
            </Metric>
            <Metric
              title="Reports awaiting review"
              value={data.reports.open + data.reports.inReview}
            >
              {data.reports.urgent} high or critical
              {can('reports.read') ? (
                <>
                  {' · '}
                  <Link to="/reports">Open queue</Link>
                </>
              ) : null}
            </Metric>
            <Metric title="Operators to verify" value={data.operators.pendingVerification}>
              {can('operators.read') ? (
                <Link to="/operators?status=PENDING">Review queue</Link>
              ) : (
                'pending'
              )}
            </Metric>
            <Metric title="Suspended accounts" value={data.users.suspended}>
              {data.trips.hidden} hidden trips
            </Metric>
            <Metric title="Bookings and payments" value="Later">
              Available once bookings launch
            </Metric>
          </div>
          <Section title="Last 14 days">
            <div className="bars" role="img" aria-label="Sign-ups and trips created per day">
              {data.daily.map((day) => (
                <div
                  key={day.date}
                  className="bar-day"
                  title={`${day.date}: ${day.registrations} sign-ups, ${day.tripsCreated} trips`}
                >
                  <span
                    className="bar bar--users"
                    style={{ height: `${(day.registrations / peak) * 100}%` }}
                  />
                  <span
                    className="bar bar--trips"
                    style={{ height: `${(day.tripsCreated / peak) * 100}%` }}
                  />
                </div>
              ))}
            </div>
            <p className="muted legend">
              <span className="dot dot--users" /> Sign-ups <span className="dot dot--trips" /> Trips
              created · Updated {when(data.generatedAt)}
            </p>
          </Section>
        </>
      ) : null}
      <HealthPanel />
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
  children: React.ReactNode;
}) {
  return (
    <div className="card metric">
      <div className="muted">{title}</div>
      <div className="metric-value">{value}</div>
      <div className="metric-note">{children}</div>
    </div>
  );
}
