import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Trip } from '@voyago/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Image, Linking, StyleSheet, Text, View } from 'react-native';
import {
  askToJoin,
  leaveTrip,
  respondToInvitation,
  withdrawRequest,
} from '../../../src/api/participation';
import { openTripChat } from '../../../src/api/chat';
import { cancelTrip, deleteTrip, getTrip, tripAction } from '../../../src/api/trips';
import { useFormError } from '../../../src/auth/use-form-error';
import { Button, FormMessage, TextField } from '../../../src/components/Form';
import { FormScreen } from '../../../src/components/FormScreen';
import { OpenChatButton } from '../../../src/components/OpenChatButton';
import { ReportForm } from '../../../src/components/ReportForm';
import { StatusBadge } from '../../../src/components/StatusBadge';
import { formatRupees } from '../../../src/trips/trip-form';
import { directionsUrl, routeSummary } from '../../../src/trips/trip-route';
import { radius, spacing, typography } from '../../../src/theme/tokens';
import { useTheme } from '../../../src/theme/use-theme';

export default function TripDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const trip = useQuery({ queryKey: ['trip', id], queryFn: () => getTrip(id) });
  return (
    <FormScreen>
      {trip.isPending ? <FormMessage tone="info">Loading trip…</FormMessage> : null}
      {trip.isError ? <FormMessage tone="error">This trip is not available.</FormMessage> : null}
      {trip.data ? <TripDetail trip={trip.data} /> : null}
    </FormScreen>
  );
}

function TripDetail({ trip }: { trip: Trip }) {
  const { colors } = useTheme();
  const line = (label: string, value: string | null) =>
    value ? (
      <Text style={[styles.body, { color: colors.text }]}>
        <Text style={styles.bold}>{label}: </Text>
        {value}
      </Text>
    ) : null;
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);
  const estimates = [
    trip.estimatedDistanceKm ? `${trip.estimatedDistanceKm} km` : null,
    trip.estimatedDurationMinutes
      ? `${Math.round((trip.estimatedDurationMinutes / 60) * 10) / 10} h`
      : null,
  ]
    .filter(Boolean)
    .join(', ');
  const mapsUrl = directionsUrl(trip);

  return (
    <>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        {trip.coverImageUrl ? (
          <Image
            source={{ uri: trip.coverImageUrl }}
            style={styles.cover}
            accessibilityLabel={`Cover photo for ${trip.title}`}
          />
        ) : null}
        <StatusBadge status={trip.status} />
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
          {trip.title}
        </Text>
        <Text style={[styles.caption, { color: colors.textMuted }]}>
          {trip.mode === 'RIDE' ? 'Ride' : 'Travel'} · free community trip
          {trip.visibility === 'PRIVATE' ? ' · private (invite only)' : ''}
          {trip.visibility === 'COMMUNITY' ? ' · members only' : ''}
        </Text>
        <Button
          title={`Organised by ${trip.organiser.displayName} (@${trip.organiser.username})`}
          variant="link"
          onPress={() => router.push(`/users/${trip.organiser.username}`)}
        />
        {trip.community ? (
          <Button
            title={`In ${trip.community.name}`}
            variant="link"
            onPress={() => router.push(`/communities/${trip.community?.slug ?? ''}`)}
          />
        ) : null}
        {trip.description ? (
          <Text style={[styles.body, { color: colors.text }]}>{trip.description}</Text>
        ) : null}
        {line(
          'Meeting point',
          trip.origin.approximate
            ? `${trip.origin.name} (exact spot shared with participants)`
            : trip.origin.name,
        )}
        {line('Destination', trip.destination.name)}
        {line('Stops', trip.stops.map((stop) => stop.name).join(' → ') || null)}
        {line('Departs', when(trip.departureAt))}
        {line('Returns', when(trip.returnAt))}
        {line(
          'People',
          `${trip.participantCount} of ${trip.maxParticipants} (minimum ${trip.minParticipants})`,
        )}
        {line('Joining', trip.approvalRequired ? 'Organiser approves requests' : 'Open')}
        {line('Estimated cost per person', formatRupees(trip.estimatedBudgetPaise))}
        {line('Road route', routeSummary(trip))}
        {line("Organiser's estimate", estimates || null)}
        {mapsUrl ? (
          <Button
            title="Open in Google Maps"
            variant="link"
            onPress={() => void Linking.openURL(mapsUrl)}
          />
        ) : null}
        {line('Cancelled because', trip.cancellationReason)}
        {line('Hidden from discovery by Voyago moderators', trip.hiddenReason)}
      </View>
      <Membership trip={trip} />
      <TripActions trip={trip} />
      {trip.status === 'COMPLETED' && (trip.viewer.isParticipant || trip.viewer.isOrganiser) ? (
        <Button
          title="Share a trip recap"
          variant="secondary"
          onPress={() =>
            router.push({
              pathname: '/posts/new',
              params: { tripId: trip.id, tripTitle: trip.title },
            })
          }
        />
      ) : null}
      {trip.viewer.isOrganiser ? null : (
        <ReportForm targetType="TRIP" targetId={trip.id} label="Report trip" />
      )}
    </>
  );
}

