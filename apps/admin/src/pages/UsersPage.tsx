import { type AdminUsersQuery, UserRoleSchema, UserStatusSchema } from '@voyago/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '../admin-api';
import { Badge, ErrorText, label, LoadMore, Loading, when } from '../components';
import { usePaged } from '../use-paged';

export function UsersPage() {
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<AdminUsersQuery>({});
  const { rows, query } = usePaged(['admin', 'users', filters], (cursor) =>
    adminApi.users({ ...filters, cursor }),
  );

  return (
    <>
      <h1>Members</h1>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters((f) => ({ ...f, q: search.trim() || undefined }));
        }}
      >
        <input
          type="search"
          aria-label="Search members"
          placeholder="Username, name, exact email or id"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          aria-label="Status"
          value={filters.status ?? ''}
          onChange={(event) =>
            setFilters((f) => ({
              ...f,
              status: UserStatusSchema.safeParse(event.target.value).data,
            }))
          }
        >
          <option value="">Any status</option>
          {UserStatusSchema.options.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </select>
        <select
          aria-label="Role"
          value={filters.role ?? ''}
          onChange={(event) =>
            setFilters((f) => ({ ...f, role: UserRoleSchema.safeParse(event.target.value).data }))
          }
        >
          <option value="">Any role</option>
          {UserRoleSchema.options.map((r) => (
            <option key={r} value={r}>
              {label(r)}
            </option>
          ))}
        </select>
        <button type="submit" className="primary">
          Search
        </button>
      </form>
      <ErrorText error={query.error} />
      {query.isPending ? <Loading /> : null}
      <table>
        <thead>
          <tr>
            <th>Member</th>
            <th>Status</th>
            <th>Role</th>
            <th>Verified</th>
            <th>Open reports</th>
            <th>Joined</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((user) => (
            <tr key={user.id}>
              <td>
                <Link to={`/users/${user.id}`}>{user.displayName}</Link>
                <div className="muted">@{user.username}</div>
              </td>
              <td>
                <Badge value={user.deleted ? 'DELETED' : user.status} />
              </td>
              <td>{label(user.role)}</td>
              <td>
                {[user.emailVerified ? 'Email' : null, user.phoneVerified ? 'Phone' : null]
                  .filter(Boolean)
                  .join(', ') || 'None'}
              </td>
              <td>{user.openReportsAgainst}</td>
              <td>{when(user.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!query.isPending && rows.length === 0 ? <p className="muted">No members found.</p> : null}
      <LoadMore
        hasMore={query.hasNextPage}
        loading={query.isFetchingNextPage}
        onMore={() => void query.fetchNextPage()}
      />
    </>
  );
}
