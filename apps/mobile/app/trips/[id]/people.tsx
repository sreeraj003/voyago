import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Participant } from '@voyago/shared';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { listParticipants, removeParticipant } from '../../../src/api/participation';
import { getTrip } from '../../../src/api/trips';
import { useFormError } from '../../../src/auth/use-form-error';
import { Button, FormMessage, TextField } from '../../../src/components/Form';
import { FormScreen } from '../../../src/components/FormScreen';
import { radius, spacing, typography } from '../../../src/theme/tokens';
import { useTheme } from '../../../src/theme/use-theme';

/** Who is going. The organiser can remove people from here. */
export default function PeopleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const trip = useQuery({ queryKey: ['trip', id], queryFn: () => getTrip(id) });
  const people = useQuery({ queryKey: ['participants', id], queryFn: () => listParticipants(id) });
  const canRemove =
    trip.data?.viewer.isOrganiser === true &&
    !['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(trip.data.status);
  return (
    <FormScreen>
      {people.isPending ? <FormMessage tone="info">Loading…</FormMessage> : null}
      {people.isError ? (
        <FormMessage tone="error">Only people on this trip can see who is going.</FormMessage>
      ) : null}
      {people.data?.map((person) => (
        <Person key={person.user.id} tripId={id} person={person} canRemove={canRemove} />
      ))}
    </FormScreen>
  );
}

function Person({
  tripId,
  person,
  canRemove,
}: {
  tripId: string;
  person: Participant;
  canRemove: boolean;
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
  const isOrganiser = person.role === 'ORGANISER';
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.name, { color: colors.text }]}>
        {person.user.displayName} (@{person.user.username})
      </Text>
      <Text style={[styles.caption, { color: colors.textMuted }]}>
        {isOrganiser ? 'Organiser' : `Joined ${new Date(person.joinedAt).toLocaleDateString()}`}
      </Text>
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
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
  name: { ...typography.body, fontWeight: '600' },
  caption: { ...typography.caption },
});