/** Joining, leaving, and links to requests and people, depending on who is looking. */
function Membership({ trip }: { trip: Trip }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const error = useFormError();
  const [message, setMessage] = useState('');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const { viewer } = trip;
  const actions = new Set(viewer.actions);
  const request = viewer.joinRequest;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['trip', trip.id] });
    void queryClient.invalidateQueries({ queryKey: ['my-trips'] });
    void queryClient.invalidateQueries({ queryKey: ['discovery'] });
  };
  const join = useMutation({
    mutationFn: () => askToJoin(trip.id, message),
    onMutate: () => error.clear(),
    onSuccess: () => {
      setMessage('');
      refresh();
    },
    onError: (caught) => error.capture(caught),
  });
  const withdraw = useMutation({
    mutationFn: (id: string) => withdrawRequest(id),
    onMutate: () => error.clear(),
    onSuccess: refresh,
    onError: (caught) => error.capture(caught),
  });
  const answer = useMutation({
    mutationFn: (verb: 'accept' | 'decline') =>
      respondToInvitation(viewer.invitationId ?? '', verb),
    onMutate: () => error.clear(),
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: ['my-invitations'] });
    },
    onError: (caught) => error.capture(caught),
  });
  const leave = useMutation({
    mutationFn: () => leaveTrip(trip.id),
    onMutate: () => error.clear(),
    onSuccess: () => {
      setConfirmLeave(false);
      refresh();
    },
    onError: (caught) => error.capture(caught),
  });

  const canSeePeople = viewer.isOrganiser || viewer.isParticipant;
  const managesPeople = actions.has('manage_people');
  return (
    <View style={styles.actions}>
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      {viewer.isCoOrganiser ? (
        <FormMessage tone="info">You are a co-organiser of this trip.</FormMessage>
      ) : null}
      {viewer.invitationId ? (
        <>
          <FormMessage tone="info">You’re invited to this trip.</FormMessage>
          <Button
            title="Accept and join"
            loading={answer.isPending && answer.variables === 'accept'}
            onPress={() => answer.mutate('accept')}
          />
          <Button
            title="Decline"
            variant="secondary"
            loading={answer.isPending && answer.variables === 'decline'}
            onPress={() => answer.mutate('decline')}
          />
        </>
      ) : null}
      {managesPeople && trip.approvalRequired ? (
        <Button
          title={
            viewer.pendingRequestCount > 0
              ? `Join requests (${viewer.pendingRequestCount})`
              : 'Join requests'
          }
          variant={viewer.pendingRequestCount > 0 ? 'primary' : 'secondary'}
          onPress={() => router.push(`/trips/${trip.id}/requests`)}
        />
      ) : null}
      {managesPeople && ['PUBLISHED', 'FULL'].includes(trip.status) ? (
        <Button
          title="Invite people"
          variant="secondary"
          onPress={() => router.push(`/trips/${trip.id}/invite`)}
        />
      ) : null}
      {actions.has('chat') ? (
        <OpenChatButton title="Group chat" open={() => openTripChat(trip.id)} />
      ) : null}
      {canSeePeople && trip.status !== 'DRAFT' ? (
        <Button
          title={`People on this trip (${trip.participantCount})`}
          variant="secondary"
          onPress={() => router.push(`/trips/${trip.id}/people`)}
        />
      ) : null}

      {request?.status === 'PENDING' ? (
        <>
          <FormMessage tone="info">
            Request sent. The organiser will approve or decline it.
          </FormMessage>
          <Button
            title="Withdraw request"
            variant="secondary"
            loading={withdraw.isPending}
            onPress={() => withdraw.mutate(request.id)}
          />
        </>
      ) : null}
      {viewer.participantStatus === 'REMOVED' ? (
        <FormMessage tone="info">The organiser removed you from this trip.</FormMessage>
      ) : null}
      {request?.status === 'REJECTED' && actions.has('join') ? (
        <FormMessage tone="info">The organiser declined your last request.</FormMessage>
      ) : null}
      {trip.status === 'FULL' && !viewer.isParticipant && !viewer.isOrganiser ? (
        <FormMessage tone="info">This trip is full.</FormMessage>
      ) : null}

      {actions.has('join') ? (
        <>
          {trip.approvalRequired ? (
            <TextField
              label="Note to the organiser (optional)"
              value={message}
              onChangeText={setMessage}
              multiline
              maxLength={500}
              hint="For example your riding experience or what you ride."
              error={error.fields.message}
            />
          ) : null}
          <Button
            title={trip.approvalRequired ? 'Ask to join' : 'Join trip'}
            loading={join.isPending}
            onPress={() => join.mutate()}
          />
          <Text style={[styles.caption, { color: colors.textMuted }]}>
            Free to join. Everyone shares their own costs.
          </Text>
        </>
      ) : null}

      {actions.has('leave') && !confirmLeave ? (
        <Button title="Leave trip" variant="link" onPress={() => setConfirmLeave(true)} />
      ) : null}
      {confirmLeave ? (
        <>
          <FormMessage tone="info">Leave this trip? Your place goes to someone else.</FormMessage>
          <Button
            title="Yes, leave"
            variant="secondary"
            loading={leave.isPending}
            onPress={() => leave.mutate()}
          />
          <Button title="Stay" variant="link" onPress={() => setConfirmLeave(false)} />
        </>
      ) : null}
    </View>
  );
}

