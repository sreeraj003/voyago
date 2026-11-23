import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type PublicProfile } from '@voyago/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { openDirectChat } from '../../src/api/chat';
import { getMyProfile } from '../../src/api/profile';
import { block, follow, getPublicProfile, unfollow } from '../../src/api/social';
import { useFormError } from '../../src/auth/use-form-error';
import { Button, FormMessage } from '../../src/components/Form';
import { FormScreen } from '../../src/components/FormScreen';
import { OpenChatButton } from '../../src/components/OpenChatButton';
import { ReportForm } from '../../src/components/ReportForm';
import { labelFor } from '../../src/trips/labels';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';
import { ACCENT_HEX } from '../../src/subscriptions/plans';

export default function UserProfileScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const profile = useQuery({
    queryKey: ['profile', username],
    queryFn: () => getPublicProfile(username),
  });
  return (
    <FormScreen>
      {profile.isPending ? <FormMessage tone="info">Loading…</FormMessage> : null}
      {profile.isError ? (
        <FormMessage tone="error">This profile is not available.</FormMessage>
      ) : null}
      {profile.data ? <Profile profile={profile.data} /> : null}
    </FormScreen>
  );
}

function Profile({ profile }: { profile: PublicProfile }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const error = useFormError();
  const [confirmBlock, setConfirmBlock] = useState(false);
  const me = useQuery({ queryKey: ['me'], queryFn: getMyProfile });
  const isSelf = me.data?.id === profile.id;
  const { follow: state } = profile;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['profile', profile.username] });
    void queryClient.invalidateQueries({ queryKey: ['feed'] });
  };
  const toggle = useMutation({
    mutationFn: () => (state.isFollowing ? unfollow(profile.username) : follow(profile.username)),
    onMutate: () => error.clear(),
    onSuccess: refresh,
    onError: (caught) => error.capture(caught),
  });
  const blockUser = useMutation({
    mutationFn: () => block(profile.username),
    onMutate: () => error.clear(),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      router.back();
    },
    onError: (caught) => error.capture(caught),
  });
  const line = (label: string, value: string | null) =>
    value ? (
      <Text style={[styles.body, { color: colors.text }]}>
        <Text style={styles.bold}>{label}: </Text>
        {value}
      </Text>
    ) : null;

  return (
    <>
      <View
        style={[
          styles.card,
          { backgroundColor: colors.surface, borderColor: colors.border },
          profile.style.accentColor
            ? { borderTopWidth: 6, borderTopColor: ACCENT_HEX[profile.style.accentColor] }
            : null,
        ]}
      >
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
          {profile.displayName}
        </Text>
        {profile.style.headline ? (
          <Text style={[styles.body, styles.bold, { color: colors.text }]}>
            {profile.style.headline}
          </Text>
        ) : null}
        <Text style={[styles.caption, { color: colors.textMuted }]}>
          @{profile.username} · {state.followerCount}{' '}
          {state.followerCount === 1 ? 'follower' : 'followers'} · {state.followingCount} following
        </Text>
        {state.mutual ? (
          <Text style={[styles.caption, { color: colors.textMuted }]}>You follow each other</Text>
        ) : state.followsYou ? (
          <Text style={[styles.caption, { color: colors.textMuted }]}>Follows you</Text>
        ) : null}
        {profile.limited ? (
          <FormMessage tone="info">
            {profile.displayName} shares their profile with followers only.
          </FormMessage>
        ) : (
          <>
            {profile.bio ? (
              <Text style={[styles.body, { color: colors.text }]}>{profile.bio}</Text>
            ) : null}
            {line('City', profile.homeCity)}
            {line('Languages', profile.languages.join(', ') || null)}
            {line(
              'Rides',
              profile.motorcycles
                .map((bike) => `${bike.make} ${bike.model} (${labelFor(bike.category)})`)
                .join(', ') || null,
            )}
            {line('Interests', profile.interests.join(', ') || null)}
          </>
        )}
        <Text style={[styles.caption, { color: colors.textMuted }]}>
          Member since {new Date(profile.memberSince).toLocaleDateString()}
          {profile.verification.email || profile.verification.phone ? ' · verified contact' : ''}
        </Text>
      </View>

      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      {isSelf ? null : (
        <>
          <Button
            title={state.isFollowing ? 'Following ✓ (tap to unfollow)' : 'Follow'}
            variant={state.isFollowing ? 'secondary' : 'primary'}
            loading={toggle.isPending}
            onPress={() => toggle.mutate()}
          />
          {profile.canMessage ? (
            <OpenChatButton title="Message" open={() => openDirectChat(profile.username)} />
          ) : null}
          {!confirmBlock ? (
            <Button title="Block" variant="link" onPress={() => setConfirmBlock(true)} />
          ) : (
            <>
              <FormMessage tone="info">
                Block @{profile.username}? You won’t see each other’s profiles, trips or posts, and
                follows between you are removed. They are not told.
              </FormMessage>
              <Button
                title="Yes, block"
                variant="secondary"
                loading={blockUser.isPending}
                onPress={() => blockUser.mutate()}
              />
              <Button title="Cancel" variant="link" onPress={() => setConfirmBlock(false)} />
            </>
          )}
          <ReportForm targetType="USER" targetId={profile.id} label="Report profile" />
        </>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  title: { ...typography.title },
  body: { ...typography.body },
  bold: { fontWeight: '600' },
  caption: { ...typography.caption },
});
