import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Community } from '@voyago/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import {
  announce,
  getCommunity,
  joinCommunity,
  leaveCommunity,
  listCommunityPosts,
  listCommunityTrips,
} from '../../../src/api/communities';
import { useFormError } from '../../../src/auth/use-form-error';
import { Choice } from '../../../src/components/Choice';
import { Button, FormMessage, TextField } from '../../../src/components/Form';
import { FormScreen } from '../../../src/components/FormScreen';
import { PostCard } from '../../../src/components/PostCard';
import { ReportForm } from '../../../src/components/ReportForm';
import { TripSummaryCard } from '../../../src/components/TripSummaryCard';
import { COMMUNITY_ROLE_LABELS, labelFor } from '../../../src/trips/labels';
import { radius, spacing, typography } from '../../../src/theme/tokens';
import { useTheme } from '../../../src/theme/use-theme';

type Tab = 'trips' | 'past' | 'posts';

export default function CommunityScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const community = useQuery({ queryKey: ['community', slug], queryFn: () => getCommunity(slug) });
  return (
    <FormScreen>
      {community.isPending ? <FormMessage tone="info">Loading community…</FormMessage> : null}
      {community.isError ? (
        <FormMessage tone="error">This community is not available.</FormMessage>
      ) : null}
      {community.data ? <CommunityDetail community={community.data} /> : null}
    </FormScreen>
  );
}

function CommunityDetail({ community }: { community: Community }) {
  const { colors } = useTheme();
  const [tab, setTab] = useState<Tab>('trips');
  const { viewer } = community;
  const actions = new Set(viewer.actions);
  const facts = [
    labelFor(community.category),
    community.city,
    community.mode === 'RIDE'
      ? 'Rides'
      : community.mode === 'TRAVEL'
        ? 'Travel'
        : 'Rides and travel',
    `${community.memberCount} ${community.memberCount === 1 ? 'member' : 'members'}`,
    community.visibility === 'PRIVATE' ? 'Private' : 'Public',
  ].filter(Boolean);
  return (
    <>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        {community.coverImageUrl ? (
          <Image
            source={{ uri: community.coverImageUrl }}
            style={styles.cover}
            accessibilityLabel={`Cover photo for ${community.name}`}
          />
        ) : null}
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
          {community.name}
        </Text>
        <Text style={[styles.caption, { color: colors.textMuted }]}>{facts.join(' · ')}</Text>
        {community.description ? (
          <Text style={[styles.body, { color: colors.text }]}>{community.description}</Text>
        ) : null}
        <Button
          title={`Owner: ${community.owner.displayName} (@${community.owner.username})`}
          variant="link"
          onPress={() => router.push(`/users/${community.owner.username}`)}
        />
        {viewer.role ? (
          <Text style={[styles.caption, { color: colors.textMuted }]}>
            You are{' '}
            {viewer.role === 'MEMBER'
              ? 'a member'
              : `the ${COMMUNITY_ROLE_LABELS[viewer.role].toLowerCase()}`}
            {viewer.role === 'ADMIN' || viewer.role === 'MODERATOR' ? ' here' : ''}.
          </Text>
        ) : null}
      </View>

      <JoinState community={community} />

      {viewer.canSeeContent ? (
        <Button
          title={actions.has('moderate') ? 'Members and requests' : 'Members'}
          variant="secondary"
          onPress={() => router.push(`/communities/${community.slug}/members`)}
        />
      ) : null}
      {actions.has('edit') ? (
        <Button
          title="Edit community"
          variant="secondary"
          onPress={() => router.push(`/communities/${community.slug}/edit`)}
        />
      ) : null}
      {viewer.status === 'ACTIVE' ? (
        <Button
          title="Plan a trip for this community"
          variant="link"
          onPress={() =>
            router.push({
              pathname: '/trips/new',
              params: { communityId: community.id, communityName: community.name },
            })
          }
        />
      ) : null}
      {actions.has('announce') ? <Announce slug={community.slug} /> : null}

      {viewer.canSeeContent ? (
        <>
          <Choice
            label="Show"
            value={tab}
            options={[
              { value: 'trips', label: 'Upcoming trips' },
              { value: 'past', label: 'Past trips' },
              { value: 'posts', label: 'Posts' },
            ]}
            onChange={setTab}
          />
          {tab === 'posts' ? (
            <Posts slug={community.slug} />
          ) : (
            <Trips slug={community.slug} when={tab === 'past' ? 'past' : 'upcoming'} />
          )}
        </>
      ) : (
        <FormMessage tone="info">
          This community is private. Its trips, posts and members are visible to members only.
        </FormMessage>
      )}
      {viewer.role === 'OWNER' ? null : (
        <ReportForm targetType="COMMUNITY" targetId={community.id} label="Report community" />
      )}
    </>
  );
}

