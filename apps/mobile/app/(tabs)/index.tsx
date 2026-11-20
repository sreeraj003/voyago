import { useInfiniteQuery } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { getFeed } from '../../src/api/social';
import { useFeatures } from '../../src/api/use-features';
import { Button, FormMessage } from '../../src/components/Form';
import { ModeSelector } from '../../src/components/ModeSelector';
import { PostCard } from '../../src/components/PostCard';
import { TripSummaryCard } from '../../src/components/TripSummaryCard';
import { Screen } from '../../src/components/Screen';
import { useModeStore } from '../../src/store/mode-store';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

export default function HomeScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const mode = useModeStore((state) => state.mode);
  const accent = mode === 'RIDE' ? colors.ride : colors.travel;

  const actions: { label: string; href: Href; primary: boolean }[] = [
    mode === 'RIDE'
      ? { label: 'Find a Ride', href: '/explore', primary: true }
      : { label: 'Find Travel Buddies', href: '/explore', primary: true },
    { label: 'Create a Trip', href: '/create', primary: false },
  ];

  return (
    <Screen title="Voyago">
      <Text style={[styles.tagline, { color: colors.textMuted }]}>
        {mode === 'RIDE'
          ? 'Group rides from Bengaluru, with riders like you.'
          : 'Find people heading where you are going.'}
      </Text>
      <ModeSelector />
      <View style={styles.actions}>
        {actions.map((action) => (
          <Pressable
            key={action.label}
            accessibilityRole="button"
            onPress={() => router.navigate(action.href)}
            style={[
              styles.action,
              action.primary
                ? { backgroundColor: accent }
                : { borderColor: accent, borderWidth: 1.5 },
            ]}
          >
            <Text
              style={[styles.actionLabel, { color: action.primary ? colors.onAccent : accent }]}
            >
              {action.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <Feed />
    </Screen>
  );
}

/** Chronological: posts and new trips from people you follow, your own and your communities. */
function Feed() {
  const { colors } = useTheme();
  const router = useRouter();
  const features = useFeatures();
  const feed = useInfiniteQuery({
    queryKey: ['feed'],
    queryFn: ({ pageParam }) => getFeed(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const items = feed.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <View style={styles.feed}>
      <Text accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>
        Your feed
      </Text>
      <Button
        title={features.coverUploads ? 'Share destination photos' : 'Share a post'}
        variant="link"
        onPress={() => router.push('/posts/new')}
      />
      {feed.isPending ? <FormMessage tone="info">Loading your feed…</FormMessage> : null}
      {feed.isError ? (
        <>
          <FormMessage tone="error">Could not load your feed.</FormMessage>
          <Button title="Try again" variant="secondary" onPress={() => void feed.refetch()} />
        </>
      ) : null}
      {feed.isSuccess && items.length === 0 ? (
        <FormMessage tone="info">
          Follow riders and travellers, or join a community, and their trips and posts show up here.
        </FormMessage>
      ) : null}
      {items.map((item) =>
        item.kind === 'post' ? (
          <PostCard key={`post-${item.post.id}`} post={item.post} />
        ) : (
          <TripSummaryCard key={`trip-${item.trip.id}`} trip={item.trip} kicker="NEW TRIP" />
        ),
      )}
      {feed.hasNextPage ? (
        <Button
          title="Show more"
          variant="link"
          loading={feed.isFetchingNextPage}
          onPress={() => void feed.fetchNextPage()}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tagline: { ...typography.body },
  actions: { gap: spacing.sm },
  action: { borderRadius: radius.md, paddingVertical: spacing.md, alignItems: 'center' },
  actionLabel: { ...typography.body, fontWeight: '700' },
  feed: { gap: spacing.sm },
  heading: { ...typography.heading },
});
