import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { type JoinRequest } from '@voyago/shared';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { approveRequest, listTripRequests, rejectRequest } from '../../../src/api/participation';
import { bulkJoinRequests } from '../../../src/api/subscriptions';
import { UpgradePrompt } from '../../../src/components/UpgradePrompt';
import { upgradeTier } from '../../../src/subscriptions/plans';
import { useFormError } from '../../../src/auth/use-form-error';
import { Button, FormMessage, TextField } from '../../../src/components/Form';
import { FormScreen } from '../../../src/components/FormScreen';
import { radius, spacing, typography } from '../../../src/theme/tokens';
import { useTheme } from '../../../src/theme/use-theme';

/** The organiser's queue of pending join requests. */
export default function JoinRequestsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const requests = useInfiniteQuery({
    queryKey: ['join-requests', id],
    queryFn: ({ pageParam }) => listTripRequests(id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const items = requests.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <FormScreen>
      {requests.isPending ? <FormMessage tone="info">Loading requests…</FormMessage> : null}
      {requests.isError ? (
        <FormMessage tone="error">Could not load the requests.</FormMessage>
      ) : null}
      {requests.isSuccess && items.length === 0 ? (
        <FormMessage tone="info">
          No requests waiting. New ones also appear in your inbox.
        </FormMessage>
      ) : null}
      {items.length > 1 ? <ApproveAll tripId={id} requests={items} /> : null}
      {items.map((request) => (
        <RequestCard key={request.id} tripId={id} request={request} />
      ))}
      {requests.hasNextPage ? (
        <Button
          title="Show more"
          variant="link"
          loading={requests.isFetchingNextPage}
          onPress={() => void requests.fetchNextPage()}
        />
      ) : null}
    </FormScreen>
  );
}

/** Approves every request shown at once (Organiser Pro); each is checked like a single one. */
function ApproveAll({ tripId, requests }: { tripId: string; requests: JoinRequest[] }) {
  const queryClient = useQueryClient();
  const bulk = useMutation({
    mutationFn: () =>
      bulkJoinRequests(tripId, {
        action: 'approve',
        requestIds: requests.slice(0, 50).map((r) => r.id),
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['join-requests', tripId] });
      void queryClient.invalidateQueries({ queryKey: ['trip', tripId] });
    },
  });
  const tier = upgradeTier(bulk.error);
  return (
    <>
      <Button
        title={`Approve all ${Math.min(requests.length, 50)}`}
        variant="secondary"
        loading={bulk.isPending}
        onPress={() => bulk.mutate()}
      />
      {tier ? <UpgradePrompt tier={tier} what="Approving many at once" /> : null}
      {bulk.data ? (
        <FormMessage tone="info">
          Approved {bulk.data.done.length}.
          {bulk.data.failed.length > 0
            ? ` Not approved: ${bulk.data.failed.length} (${bulk.data.failed[0]!.reason}).`
            : ''}
        </FormMessage>
      ) : null}
    </>
  );
}

function RequestCard({ tripId, request }: { tripId: string; request: JoinRequest }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const error = useFormError();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ['join-requests', tripId] });
    void queryClient.invalidateQueries({ queryKey: ['trip', tripId] });
  };
  const approve = useMutation({
    mutationFn: () => approveRequest(request.id),
    onMutate: () => error.clear(),
    onSuccess: done,
    onError: (caught) => error.capture(caught),
  });
  const reject = useMutation({
    mutationFn: () => rejectRequest(request.id, reason),
    onMutate: () => error.clear(),
    onSuccess: done,
    onError: (caught) => error.capture(caught),
  });

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.name, { color: colors.text }]}>
        {request.requester.displayName} (@{request.requester.username})
      </Text>
      <Text style={[styles.caption, { color: colors.textMuted }]}>
        Asked {new Date(request.createdAt).toLocaleString()}
      </Text>
      {request.message ? (
        <Text style={[styles.body, { color: colors.text }]}>“{request.message}”</Text>
      ) : null}
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      {declining ? (
        <>
          <TextField
            label="Reason (optional)"
            value={reason}
            onChangeText={setReason}
            hint="Shown to the member."
            error={error.fields.reason}
          />
          <Button
            title="Decline request"
            variant="secondary"
            loading={reject.isPending}
            onPress={() => reject.mutate()}
          />
          <Button title="Back" variant="link" onPress={() => setDeclining(false)} />
        </>
      ) : (
        <View style={styles.row}>
          <View style={styles.half}>
            <Button title="Approve" loading={approve.isPending} onPress={() => approve.mutate()} />
          </View>
          <View style={styles.half}>
            <Button title="Decline" variant="secondary" onPress={() => setDeclining(true)} />
          </View>
        </View>
      )}
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
  name: { ...typography.body, fontWeight: '600' },
  body: { ...typography.body },
  caption: { ...typography.caption },
  row: { flexDirection: 'row', gap: spacing.sm },
  half: { flex: 1 },
});