function JoinState({ community }: { community: Community }) {
  const queryClient = useQueryClient();
  const error = useFormError();
  const [message, setMessage] = useState('');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const actions = new Set(community.viewer.actions);
  const done = (updated: Community) => {
    queryClient.setQueryData(['community', community.slug], updated);
    void queryClient.invalidateQueries({ queryKey: ['communities'] });
    void queryClient.invalidateQueries({ queryKey: ['feed'] });
    setConfirmLeave(false);
  };
  const join = useMutation({
    mutationFn: () => joinCommunity(community.slug, message),
    onMutate: () => error.clear(),
    onSuccess: done,
    onError: (caught) => error.capture(caught),
  });
  const leave = useMutation({
    mutationFn: () => leaveCommunity(community.slug),
    onMutate: () => error.clear(),
    onSuccess: done,
    onError: (caught) => error.capture(caught),
  });
  return (
    <View style={styles.actions}>
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      {community.viewer.status === 'BANNED' ? (
        <FormMessage tone="info">The moderators banned you from this community.</FormMessage>
      ) : null}
      {actions.has('join') ? (
        <Button title="Join community" loading={join.isPending} onPress={() => join.mutate()} />
      ) : null}
      {actions.has('request') ? (
        <>
          <TextField
            label="Note to the moderators (optional)"
            value={message}
            onChangeText={setMessage}
            multiline
            maxLength={500}
            error={error.fields.message}
          />
          <Button title="Ask to join" loading={join.isPending} onPress={() => join.mutate()} />
        </>
      ) : null}
      {actions.has('cancel_request') ? (
        <>
          <FormMessage tone="info">
            Request sent. A moderator will approve or decline it.
          </FormMessage>
          <Button
            title="Cancel request"
            variant="secondary"
            loading={leave.isPending}
            onPress={() => leave.mutate()}
          />
        </>
      ) : null}
      {actions.has('leave') && !confirmLeave ? (
        <Button title="Leave community" variant="link" onPress={() => setConfirmLeave(true)} />
      ) : null}
      {confirmLeave ? (
        <>
          <FormMessage tone="info">
            Leave {community.name}?{' '}
            {community.visibility === 'PRIVATE' ? 'You will need approval to come back.' : ''}
          </FormMessage>
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

function Announce({ slug }: { slug: string }) {
  const queryClient = useQueryClient();
  const error = useFormError();
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<'members' | 'everyone'>('members');
  const post = useMutation({
    mutationFn: () => announce(slug, body, audience === 'members'),
    onMutate: () => error.clear(),
    onSuccess: () => {
      setBody('');
      void queryClient.invalidateQueries({ queryKey: ['community-posts', slug] });
      void queryClient.invalidateQueries({ queryKey: ['feed'] });
    },
    onError: (caught) => error.capture(caught),
  });
  return (
    <View style={styles.actions}>
      <TextField
        label="Announcement"
        value={body}
        onChangeText={setBody}
        multiline
        maxLength={2000}
        hint="Members are notified in the app."
        error={error.fields.body}
      />
      <Choice
        label="Visible to"
        value={audience}
        options={[
          { value: 'members', label: 'Members' },
          { value: 'everyone', label: 'Everyone who can see the community' },
        ]}
        onChange={setAudience}
      />
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      {post.isSuccess && body === '' ? (
        <FormMessage tone="info">Announcement posted.</FormMessage>
      ) : null}
      <Button
        title="Post announcement"
        variant="secondary"
        loading={post.isPending}
        disabled={body.trim() === ''}
        onPress={() => post.mutate()}
      />
    </View>
  );
}

function Trips({ slug, when }: { slug: string; when: 'upcoming' | 'past' }) {
  const trips = useInfiniteQuery({
    queryKey: ['community-trips', slug, when],
    queryFn: ({ pageParam }) => listCommunityTrips(slug, when, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const items = trips.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <>
      {trips.isPending ? <FormMessage tone="info">Loading trips…</FormMessage> : null}
      {trips.isError ? <FormMessage tone="error">Could not load trips.</FormMessage> : null}
      {trips.isSuccess && items.length === 0 ? (
        <FormMessage tone="info">
          {when === 'upcoming' ? 'No upcoming trips yet.' : 'No past trips yet.'}
        </FormMessage>
      ) : null}
      {items.map((trip) => (
        <TripSummaryCard key={trip.id} trip={trip} />
      ))}
      {trips.hasNextPage ? (
        <Button
          title="Show more"
          variant="link"
          loading={trips.isFetchingNextPage}
          onPress={() => void trips.fetchNextPage()}
        />
      ) : null}
    </>
  );
}

function Posts({ slug }: { slug: string }) {
  const posts = useInfiniteQuery({
    queryKey: ['community-posts', slug],
    queryFn: ({ pageParam }) => listCommunityPosts(slug, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const items = posts.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <>
      {posts.isPending ? <FormMessage tone="info">Loading posts…</FormMessage> : null}
      {posts.isError ? <FormMessage tone="error">Could not load posts.</FormMessage> : null}
      {posts.isSuccess && items.length === 0 ? (
        <FormMessage tone="info">No posts yet.</FormMessage>
      ) : null}
      {items.map((post) => (
        <PostCard key={post.id} post={post} />
      ))}
      {posts.hasNextPage ? (
        <Button
          title="Show more"
          variant="link"
          loading={posts.isFetchingNextPage}
          onPress={() => void posts.fetchNextPage()}
        />
      ) : null}
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
  cover: { width: '100%', aspectRatio: 1200 / 630, borderRadius: radius.sm },
  title: { ...typography.title },
  body: { ...typography.body },
  caption: { ...typography.caption },
  actions: { gap: spacing.sm },
});
