import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type AdminUserDetail, type UserRole, UserRoleSchema } from '@voyago/shared';
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
  ReasonAction,
  Section,
  when,
} from '../components';
import { ReportTable } from './ReportsPage';

export function UserDetailPage() {
  const { id = '' } = useParams();
  const client = useQueryClient();
  const key = ['admin', 'user', id];
  const {
    data: user,
    error,
    isPending,
  } = useQuery({
    queryKey: key,
    queryFn: () => adminApi.user(id),
  });
  const update = (next: AdminUserDetail) => {
    client.setQueryData(key, next);
    void client.invalidateQueries({ queryKey: ['admin', 'users'] });
    void client.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
  };

  if (isPending) return <Loading />;
  if (!user) return <ErrorText error={error} />;
  return (
    <>
      <h1>
        {user.displayName} <span className="muted">@{user.username}</span>
      </h1>
      <div className="row">
        <Badge value={user.deleted ? 'DELETED' : user.status} />
        <Badge value={user.role} tone="muted" />
      </div>
      {user.suspension ? (
        <p className="notice">
          Suspended {when(user.suspension.at)}
          {user.suspension.reason ? `: ${user.suspension.reason}` : ''}
        </p>
      ) : null}
      <div className="actions">
        {user.actions.includes('suspend') ? (
          <ReasonAction
            title="Suspend account"
            confirm="Suspend and sign out everywhere"
            danger
            onSubmit={async (reason) => update(await adminApi.suspend(user.id, reason))}
          />
        ) : null}
        {user.actions.includes('restore') ? (
          <ReasonAction
            title="Restore account"
            onSubmit={async (reason) => update(await adminApi.restore(user.id, reason))}
          />
        ) : null}
        {user.actions.includes('role') ? <RoleForm user={user} onDone={update} /> : null}
      </div>
      <Section title="Account">
        <dl className="fields">
          <Field name="Email">
            {user.maskedEmail ?? 'None'} {user.emailVerified ? '(verified)' : ''}
          </Field>
          <Field name="Phone">
            {user.maskedPhone ?? 'None'} {user.phoneVerified ? '(verified)' : ''}
          </Field>
          <Field name="Home city">{user.homeCity ?? 'Not set'}</Field>
          <Field name="Joined">{when(user.createdAt)}</Field>
          <Field name="Last active">{when(user.lastActiveAt)}</Field>
          <Field name="Trips organised">{user.counts.tripsOrganised}</Field>
          <Field name="Reports against">
            {user.counts.reportsAgainst} ({user.openReportsAgainst} open)
          </Field>
          <Field name="Reports filed">{user.counts.reportsFiled}</Field>
        </dl>
        {user.bio ? <p>{user.bio}</p> : null}
        <p className="muted">Contact details are masked for staff.</p>
      </Section>
      <Section title="Verification">
        <dl className="fields">
          {user.motorcycles.map((bike) => (
            <Field key={bike.id} name={bike.label}>
              <Badge value={bike.verificationStatus} />
            </Field>
          ))}
          {user.operator ? (
            <Field name={`Operator: ${user.operator.displayName}`}>
              <Badge value={user.operator.verificationStatus} />
            </Field>
          ) : null}
        </dl>
        {user.motorcycles.length === 0 && !user.operator ? (
          <p className="muted">No motorcycles or operator account.</p>
        ) : null}
      </Section>
      <Section title="Reports against this member">
        <ReportTable reports={user.reportsAgainst} />
      </Section>
      <Section title="Moderation history">
        <History entries={user.history} />
      </Section>
    </>
  );
}

function RoleForm({
  user,
  onDone,
}: {
  user: AdminUserDetail;
  onDone: (next: AdminUserDetail) => void;
}) {
  const [role, setRole] = useState<UserRole>(user.role);
  const [reason, setReason] = useState('');
  const change = useMutation({
    mutationFn: () => adminApi.setRole(user.id, { role, reason: reason.trim() }),
    onSuccess: (next) => {
      setReason('');
      onDone(next);
    },
  });
  return (
    <form
      className="reason-form"
      onSubmit={(event) => {
        event.preventDefault();
        change.mutate();
      }}
    >
      <label>
        Role
        <select
          value={role}
          onChange={(event) => setRole(UserRoleSchema.parse(event.target.value))}
        >
          {UserRoleSchema.options.map((r) => (
            <option key={r} value={r}>
              {label(r)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Reason
        <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />
      </label>
      <ErrorText error={change.error} />
      <button
        type="submit"
        disabled={change.isPending || role === user.role || reason.trim().length < 5}
      >
        Change role
      </button>
    </form>
  );
}
