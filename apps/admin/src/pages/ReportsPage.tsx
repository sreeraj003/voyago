import {
  type AdminReportsQuery,
  type AdminReportSummary,
  ReportSeveritySchema,
  ReportTargetTypeSchema,
} from '@voyago/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '../admin-api';
import { Badge, ErrorText, label, LoadMore, Loading, Person, when } from '../components';
import { useAdmin } from '../use-admin';
import { usePaged } from '../use-paged';

const STATUSES = ['QUEUE', 'OPEN', 'IN_REVIEW', 'ACTIONED', 'DISMISSED', 'ALL'] as const;

export function ReportsPage() {
  const { can } = useAdmin();
  const [filters, setFilters] = useState<AdminReportsQuery>({ status: 'QUEUE' });
  const { rows, query } = usePaged(['admin', 'reports', filters], (cursor) =>
    adminApi.reports({ ...filters, cursor }),
  );
  return (
    <>
      <h1>Reports</h1>
      <div className="filters">
        <div className="tabs" role="tablist" aria-label="Report status">
          {STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              role="tab"
              aria-selected={filters.status === status}
              className={filters.status === status ? 'tab tab--active' : 'tab'}
              onClick={() => setFilters((f) => ({ ...f, status }))}
            >
              {status === 'QUEUE' ? 'Queue' : label(status)}
            </button>
          ))}
        </div>
        <select
          aria-label="Severity"
          value={filters.severity ?? ''}
          onChange={(event) =>
            setFilters((f) => ({
              ...f,
              severity: ReportSeveritySchema.safeParse(event.target.value).data,
            }))
          }
        >
          <option value="">Any severity</option>
          {ReportSeveritySchema.options.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </select>
        <select
          aria-label="Reported thing"
          value={filters.targetType ?? ''}
          onChange={(event) =>
            setFilters((f) => ({
              ...f,
              targetType: ReportTargetTypeSchema.safeParse(event.target.value).data,
            }))
          }
        >
          <option value="">Anything</option>
          {ReportTargetTypeSchema.options.map((t) => (
            <option key={t} value={t}>
              {label(t)}
            </option>
          ))}
        </select>
        {can('reports.manage') ? (
          <select
            aria-label="Assignment"
            value={filters.assigned ?? ''}
            onChange={(event) =>
              setFilters((f) => ({
                ...f,
                assigned:
                  event.target.value === 'me' || event.target.value === 'unassigned'
                    ? event.target.value
                    : undefined,
              }))
            }
          >
            <option value="">Anyone</option>
            <option value="me">Assigned to me</option>
            <option value="unassigned">Unassigned</option>
          </select>
        ) : null}
      </div>
      <ErrorText error={query.error} />
      {query.isPending ? <Loading /> : <ReportTable reports={rows} />}
      <LoadMore
        hasMore={query.hasNextPage}
        loading={query.isFetchingNextPage}
        onMore={() => void query.fetchNextPage()}
      />
    </>
  );
}

export function ReportTable({ reports }: { reports: AdminReportSummary[] }) {
  if (reports.length === 0) return <p className="muted">No reports.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Severity</th>
          <th>Reported</th>
          <th>Reason</th>
          <th>Status</th>
          <th>Reporter</th>
          <th>Assigned</th>
          <th>Filed</th>
        </tr>
      </thead>
      <tbody>
        {reports.map((report) => (
          <tr key={report.id}>
            <td>
              <Badge value={report.severity} />
            </td>
            <td>
              <Link to={`/reports/${report.id}`}>{report.targetLabel}</Link>
              <div className="muted">{label(report.targetType)}</div>
            </td>
            <td>{label(report.reason)}</td>
            <td>
              <Badge value={report.status} />
            </td>
            <td>
              <Person person={report.reporter} />
            </td>
            <td>{report.assignedTo ? <Person person={report.assignedTo} /> : 'Nobody'}</td>
            <td>{when(report.createdAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
