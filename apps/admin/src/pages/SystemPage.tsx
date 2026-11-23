import { useQuery } from '@tanstack/react-query';
import { MODERATION_SLA_HOURS, type SystemStatus } from '@voyago/shared';
import { Link } from 'react-router-dom';
import { adminApi } from '../admin-api';
import { Badge, ErrorText, Loading, Section, when } from '../components';
import { useAdmin } from '../use-admin';

const ms = (value: number | null) => (value === null ? 'No data' : `${Math.round(value)} ms`);
const uptime = (seconds: number) => {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
};

/** Live operational status: dependencies, latency, background jobs, payments, moderation. */
export function SystemPage() {
  const { data, error, isPending } = useQuery({
    queryKey: ['admin', 'system'],
    queryFn: adminApi.system,
    refetchInterval: 30_000,
  });
  return (
    <>
      <h1>System</h1>
      <ErrorText error={error} />
      {isPending ? <Loading /> : null}
      {data ? <SystemBody data={data} /> : null}
    </>
  );
}

function SystemBody({ data }: { data: SystemStatus }) {
  const { can } = useAdmin();
  const errorRate =
    data.http.requests > 0 ? (data.http.serverErrors / data.http.requests) * 100 : 0;
  const unhealthyJobs = data.jobs.filter((j) => !j.healthy).length;
  const paymentIssues =
    data.payments.stuckWebhooks + data.payments.failedRefunds + data.payments.amountMismatches;
  return (
    <>
      <p className="muted">
        Version {data.version} · up {uptime(data.uptimeSeconds)} · Updated {when(data.generatedAt)}
      </p>

      <div className="metrics">
        {data.dependencies.map((d) => (
          <div key={d.name} className="card metric">
            <div className="muted">{d.name}</div>
            <div className={`metric-value status--${d.up ? 'up' : 'down'}`}>
              {d.up ? 'Up' : 'Down'}
            </div>
            <div className="metric-note">{ms(d.latencyMs)}</div>
          </div>
        ))}
        <div className="card metric">
          <div className="muted">Server errors</div>
          <div className={`metric-value status--${errorRate > 1 ? 'down' : 'up'}`}>
            {errorRate.toFixed(2)}%
          </div>
          <div className="metric-note">
            {data.http.serverErrors} of {data.http.requests} requests since start
          </div>
        </div>
        <div className="card metric">
          <div className="muted">Latency</div>
          <div className="metric-value">{ms(data.http.p95Ms)}</div>
          <div className="metric-note">p95 · p50 {ms(data.http.p50Ms)}</div>
        </div>
        <div className="card metric">
          <div className="muted">App crashes</div>
          <div className="metric-value">{data.clientErrors24h}</div>
          <div className="metric-note">reports in 24 hours</div>
        </div>
      </div>

      <Section
        title={`Background jobs${unhealthyJobs > 0 ? ` (${unhealthyJobs} need attention)` : ''}`}
      >
        <table>
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">Status</th>
              <th scope="col">Every</th>
              <th scope="col">Last success</th>
              <th scope="col">Runs / failures</th>
              <th scope="col">Last error</th>
            </tr>
          </thead>
          <tbody>
            {data.jobs.map((job) => (
              <tr key={job.name}>
                <td>
                  <strong>{job.name}</strong>
                  <div className="muted">{job.description}</div>
                </td>
                <td>
                  <Badge
                    value={job.healthy ? 'HEALTHY' : 'FAILING'}
                    tone={job.healthy ? 'ok' : 'bad'}
                  />
                </td>
                <td>{job.intervalSeconds > 0 ? `${job.intervalSeconds}s` : 'Not scheduled'}</td>
                <td>{when(job.lastSuccessAt)}</td>
                <td>
                  {job.runs} / {job.failures}
                  {job.consecutiveFailures > 0 ? ` (${job.consecutiveFailures} in a row)` : ''}
                </td>
                <td>
                  {job.lastError ? (
                    <>
                      {job.lastError}
                      <div className="muted">{when(job.lastErrorAt)}</div>
                    </>
                  ) : (
                    <span className="muted">None</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title={`Payments${paymentIssues > 0 ? ' (needs attention)' : ''}`}>
        <dl className="fields">
          <Item name="Webhooks not applied after 10 minutes" value={data.payments.stuckWebhooks} />
          <Item
            name="Bad webhook signatures (24 hours)"
            value={data.payments.invalidSignatures24h}
          />
          <Item name="Refunds that failed" value={data.payments.failedRefunds} />
          <Item name="Amount mismatches" value={data.payments.amountMismatches} />
        </dl>
        {can('payments.read') ? (
          <p>
            <Link to="/bookings">Open payments</Link>
          </p>
        ) : null}
      </Section>

      <Section title="Moderation">
        <dl className="fields">
          <Item name="Open reports" value={data.moderation.open} />
          <Item name="Past their response target" value={data.moderation.overdue} />
          <Item
            name="Oldest open"
            value={
              data.moderation.oldestOpenHours === null
                ? 'None'
                : `${Math.round(data.moderation.oldestOpenHours)} hours`
            }
          />
        </dl>
        <p className="muted">
          Response targets: critical {MODERATION_SLA_HOURS.CRITICAL}h, high{' '}
          {MODERATION_SLA_HOURS.HIGH}h, medium {MODERATION_SLA_HOURS.MEDIUM}h, low{' '}
          {MODERATION_SLA_HOURS.LOW}h.
          {can('reports.read') ? (
            <>
              {' '}
              <Link to="/reports">Open queue</Link>
            </>
          ) : null}
        </p>
      </Section>
    </>
  );
}

function Item({ name, value }: { name: string; value: number | string }) {
  const bad = typeof value === 'number' && value > 0;
  return (
    <div className="field">
      <dt>{name}</dt>
      <dd className={bad ? 'status--down' : undefined}>{value}</dd>
    </div>
  );
}
