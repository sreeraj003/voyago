import { type AdminTripsQuery } from '@voyago/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '../admin-api';
import { Badge, ErrorText, label, LoadMore, Loading, Person, when } from '../components';
import { usePaged } from '../use-paged';

const STATUSES = [
  'DRAFT',
  'PUBLISHED',
  'FULL',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
] as const;

export function TripsPage() {
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<AdminTripsQuery>({});
  const { rows, query } = usePaged(['admin', 'trips', filters], (cursor) =>
    adminApi.trips({ ...filters, cursor }),
  );
  return (
    <>
      <h1>Trips</h1>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters((f) => ({ ...f, q: search.trim() || undefined }));
        }}
      >
        <input
          type="search"
          aria-label="Search trips"
          placeholder="Title, place or trip id"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          aria-label="Status"
          value={filters.status ?? ''}
          onChange={(event) =>
            setFilters((f) => ({
              ...f,
              status: STATUSES.find((s) => s === event.target.value),
            }))
          }
        >
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </select>
        <label className="check">
          <input
            type="checkbox"
            checked={filters.reported === 'true'}
            onChange={(event) =>
              setFilters((f) => ({ ...f, reported: event.target.checked ? 'true' : undefined }))
            }
          />{' '}
          Open reports
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={filters.hidden === 'true'}
            onChange={(event) =>
              setFilters((f) => ({ ...f, hidden: event.target.checked ? 'true' : undefined }))
            }
          />{' '}
          Hidden
        </label>
        <button type="submit" className="primary">
          Search
        </button>
      </form>
      <ErrorText error={query.error} />
      {query.isPending ? <Loading /> : null}
      <table>
        <thead>
          <tr>
            <th>Trip</th>
            <th>Status</th>
            <th>Organiser</th>
            <th>Departs</th>
            <th>Open reports</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((trip) => (
            <tr key={trip.id}>
              <td>
                <Link to={`/trips/${trip.id}`}>{trip.title}</Link>
                <div className="muted">
                  {trip.originName} to {trip.destinationName}
                </div>
              </td>
              <td>
                <Badge value={trip.status} /> {trip.hidden ? <Badge value="HIDDEN" /> : null}
              </td>
              <td>
                <Person person={trip.organiser} />
              </td>
              <td>{when(trip.departureAt)}</td>
              <td>{trip.openReports}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!query.isPending && rows.length === 0 ? <p className="muted">No trips found.</p> : null}
      <LoadMore
        hasMore={query.hasNextPage}
        loading={query.isFetchingNextPage}
        onMore={() => void query.fetchNextPage()}
      />
    </>
  );
}
