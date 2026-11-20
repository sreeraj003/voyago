import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type AdminReportDetail, ReportSeveritySchema } from '@voyago/shared';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
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
import { useAdmin } from '../use-admin';
import { ReportTable } from './ReportsPage';

export function ReportDetailPage() {
  const { id = '' } = useParams();
  const client = useQueryClient();
  const key = ['admin', 'report', id];
  const {
    data: report,
    error,
    isPending,
  } = useQuery({
    queryKey: key,
    queryFn: () => adminApi.report(id),
  });
  const update = (next: AdminReportDetail) => {
    client.setQueryData(key, next);
    void client.invalidateQueries({ queryKey: ['admin', 'reports'] });
    void client.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
  };
  const refresh = () => client.invalidateQueries({ queryKey: key });

  if (isPending) return <Loading />;
  if (!report) return <ErrorText error={error} />;
  const has = (action: AdminReportDetail['actions'][number]) => report.actions.includes(action);
  const targetLink =
    report.targetType === 'TRIP'
      ? `/trips/${report.targetId}`
      : report.targetType === 'USER'
        ? `/users/${report.targetId}`
        : null;

  return (
    <>
      <h1>
        Report: {label(report.reason)} <span className="muted">({label(report.targetType)})</span>
      </h1>
      <div className="row">
        <Badge value={report.severity} />
        <Badge value={report.status} />
      </div>
      <Section title="Reported">
        <dl className="fields">
          <Field name="What">
            {targetLink ? <Link to={targetLink}>{report.targetLabel}</Link> : report.targetLabel}
          </Field>
          <Field name="Where">{report.target.context ?? 'Unknown'}</Field>
          <Field name="Current state">
            {!report.target.exists
              ? 'No longer exists'
              : report.target.removed
                ? 'Removed'
                : (report.target.status ?? 'Live')}
          </Field>
          <Field name="Responsible member">
            <Person person={report.reportedUser} />
          </Field>
          <Field name="Reporter">
            <Person person={report.reporter} />
          </Field>
          <Field name="Filed">{when(report.createdAt)}</Field>
        </dl>
        {report.target.text ? <blockquote>{report.target.text}</blockquote> : null}
        {report.details ? (
          <p>
            <strong>Reporter&apos;s note:</strong> {report.details}
          </p>
        ) : null}
      </Section>

      {has('assign') || has('triage') ? (
        <Section title="Triage">
          {has('assign') ? <AssignForm report={report} onDone={update} /> : null}
          {has('triage') ? <TriageForm report={report} onDone={update} /> : null}
        </Section>
      ) : (
        <Section title="Evidence">
          <EvidenceList refs={report.evidenceRefs} />
          <p className="muted">
            Assigned to {report.assignedTo ? <Person person={report.assignedTo} /> : 'nobody'}
          </p>
        </Section>
      )}

      <ContentActions report={report} onDone={() => void refresh()} />

      <Section title="Resolution">
        {report.resolutionNote ? (
          <p>
            {label(report.status)} {when(report.resolvedAt)}: {report.resolutionNote}
          </p>
        ) : (
          <p className="muted">Not resolved yet.</p>
        )}
        {has('resolve') ? <ResolveForm report={report} onDone={update} /> : null}
        {has('reopen') ? (
          <ReasonAction
            title="Reopen"
            onSubmit={async (reason) => update(await adminApi.reopenReport(report.id, reason))}
          />
        ) : null}
      </Section>

      <Section title="Other reports of the same thing">
        <ReportTable reports={report.related} />
      </Section>
      <Section title="History">
        <History entries={report.history} />
      </Section>
    </>
  );
}

function EvidenceList({ refs }: { refs: string[] }) {
  if (refs.length === 0) return <p className="muted">No evidence references.</p>;
  return (
    <ul>
      {refs.map((ref) => (
        <li key={ref}>{ref}</li>
      ))}
    </ul>
  );
}

function AssignForm({
  report,
  onDone,
}: {
  report: AdminReportDetail;
  onDone: (next: AdminReportDetail) => void;
}) {
  const { me } = useAdmin();
  const staff = useQuery({ queryKey: ['admin', 'staff'], queryFn: adminApi.staff });
  const assign = useMutation({
    mutationFn: (assigneeId: string | null) => adminApi.assignReport(report.id, assigneeId),
    onSuccess: onDone,
  });
  return (
    <div className="row">
      <label>
        Assigned to{' '}
        <select
          value={report.assignedTo?.id ?? ''}
          disabled={assign.isPending}
          onChange={(event) => assign.mutate(event.target.value || null)}
        >
          <option value="">Nobody</option>
          {(staff.data ?? []).map((person) => (
            <option key={person.id} value={person.id}>
              {person.displayName} ({label(person.role)})
            </option>
          ))}
        </select>
      </label>
      {me.data && report.assignedTo?.id !== me.data.id ? (
        <button type="button" onClick={() => assign.mutate(me.data.id)} disabled={assign.isPending}>
          Take it
        </button>
      ) : null}
      <ErrorText error={assign.error} />
    </div>
  );
}

