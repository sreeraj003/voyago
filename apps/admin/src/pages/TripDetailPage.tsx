import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type AdminTripDetail } from '@voyago/shared';
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
import { ReportTable } from './ReportsPage';

export function TripDetailPage() {
  const { id = '' } = useParams();
  const client = useQueryClient();
  const key = ['admin', 'trip', id];
  const {
    data: trip,
    error,
    isPending,
  } = useQuery({
    queryKey: key,
    queryFn: () => adminApi.trip(id),
  });
  const update = (next: AdminTripDetail) => {
    client.setQueryData(key, next);
    void client.invalidateQueries({ queryKey: ['admin', 'trips'] });
  };
  if (isPending) return <Loading />;
  if (!trip) return <ErrorText error={error} />;
  return (
    <>
      <h1>{trip.title}</h1>
      <div className="row">
        <Badge value={trip.status} />
        {trip.hidden ? <Badge value="HIDDEN" /> : null}
        <Badge value={trip.mode} tone="muted" />
      </div>
      {trip.hiddenReason ? <p className="notice">Hidden: {trip.hiddenReason}</p> : null}
      {trip.cancellationReason ? (
        <p className="notice">Cancelled: {trip.cancellationReason}</p>
      ) : null}
      <div className="actions">
        {trip.actions.includes('hide') ? (
          <ReasonAction
            title="Hide trip"
            confirm="Hide from discovery and feeds"
            onSubmit={async (reason) => update(await adminApi.tripAction(trip.id, 'hide', reason))}
          />
        ) : null}
        {trip.actions.includes('unhide') ? (
          <ReasonAction
            title="Show trip again"
            onSubmit={async (reason) =>
              update(await adminApi.tripAction(trip.id, 'unhide', reason))
            }
          />
        ) : null}
        {trip.actions.includes('cancel') ? (
          <ReasonAction
            title="Cancel trip"
            confirm="Cancel trip (participants see the reason)"
            danger
            onSubmit={async (reason) =>
              update(await adminApi.tripAction(trip.id, 'cancel', reason))
            }
          />
        ) : null}
      </div>
      <Section title="Details">
        <dl className="fields">
          <Field name="Organiser">
            <Person person={trip.organiser} />
          </Field>
          <Field name="Route">
            {trip.originName} to {trip.destinationName}
          </Field>
          <Field name="Departs">{when(trip.departureAt)}</Field>
          <Field name="Visibility">{label(trip.visibility)}</Field>
          <Field name="People">
            {trip.participantCount} of {trip.maxParticipants}
          </Field>
          <Field name="Created">{when(trip.createdAt)}</Field>
        </dl>
        {trip.description ? <blockquote>{trip.description}</blockquote> : null}
        <p className="muted">Exact meeting points are not shown in the admin app.</p>
      </Section>
      <Section title="Reports">
        <ReportTable reports={trip.reports} />
      </Section>
      <Section title="Moderation history">
        <History entries={trip.history} />
      </Section>
    </>
  );
}
