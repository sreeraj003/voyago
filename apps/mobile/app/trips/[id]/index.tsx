import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Trip } from '@voyago/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { cancelTrip, deleteTrip, getTrip, tripAction } from '../../../src/api/trips';
import { useFormError } from '../../../src/auth/use-form-error';
import { Button, FormMessage, TextField } from '../../../src/components/Form';
import { FormScreen } from '../../../src/components/FormScreen';
import { StatusBadge } from '../../../src/components/StatusBadge';
import { formatRupees } from '../../../src/trips/trip-form';
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

  return (
    <>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <StatusBadge status={trip.status} />
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
          {trip.title}
        </Text>
        <Text style={[styles.caption, { color: colors.textMuted }]}>
          {trip.mode === 'RIDE' ? 'Ride' : 'Travel'} · organised by {trip.organiser.displayName} (@
          {trip.organiser.username}) · free community trip
        </Text>
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
        {line("Organiser's estimate", estimates || null)}
        {line('Cancelled because', trip.cancellationReason)}
      </View>
      <TripActions trip={trip} />
    </>
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
});
