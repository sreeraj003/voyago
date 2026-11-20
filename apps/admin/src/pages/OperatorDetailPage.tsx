import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type AdminOperatorDetail, formatPaise, type OperatorDocument } from '@voyago/shared';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { adminApi } from '../admin-api';
import {
  Badge,
  ErrorText,
  Field,
  History,
  label,
  Loading,
  Person,
  ReasonAction,
  Section,
  when,
} from '../components';

export function OperatorDetailPage() {
  const { id = '' } = useParams();
  const client = useQueryClient();
  const key = ['admin', 'operator', id];
  const {
    data: operator,
    error,
    isPending,
  } = useQuery({
    queryKey: key,
    queryFn: () => adminApi.operator(id),
  });
  const update = (next: AdminOperatorDetail) => {
    client.setQueryData(key, next);
    void client.invalidateQueries({ queryKey: ['admin', 'operators'] });
    void client.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
  };
  if (isPending) return <Loading />;
  if (!operator) return <ErrorText error={error} />;
  const canSet = operator.actions.includes('set_status');
  const reviewed = operator.documents.every((d) => d.status !== 'PENDING');
  const accepted = operator.documents.some((d) => d.status === 'ACCEPTED');
  return (
    <>
      <h1>{operator.displayName}</h1>
      <div className="row">
        <Badge value={operator.verificationStatus} />
      </div>
      {operator.verificationNote ? <p className="notice">{operator.verificationNote}</p> : null}
      <Section title="Business">
        <dl className="fields">
          <Field name="Legal name">{operator.legalName}</Field>
          <Field name="Owner">
            <Person person={operator.owner} />
          </Field>
          <Field name="GSTIN">{operator.gstin ?? 'Not shown'}</Field>
          <Field name="Submitted">{when(operator.submittedAt)}</Field>
          <Field name="Verified">
            {operator.verifiedAt ? (
              <>
                {when(operator.verifiedAt)} by <Person person={operator.verifiedBy} />
              </>
            ) : (
              'No'
            )}
          </Field>
        </dl>
      </Section>
      <Section title="Documents">
        {operator.documents.length === 0 ? (
          <p className="muted">No documents submitted yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Document</th>
                <th>Status</th>
                <th>Review</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {operator.documents.map((doc) => (
                <DocumentRow key={doc.id} operator={operator} doc={doc} onDone={update} />
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">
          Documents open through five-minute links, and every opening is recorded in the audit log.
        </p>
      </Section>
      <Section title="Packages">
        {operator.packages.length === 0 ? (
          <p className="muted">No packages yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Package</th>
                <th>Status</th>
                <th>Starts</th>
                <th>Price per person</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {operator.packages.map((pkg) => (
                <tr key={pkg.id}>
                  <td>
                    {pkg.title}
                    {pkg.suspendedReason ? (
                      <div className="muted">Suspended: {pkg.suspendedReason}</div>
                    ) : null}
                  </td>
                  <td>
                    <Badge value={pkg.status} />
                  </td>
                  <td>{when(pkg.startsAt)}</td>
                  <td>{formatPaise(pkg.pricePaise)}</td>
                  <td>
                    {operator.actions.includes('moderate_packages') ? (
                      pkg.status === 'SUSPENDED' ? (
                        <ReasonAction
                          title="Restore"
                          onSubmit={async (reason) =>
                            update(await adminApi.restorePackage(operator.id, pkg.id, reason))
                          }
                        />
                      ) : pkg.status === 'ARCHIVED' ? null : (
                        <ReasonAction
                          title="Suspend"
                          danger
                          onSubmit={async (reason) =>
                            update(await adminApi.suspendPackage(operator.id, pkg.id, reason))
                          }
                        />
                      )
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">
          A suspended package is off sale and returns to the operator as a draft when restored.
        </p>
      </Section>
      {canSet ? (
        <Section title="Decision">
          {!reviewed || !accepted ? (
            <p className="muted">To verify, review every document and accept at least one.</p>
          ) : null}
          <div className="actions">
            {operator.verificationStatus !== 'VERIFIED' && reviewed && accepted ? (
              <ReasonAction
                title="Verify operator"
                onSubmit={async (reason) =>
                  update(
                    await adminApi.setOperatorStatus(operator.id, { status: 'VERIFIED', reason }),
                  )
                }
              />
            ) : null}
            {operator.verificationStatus !== 'REJECTED' ? (
              <ReasonAction
                title="Reject"
                danger
                onSubmit={async (reason) =>
                  update(
                    await adminApi.setOperatorStatus(operator.id, { status: 'REJECTED', reason }),
                  )
                }
              />
            ) : null}
            {operator.verificationStatus === 'VERIFIED' ? (
              <ReasonAction
                title="Suspend operator"
                danger
                onSubmit={async (reason) =>
                  update(
                    await adminApi.setOperatorStatus(operator.id, { status: 'SUSPENDED', reason }),
                  )
                }
              />
            ) : null}
          </div>
        </Section>
      ) : null}
      <Section title="History">
        <History entries={operator.history} />
      </Section>
    </>
  );
}

function DocumentRow({
  operator,
  doc,
  onDone,
}: {
  operator: AdminOperatorDetail;
  doc: OperatorDocument;
  onDone: (next: AdminOperatorDetail) => void;
}) {
  const [note, setNote] = useState('');
  const open = useMutation({
    mutationFn: () => adminApi.documentLink(operator.id, doc.id),
    onSuccess: (link) => {
      window.open(link.url, '_blank', 'noopener,noreferrer');
    },
  });
  const review = useMutation({
    mutationFn: (status: 'ACCEPTED' | 'REJECTED') =>
      adminApi.reviewDocument(operator.id, doc.id, {
        status,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: (next) => {
      setNote('');
      onDone(next);
    },
  });
  return (
    <tr>
      <td>
        {label(doc.kind)}
        <div className="muted">
          {doc.fileName}, uploaded {when(doc.uploadedAt)}
        </div>
      </td>
      <td>
        <Badge value={doc.status} />
      </td>
      <td>
        {doc.reviewedBy ? (
          <>
            <Person person={doc.reviewedBy} /> {when(doc.reviewedAt)}
            {doc.reviewNote ? <div>{doc.reviewNote}</div> : null}
          </>
        ) : (
          <span className="muted">Not reviewed</span>
        )}
        {operator.actions.includes('review_documents') ? (
          <div className="row">
            <input
              aria-label={`Note for ${label(doc.kind)}`}
              placeholder="Note (optional)"
              value={note}
              maxLength={1000}
              onChange={(event) => setNote(event.target.value)}
            />
            <button
              type="button"
              disabled={review.isPending}
              onClick={() => review.mutate('ACCEPTED')}
            >
              Accept
            </button>
            <button
              type="button"
              className="danger"
              disabled={review.isPending}
              onClick={() => review.mutate('REJECTED')}
            >
              Reject
            </button>
          </div>
        ) : null}
        <ErrorText error={review.error} />
      </td>
      <td>
        {operator.actions.includes('open_documents') ? (
          <button type="button" onClick={() => open.mutate()} disabled={open.isPending}>
            Open
          </button>
        ) : null}
        <ErrorText error={open.error} />
      </td>
    </tr>
  );
}
