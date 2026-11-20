import { useInfiniteQuery } from '@tanstack/react-query';
import { type Trip } from '@voyago/shared';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { listMyTrips } from '../../src/api/trips';
import { Button, FormMessage } from '../../src/components/Form';
import { Screen } from '../../src/components/Screen';
import { StatusBadge } from '../../src/components/StatusBadge';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

export default function CreateScreen() {
  const trips = useInfiniteQuery({
    queryKey: ['my-trips'],
    queryFn: ({ pageParam }) => listMyTrips(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const items = trips.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <Screen title="Your trips">
      <Button title="Plan a new trip" onPress={() => router.push('/trips/new')} />
      {trips.isPending ? <FormMessage tone="info">Loading your trips…</FormMessage> : null}
      {trips.isError ? <FormMessage tone="error">Could not load your trips.</FormMessage> : null}
      {trips.isSuccess && items.length === 0 ? (
        <FormMessage tone="info">
          No trips yet. Plan a ride or a getaway and invite others.
        </FormMessage>
      ) : null}
      {items.map((trip) => (
        <TripRow key={trip.id} trip={trip} />
      ))}
      {trips.hasNextPage ? (
        <Button
          title="Show more"
          variant="link"
          loading={trips.isFetchingNextPage}
          onPress={() => void trips.fetchNextPage()}
        />
      ) : null}
    </Screen>
  );
}

function TripRow({ trip }: { trip: Trip }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${trip.title}, ${trip.status.toLowerCase()}`}
      onPress={() => router.push(`/trips/${trip.id}`)}
      style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <View style={styles.rowHeader}>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {trip.title}
        </Text>
        <StatusBadge status={trip.status} />
      </View>
      <Text style={[styles.caption, { color: colors.textMuted }]}>
        {trip.mode === 'RIDE' ? 'Ride' : 'Travel'} ·{' '}
        {new Date(trip.departureAt).toLocaleDateString()} · {trip.origin.name} →{' '}
        {trip.destination.name}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  rowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  title: { ...typography.body, fontWeight: '600', flexShrink: 1 },
  caption: { ...typography.caption },
});