function TripActions({ trip }: { trip: Trip }) {
  const queryClient = useQueryClient();
  const error = useFormError();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const actions = new Set(trip.viewer.actions);

  const onDone = (updated: Trip | void) => {
    if (updated) queryClient.setQueryData(['trip', trip.id], updated);
    void queryClient.invalidateQueries({ queryKey: ['my-trips'] });
  };
  const run = useMutation({
    mutationFn: (action: 'publish' | 'start' | 'complete') => tripAction(trip.id, action),
    onMutate: () => error.clear(),
    onSuccess: onDone,
    onError: (caught) => error.capture(caught),
  });
  const cancel = useMutation({
    mutationFn: () => cancelTrip(trip.id, reason),
    onMutate: () => error.clear(),
    onSuccess: (updated) => {
      setCancelling(false);
      onDone(updated);
    },
    onError: (caught) => error.capture(caught),
  });
  const remove = useMutation({
    mutationFn: () => deleteTrip(trip.id),
    onSuccess: () => {
      onDone();
      router.back();
    },
    onError: (caught) => error.capture(caught),
  });

  actions.delete('join');
  actions.delete('leave');
  actions.delete('manage_people');
  actions.delete('chat');
  if (actions.size === 0) return null;
  return (
    <View style={styles.actions}>
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      {actions.has('publish') ? (
        <Button
          title="Publish trip"
          loading={run.isPending}
          onPress={() => run.mutate('publish')}
        />
      ) : null}
      {actions.has('start') ? (
        <Button title="Start trip" loading={run.isPending} onPress={() => run.mutate('start')} />
      ) : null}
      {actions.has('complete') ? (
        <Button
          title="Mark as completed"
          loading={run.isPending}
          onPress={() => run.mutate('complete')}
        />
      ) : null}
      {actions.has('edit') ? (
        <Button
          title="Edit trip"
          variant="secondary"
          onPress={() => router.push(`/trips/${trip.id}/edit`)}
        />
      ) : null}
      {actions.has('cancel') && !cancelling ? (
        <Button title="Cancel trip" variant="secondary" onPress={() => setCancelling(true)} />
      ) : null}
      {cancelling ? (
        <>
          <TextField
            label="Reason for cancelling"
            value={reason}
            onChangeText={setReason}
            hint="Shown to everyone on the trip."
            error={error.fields.reason}
          />
          <Button
            title="Confirm cancellation"
            loading={cancel.isPending}
            onPress={() => cancel.mutate()}
          />
          <Button title="Keep the trip" variant="link" onPress={() => setCancelling(false)} />
        </>
      ) : null}
      {actions.has('delete') ? (
        <Button
          title="Delete draft"
          variant="link"
          loading={remove.isPending}
          onPress={() => remove.mutate()}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  title: { ...typography.heading },
  body: { ...typography.body },
  bold: { fontWeight: '600' },
  caption: { ...typography.caption },
  actions: { gap: spacing.sm },
  cover: { width: '100%', aspectRatio: 1200 / 630, borderRadius: radius.md },
});
