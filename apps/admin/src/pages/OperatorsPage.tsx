import { OperatorVerificationStatusSchema } from '@voyago/shared';
import { Link, useSearchParams } from 'react-router-dom';
import { adminApi } from '../admin-api';
import { Badge, ErrorText, label, LoadMore, Loading, Person, when } from '../components';
import { usePaged } from '../use-paged';

export function OperatorsPage() {
  const [params, setParams] = useSearchParams();
  const status = OperatorVerificationStatusSchema.safeParse(params.get('status')).data;
  const { rows, query } = usePaged(['admin', 'operators', status], (cursor) =>
    adminApi.operators({ status, cursor }),
  );
  return (
    <>
      <h1>Operators</h1>
      <p className="muted">
        Operators are verified only after a person reviews their documents. Nothing is verified
        automatically.
      </p>
      <div className="filters">
        <select
          aria-label="Verification status"
          value={status ?? ''}
          onChange={(event) => setParams(event.target.value ? { status: event.target.value } : {})}
        >
          <option value="">Any status</option>
          {OperatorVerificationStatusSchema.options.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </select>
      </div>
      <ErrorText error={query.error} />
      {query.isPending ? <Loading /> : null}
      <table>
        <thead>
          <tr>
            <th>Operator</th>
            <th>Status</th>
            <th>Owner</th>
            <th>Documents</th>
            <th>Submitted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((operator) => (
            <tr key={operator.id}>
              <td>
                <Link to={`/operators/${operator.id}`}>{operator.displayName}</Link>
                <div className="muted">{operator.legalName}</div>
              </td>
              <td>
                <Badge value={operator.verificationStatus} />
              </td>
              <td>
                <Person person={operator.owner} />
              </td>
              <td>
                {operator.documentCount} ({operator.pendingDocumentCount} to review)
              </td>
              <td>{when(operator.submittedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!query.isPending && rows.length === 0 ? <p className="muted">No operators.</p> : null}
      <LoadMore
        hasMore={query.hasNextPage}
        loading={query.isFetchingNextPage}
        onMore={() => void query.fetchNextPage()}
      />
    </>
  );
}
