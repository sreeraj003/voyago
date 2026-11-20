import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Participant } from '@voyago/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  listParticipants,
  removeParticipant,
  setParticipantRole,
} from '../../../src/api/participation';
import { getTrip } from '../../../src/api/trips';
import { useFormError } from '../../../src/auth/use-form-error';
import { Button, FormMessage, TextField } from '../../../src/components/Form';
import { FormScreen } from '../../../src/components/FormScreen';
import { radius, spacing, typography } from '../../../src/theme/tokens';
import { useTheme } from '../../../src/theme/use-theme';

/**
 * Who is going. The organiser and co-organisers can remove participants; only the organiser
 * appoints co-organisers or removes them.
 */
export default function PeopleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const trip = useQuery({ queryKey: ['trip', id], queryFn: () => getTrip(id) });
  const people = useQuery({ queryKey: ['participants', id], queryFn: () => listParticipants(id) });
  const manages = trip.data?.viewer.actions.includes('manage_people') === true;
  const isOrganiser = trip.data?.viewer.isOrganiser === true;
  return (
    <FormScreen>
      {people.isPending ? <FormMessage tone="info">Loading…</FormMessage> : null}
      {people.isError ? (
        <FormMessage tone="error">Only people on this trip can see who is going.</FormMessage>
      ) : null}
      {people.data?.map((person) => (
        <Person
          key={person.user.id}
          tripId={id}
          person={person}
          canRemove={manages && (isOrganiser || person.role === 'PARTICIPANT')}
          canAppoint={isOrganiser && manages}
        />
      ))}
    </FormScreen>
  );
}

function Person({
  tripId,
  person,
  canRemove,
  canAppoint,
}: {
  tripId: string;
  person: Participant;
  canRemove: boolean;
  canAppoint: boolean;
}) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const error = useFormError();
  const [removing, setRemoving] = useState(false);
  const [reason, setReason] = useState('');
  const remove = useMutation({
    mutationFn: () => removeParticipant(tripId, person.user.id, reason),
    onMutate: () => error.clear(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['participants', tripId] });
      void queryClient.invalidateQueries({ queryKey: ['trip', tripId] });
    },
    onError: (caught) => error.capture(caught),
  });
  const appoint = useMutation({
    mutationFn: () =>
      setParticipantRole(
        tripId,
        person.user.id,
        person.role === 'CO_ORGANISER' ? 'PARTICIPANT' : 'CO_ORGANISER',
      ),
    onMutate: () => error.clear(),
    onSuccess: (people) => queryClient.setQueryData(['participants', tripId], people),
    onError: (caught) => error.capture(caught),
  });
  const isOrganiser = person.role === 'ORGANISER';
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Button
        title={`${person.user.displayName} (@${person.user.username})`}
        variant="link"
        onPress={() => router.push(`/users/${person.user.username}`)}
      />
      <Text style={[styles.caption, { color: colors.textMuted }]}>
        {isOrganiser
          ? 'Organiser'
          : `${person.role === 'CO_ORGANISER' ? 'Co-organiser · ' : ''}Joined ${new Date(person.joinedAt).toLocaleDateString()}`}
      </Text>
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      {canAppoint && !isOrganiser && person.status === 'ACTIVE' ? (
        <Button
          title={person.role === 'CO_ORGANISER' ? 'Remove co-organiser role' : 'Make co-organiser'}
          variant="link"
          loading={appoint.isPending}
          onPress={() => appoint.mutate()}
        />
      ) : null}
      {canRemove && !isOrganiser && !removing ? (
        <Button
          title={`Remove ${person.user.displayName}`}
          variant="link"
          onPress={() => setRemoving(true)}
        />
      ) : null}
      {removing ? (
        <>
          <TextField
            label="Reason (optional)"
            value={reason}
            onChangeText={setReason}
            hint="Shown to them, and kept in the moderation record."
            error={error.fields.reason}
          />
          <Button
            title="Remove from trip"
            variant="secondary"
            loading={remove.isPending}
            onPress={() => remove.mutate()}
          />
          <Button title="Keep" variant="link" onPress={() => setRemoving(false)} />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  caption: { ...typography.caption },
});
