import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  inviteToTrip,
  listTripInvitations,
  respondToInvitation,
} from '../../../src/api/participation';
import { getTrip } from '../../../src/api/trips';
import { useFormError } from '../../../src/auth/use-form-error';
import { Button, FormMessage, TextField } from '../../../src/components/Form';
import { FormScreen } from '../../../src/components/FormScreen';
import { radius, spacing, typography } from '../../../src/theme/tokens';
import { useTheme } from '../../../src/theme/use-theme';

/** Organisers and co-organisers invite people by username. Private trips are invite-only. */
export default function InviteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const error = useFormError();
  const [username, setUsername] = useState('');
  const trip = useQuery({ queryKey: ['trip', id], queryFn: () => getTrip(id) });
  const invitations = useQuery({
    queryKey: ['trip-invitations', id],
    queryFn: () => listTripInvitations(id),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['trip-invitations', id] });
  const invite = useMutation({
    mutationFn: () => inviteToTrip(id, username),
    onMutate: () => error.clear(),
    onSuccess: () => {
      setUsername('');
      refresh();
    },
    onError: (caught) => error.capture(caught),
  });
  const revoke = useMutation({
    mutationFn: (invitationId: string) => respondToInvitation(invitationId, 'revoke'),
    onSuccess: refresh,
    onError: (caught) => error.capture(caught),
  });
  return (
    <FormScreen>
      <FormMessage tone="info">
        {trip.data?.visibility === 'PRIVATE'
          ? 'This trip is private: only people you invite can see it and join.'
          : 'Invited people can join straight away, without a request.'}
      </FormMessage>
      <TextField
        label="Username"
        value={username}
        onChangeText={setUsername}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="@rider_name"
        error={error.fields.username}
      />
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      {invite.isSuccess && username === '' ? (
        <FormMessage tone="info">Invitation sent.</FormMessage>
      ) : null}
      <Button
        title="Send invitation"
        loading={invite.isPending}
        disabled={username.trim().length < 3}
        onPress={() => invite.mutate()}
      />
      <Text accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>
        Waiting for an answer
      </Text>
      {invitations.data?.data.length === 0 ? (
        <FormMessage tone="info">No open invitations.</FormMessage>
      ) : null}
      {invitations.data?.data.map((invitation) => (
        <View
          key={invitation.id}
          style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <Text style={[styles.body, { color: colors.text }]}>
            {invitation.invitee.displayName} (@{invitation.invitee.username})
          </Text>
          <Text style={[styles.caption, { color: colors.textMuted }]}>
            Invited {new Date(invitation.createdAt).toLocaleDateString()}
            {invitation.invitedBy ? ` by @${invitation.invitedBy.username}` : ''}
          </Text>
          <Button
            title="Withdraw invitation"
            variant="link"
            onPress={() => revoke.mutate(invitation.id)}
          />
        </View>
      ))}
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  heading: { ...typography.heading },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  body: { ...typography.body, fontWeight: '600' },
  caption: { ...typography.caption },
});