function TriageForm({
  report,
  onDone,
}: {
  report: AdminReportDetail;
  onDone: (next: AdminReportDetail) => void;
}) {
  const [newRef, setNewRef] = useState('');
  const triage = useMutation({
    mutationFn: (input: Parameters<typeof adminApi.triageReport>[1]) =>
      adminApi.triageReport(report.id, input),
    onSuccess: (next) => {
      setNewRef('');
      onDone(next);
    },
  });
  return (
    <>
      <label>
        Severity{' '}
        <select
          value={report.severity}
          disabled={triage.isPending}
          onChange={(event) =>
            triage.mutate({ severity: ReportSeveritySchema.parse(event.target.value) })
          }
        >
          {ReportSeveritySchema.options.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </select>
      </label>
      <h3>Evidence references</h3>
      <ul>
        {report.evidenceRefs.map((ref) => (
          <li key={ref}>
            {ref}{' '}
            <button
              type="button"
              className="link"
              onClick={() =>
                triage.mutate({ evidenceRefs: report.evidenceRefs.filter((r) => r !== ref) })
              }
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          if (newRef.trim())
            triage.mutate({ evidenceRefs: [...report.evidenceRefs, newRef.trim()] });
        }}
      >
        <input
          aria-label="Add evidence reference"
          placeholder="Link, message id or ticket number"
          value={newRef}
          maxLength={500}
          onChange={(event) => setNewRef(event.target.value)}
        />
        <button type="submit" disabled={!newRef.trim() || triage.isPending}>
          Add
        </button>
      </form>
      <ErrorText error={triage.error} />
    </>
  );
}

function ResolveForm({
  report,
  onDone,
}: {
  report: AdminReportDetail;
  onDone: (next: AdminReportDetail) => void;
}) {
  const [outcome, setOutcome] = useState<'ACTIONED' | 'DISMISSED'>('ACTIONED');
  const [note, setNote] = useState('');
  const resolve = useMutation({
    mutationFn: () => adminApi.resolveReport(report.id, { outcome, note: note.trim() }),
    onSuccess: onDone,
  });
  return (
    <form
      className="reason-form"
      onSubmit={(event) => {
        event.preventDefault();
        resolve.mutate();
      }}
    >
      <fieldset className="row">
        <legend>Outcome</legend>
        <label>
          <input
            type="radio"
            name="outcome"
            checked={outcome === 'ACTIONED'}
            onChange={() => setOutcome('ACTIONED')}
          />{' '}
          Actioned
        </label>
        <label>
          <input
            type="radio"
            name="outcome"
            checked={outcome === 'DISMISSED'}
            onChange={() => setOutcome('DISMISSED')}
          />{' '}
          Dismissed
        </label>
      </fieldset>
      <label>
        Resolution note
        <textarea
          rows={3}
          maxLength={2000}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="What you found and what you did. The reporter only hears that it was reviewed."
        />
      </label>
      <ErrorText error={resolve.error} />
      <button
        type="submit"
        className="primary"
        disabled={resolve.isPending || note.trim().length < 5}
      >
        Resolve report
      </button>
    </form>
  );
}

/** Actions on the reported thing itself. Each needs a reason and is audited. */
function ContentActions({ report, onDone }: { report: AdminReportDetail; onDone: () => void }) {
  const has = (action: AdminReportDetail['actions'][number]) => report.actions.includes(action);
  const reported = report.reportedUser;
  const after = (promise: Promise<unknown>) => promise.then(onDone);
  if (
    !['suspend_user', 'hide_trip', 'cancel_trip', 'remove_post', 'remove_message'].some((a) =>
      report.actions.includes(a as AdminReportDetail['actions'][number]),
    )
  ) {
    return null;
  }
  return (
    <Section title="Act on the content">
      <div className="actions">
        {has('suspend_user') && reported ? (
          <ReasonAction
            title={`Suspend @${reported.username}`}
            danger
            onSubmit={(reason) => after(adminApi.suspend(reported.id, reason))}
          />
        ) : null}
        {has('hide_trip') ? (
          <ReasonAction
            title="Hide trip"
            onSubmit={(reason) => after(adminApi.tripAction(report.targetId, 'hide', reason))}
          />
        ) : null}
        {has('cancel_trip') ? (
          <ReasonAction
            title="Cancel trip"
            confirm="Cancel trip (participants see the reason)"
            danger
            onSubmit={(reason) => after(adminApi.tripAction(report.targetId, 'cancel', reason))}
          />
        ) : null}
        {has('remove_post') ? (
          <ReasonAction
            title="Remove post"
            danger
            onSubmit={(reason) => after(adminApi.removePost(report.targetId, reason))}
          />
        ) : null}
        {has('remove_message') ? (
          <ReasonAction
            title="Remove message"
            danger
            onSubmit={(reason) => after(adminApi.removeMessage(report.targetId, reason))}
          />
        ) : null}
      </div>
    </Section>
  );
}
