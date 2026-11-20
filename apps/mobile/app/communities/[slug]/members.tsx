import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Community, type CommunityMember, COMMUNITY_ROLE_RANK } from '@voyago/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  getCommunity,
  listMembers,
  moderateMember,
  removeMember,
  setMemberRole,
} from '../../../src/api/communities';
import { useFormError } from '../../../src/auth/use-form-error';
import { Choice } from '../../../src/components/Choice';
import { Button, FormMessage, TextField } from '../../../src/components/Form';
import { FormScreen } from '../../../src/components/FormScreen';
import { COMMUNITY_ROLE_LABELS } from '../../../src/trips/labels';
import { radius, spacing, typography } from '../../../src/theme/tokens';
import { useTheme } from '../../../src/theme/use-theme';

type Status = 'ACTIVE' | 'PENDING' | 'BANNED';

/** Members; moderators also see requests and bans, and act on people below their rank. */
export default function MembersScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const community = useQuery({ queryKey: ['community', slug], queryFn: () => getCommunity(slug) });
  const [status, setStatus] = useState<Status>('ACTIVE');
  const moderates = community.data?.viewer.actions.includes('moderate') ?? false;
  const members = useInfiniteQuery({
    queryKey: ['community-members', slug, status],
    queryFn: ({ pageParam }) => listMembers(slug, status, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    enabled: community.isSuccess,
  });
  const items = members.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <FormScreen>
      {moderates ? (
        <Choice
          label="Show"
          value={status}
          options={[
            { value: 'ACTIVE', label: 'Members' },
            { value: 'PENDING', label: 'Requests' },
            { value: 'BANNED', label: 'Banned' },
          ]}
          onChange={setStatus}
        />
      ) : null}
      {members.isPending ? <FormMessage tone="info">Loading…</FormMessage> : null}
      {members.isError ? (
        <FormMessage tone="error">Only members can see who is in this community.</FormMessage>
      ) : null}
      {members.isSuccess && items.length === 0 ? (
        <FormMessage tone="info">
          {status === 'PENDING'
            ? 'No requests waiting.'
            : status === 'BANNED'
              ? 'Nobody is banned.'
              : 'No members yet.'}
        </FormMessage>
      ) : null}
      {community.data
        ? items.map((member) => (
            <MemberRow key={member.user.id} community={community.data} member={member} />
          ))
        : null}
      {members.hasNextPage ? (
        <Button
          title="Show more"
          variant="link"
          loading={members.isFetchingNextPage}
          onPress={() => void members.fetchNextPage()}
        />
      ) : null}
    </FormScreen>
  );
}

function MemberRow({ community, member }: { community: Community; member: CommunityMember }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const error = useFormError();
  const [removing, setRemoving] = useState(false);
  const [reason, setReason] = useState('');
  const myRank = community.viewer.role ? COMMUNITY_ROLE_RANK[community.viewer.role] : 0;
  const theirRank = COMMUNITY_ROLE_RANK[member.role];
  const below = myRank > theirRank;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['community-members', community.slug] });
    void queryClient.invalidateQueries({ queryKey: ['community', community.slug] });
    setRemoving(false);
    setReason('');
  };
  const act = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onMutate: () => error.clear(),
    onSuccess: refresh,
    onError: (caught) => error.capture(caught),
  });
  const id = member.user.id;
  const roles = (['ADMIN', 'MODERATOR', 'MEMBER'] as const).filter(
    (role) => COMMUNITY_ROLE_RANK[role] < myRank && role !== member.role,
  );

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Button
        title={`${member.user.displayName} (@${member.user.username})`}
        variant="link"
        onPress={() => router.push(`/users/${member.user.username}`)}
      />
      <Text style={[styles.caption, { color: colors.textMuted }]}>
        {COMMUNITY_ROLE_LABELS[member.role]} · {member.status === 'PENDING' ? 'asked' : 'since'}{' '}
        {new Date(member.joinedAt).toLocaleDateString()}
      </Text>
      {member.message ? (
        <Text style={[styles.body, { color: colors.text }]}>“{member.message}”</Text>
      ) : null}
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}

      {member.status === 'PENDING' && myRank >= COMMUNITY_ROLE_RANK.MODERATOR ? (
        <>
          <Button
            title="Approve"
            loading={act.isPending}
            onPress={() => act.mutate(() => moderateMember(community.slug, id, 'approve'))}
          />
          <Button
            title="Decline"
            variant="secondary"
            onPress={() => act.mutate(() => moderateMember(community.slug, id, 'reject'))}
          />
        </>
      ) : null}
      {member.status === 'BANNED' && myRank >= COMMUNITY_ROLE_RANK.ADMIN ? (
        <Button
          title="Lift ban"
          variant="secondary"
          onPress={() => act.mutate(() => moderateMember(community.slug, id, 'unban'))}
        />
      ) : null}
      {member.status === 'ACTIVE' && below && myRank >= COMMUNITY_ROLE_RANK.ADMIN
        ? roles.map((role) => (
            <Button
              key={role}
              title={
                role === 'MEMBER'
                  ? 'Make a regular member'
                  : `Make ${COMMUNITY_ROLE_LABELS[role].toLowerCase()}`
              }
              variant="link"
              onPress={() => act.mutate(() => setMemberRole(community.slug, id, role))}
            />
          ))
        : null}
      {member.status === 'ACTIVE' &&
      below &&
      myRank >= COMMUNITY_ROLE_RANK.MODERATOR &&
      !removing ? (
        <Button title="Remove…" variant="link" onPress={() => setRemoving(true)} />
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
            title="Remove"
            variant="secondary"
            loading={act.isPending}
            onPress={() => act.mutate(() => removeMember(community.slug, id, reason, false))}
          />
          <Button
            title="Remove and ban"
            variant="secondary"
            onPress={() => act.mutate(() => removeMember(community.slug, id, reason, true))}
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
  body: { ...typography.body },
  caption: { ...typography.caption },
});
