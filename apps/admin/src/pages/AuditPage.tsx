import { type AuditQuery } from '@voyago/shared';
import { useState } from 'react';
import { adminApi } from '../admin-api';
import { ErrorText, label, LoadMore, Loading, Person, when } from '../components';
import { usePaged } from '../use-paged';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function AuditPage() {
  const [action, setAction] = useState('');
  const [entityId, setEntityId] = useState('');
  const [filters, setFilters] = useState<AuditQuery>({});
  const { rows, query } = usePaged(['admin', 'audit', filters], (cursor) =>
    adminApi.audit({ ...filters, cursor }),
  );
  return (
    <>
      <h1>Audit log</h1>
      <p className="muted">Every privileged action, newest first. Entries cannot be changed.</p>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters({
            action: action.trim() || undefined,
            entityId: UUID.test(entityId.trim()) ? entityId.trim().toLowerCase() : undefined,
          });
        }}
      >
        <input
          aria-label="Action"
          placeholder="Action, e.g. user.suspend or report."
          value={action}
          onChange={(event) => setAction(event.target.value)}
        />
        <input
          aria-label="Target id"
          placeholder="Target id"
          value={entityId}
          onChange={(event) => setEntityId(event.target.value)}
        />
        <button type="submit" className="primary">
          Filter
        </button>
      </form>
      <ErrorText error={query.error} />
      {query.isPending ? <Loading /> : null}
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>Action</th>
            <th>Target</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((entry) => (
            <tr key={entry.id}>
              <td>{when(entry.createdAt)}</td>
              <td>{entry.actor ? <Person person={entry.actor} /> : label(entry.actorType)}</td>
              <td>
                <code>{entry.action}</code>
              </td>
              <td>
                {entry.entityType}
                <div className="muted">
                  <code>{entry.entityId ?? ''}</code>
                </div>
              </td>
              <td>{entry.reason ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!query.isPending && rows.length === 0 ? <p className="muted">No entries.</p> : null}
      <LoadMore
        hasMore={query.hasNextPage}
        loading={query.isFetchingNextPage}
        onMore={() => void query.fetchNextPage()}
      />
    </>
  );
}
