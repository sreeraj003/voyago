import { type AuditEntry, type StaffPerson } from '@voyago/shared';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';

export const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'Not set';

export const label = (value: string) =>
  value.charAt(0) + value.slice(1).toLowerCase().replaceAll('_', ' ');

export function Badge({ value, tone }: { value: string; tone?: 'ok' | 'warn' | 'bad' | 'muted' }) {
  return <span className={`badge badge--${tone ?? toneFor(value)}`}>{label(value)}</span>;
}

function toneFor(value: string): 'ok' | 'warn' | 'bad' | 'muted' {
  if (['ACTIVE', 'VERIFIED', 'ACCEPTED', 'ACTIONED', 'PUBLISHED', 'COMPLETED'].includes(value)) {
    return 'ok';
  }
  if (['SUSPENDED', 'REJECTED', 'CRITICAL', 'HIGH', 'CANCELLED', 'HIDDEN'].includes(value)) {
    return 'bad';
  }
  if (['OPEN', 'IN_REVIEW', 'PENDING', 'MEDIUM'].includes(value)) return 'warn';
  return 'muted';
}

export function Person({ person, link = true }: { person: StaffPerson | null; link?: boolean }) {
  if (!person) return <span className="muted">Erased account</span>;
  const text = `${person.displayName} (@${person.username})`;
  return link ? <Link to={`/users/${person.id}`}>{text}</Link> : <span>{text}</span>;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="error">
      {error instanceof Error ? error.message : 'Something went wrong'}
    </p>
  );
}

export function Loading() {
  return <p role="status">Loading…</p>;
}

/** A card with a heading. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/**
 * A privileged action. It asks for a reason (recorded in the audit log) before it runs.
 */
export function ReasonAction({
  title,
  confirm,
  danger = false,
  minLength = 5,
  placeholder = 'Reason (saved in the audit log)',
  onSubmit,
}: {
  title: string;
  confirm?: string;
  danger?: boolean;
  minLength?: number;
  placeholder?: string;
  onSubmit: (reason: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!open) {
    return (
      <button type="button" className={danger ? 'danger' : undefined} onClick={() => setOpen(true)}>
        {title}
      </button>
    );
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason.trim());
      setOpen(false);
      setReason('');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="reason-form" onSubmit={(event) => void submit(event)}>
      <label>
        {title}
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={placeholder}
          maxLength={500}
          rows={2}
          required
        />
      </label>
      <ErrorText error={error} />
      <div className="row">
        <button
          type="submit"
          className={danger ? 'danger' : 'primary'}
          disabled={busy || reason.trim().length < minLength}
        >
          {confirm ?? title}
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Moderation history from the audit log. */
export function History({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) return <p className="muted">No moderation history.</p>;
  return (
    <ol className="history">
      {entries.map((entry) => (
        <li key={entry.id}>
          <strong>{entry.action}</strong> by{' '}
          {entry.actor ? (
            <Person person={entry.actor} />
          ) : (
            <span className="muted">{label(entry.actorType)}</span>
          )}{' '}
          <span className="muted">{when(entry.createdAt)}</span>
          {entry.reason ? <div>Reason: {entry.reason}</div> : null}
        </li>
      ))}
    </ol>
  );
}

/** "Load more" for cursor pages. */
export function LoadMore({
  hasMore,
  loading,
  onMore,
}: {
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
}) {
  if (!hasMore) return null;
  return (
    <button type="button" onClick={onMore} disabled={loading}>
      {loading ? 'Loading…' : 'Load more'}
    </button>
  );
}

export function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="field">
      <dt>{name}</dt>
      <dd>{children}</dd>
    </div>
  );
}
