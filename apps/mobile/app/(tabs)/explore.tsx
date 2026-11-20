import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { type TripCard } from '@voyago/shared';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { popularDestinations, searchTrips, trendingTrips } from '../../src/api/discovery';
import { Choice } from '../../src/components/Choice';
import { CommunityExplorer } from '../../src/components/CommunityExplorer';
import { FilterSheet } from '../../src/components/FilterSheet';
import { Button, FormMessage, TextField } from '../../src/components/Form';
import { Screen } from '../../src/components/Screen';
import { TripCardSkeleton, TripCardView } from '../../src/components/TripCardView';
import { TripMap } from '../../src/components/TripMap';
import {
  activeFilterCount,
  defaultFilters,
  type DiscoveryFilters,
  toSearchQuery,
} from '../../src/discovery/filters';
import { useNearMe } from '../../src/discovery/use-location';
import { useModeStore } from '../../src/store/mode-store';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

export default function ExploreScreen() {
  const params = useLocalSearchParams<{ tab?: string; mine?: string }>();
  const mode = useModeStore((state) => state.mode);
  const setMode = useModeStore((state) => state.setMode);
  const [section, setSection] = useState<'trips' | 'communities'>(
    params.tab === 'communities' ? 'communities' : 'trips',
  );
  return (
    <Screen title="Explore">
      <Choice
        label="Showing"
        value={mode}
        options={[
          { value: 'RIDE', label: 'Rides' },
          { value: 'TRAVEL', label: 'Travel' },
        ]}
        onChange={setMode}
      />
      <Choice
        label="Looking for"
        value={section}
        options={[
          { value: 'trips', label: 'Trips' },
          { value: 'communities', label: 'Communities' },
        ]}
        onChange={setSection}
      />
      {section === 'communities' ? (
        <CommunityExplorer
          key={params.mine ?? 'all'}
          mode={mode}
          initialMine={params.mine === '1'}
        />
      ) : (
        <TripExplorer mode={mode} />
      )}
    </Screen>
  );
}

function TripExplorer({ mode }: { mode: 'RIDE' | 'TRAVEL' }) {
  const { colors } = useTheme();
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filters, setFilters] = useState<DiscoveryFilters>(defaultFilters);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [view, setView] = useState<'list' | 'map'>('list');
  const nearMe = useNearMe();

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text), 300);
    return () => clearTimeout(timer);
  }, [text]);

  const query = useMemo(
    () => toSearchQuery({ text: debounced, mode, filters, location: nearMe.point }),
    [debounced, mode, filters, nearMe.point],
  );
  const results = useInfiniteQuery({
    queryKey: ['discovery', 'search', query],
    queryFn: ({ pageParam }) => searchTrips(query, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const trips = results.data?.pages.flatMap((page) => page.data) ?? [];
  const filterCount = activeFilterCount(filters);
  const browsing = debounced.trim() === '' && filterCount === 0;

  const clearAll = () => {
    setText('');
    setDebounced('');
    setFilters(defaultFilters());
  };

  return (
    <>
      <TextField
        label="Search trips"
        value={text}
        onChangeText={setText}
        placeholder={mode === 'RIDE' ? 'Nandi Hills, Coorg, sunrise…' : 'Trek, Gokarna, homestay…'}
        returnKeyType="search"
        autoCorrect={false}
      />

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.bar}
      >
        <Pill
          label={
            nearMe.state.status === 'on'
              ? 'Near me ✓'
              : nearMe.state.status === 'asking'
                ? 'Finding you…'
                : 'Near me'
          }
          selected={nearMe.state.status === 'on'}
          onPress={() => (nearMe.state.status === 'on' ? nearMe.disable() : void nearMe.enable())}
          hint={
            nearMe.state.status === 'on'
              ? 'Stop using your location'
              : 'Asks for your location to show trips meeting near you'
          }
        />
        <Pill
          label={filterCount > 0 ? `Filters (${filterCount})` : 'Filters'}
          selected={filterCount > 0}
          onPress={() => setSheetOpen(true)}
        />
        <Pill label="List" selected={view === 'list'} onPress={() => setView('list')} />
        <Pill label="Map" selected={view === 'map'} onPress={() => setView('map')} />
      </ScrollView>

      {nearMe.state.status === 'denied' ? (
        <FormMessage tone="info">
          Location is off, so trips aren't sorted by distance. You can still search by place name.
        </FormMessage>
      ) : null}
      {nearMe.state.status === 'denied' && !nearMe.state.canAskAgain ? (
        <Button
          title="Allow location in Settings"
          variant="link"
          onPress={() => void Linking.openSettings()}
        />
      ) : null}
      {nearMe.state.status === 'error' ? (
        <FormMessage tone="error">{nearMe.state.message}</FormMessage>
      ) : null}

      {browsing ? <Highlights mode={mode} onDestination={setText} near={nearMe.point} /> : null}

      <Text accessibilityRole="header" style={[styles.section, { color: colors.text }]}>
        {browsing ? 'Upcoming trips' : 'Results'}
      </Text>

      {results.isPending ? (
        <>
          <TripCardSkeleton />
          <TripCardSkeleton />
          <TripCardSkeleton />
        </>
      ) : null}
      {results.isError ? (
        <>
          <FormMessage tone="error">Could not load trips.</FormMessage>
          <Button title="Try again" variant="secondary" onPress={() => void results.refetch()} />
        </>
      ) : null}
      {results.isSuccess && trips.length === 0 ? (
        <EmptyState canClear={!browsing} onClear={clearAll} />
      ) : null}

      {view === 'map' && trips.length > 0 ? (
        <TripMap trips={trips} centre={nearMe.point} />
      ) : (
        trips.map((trip) => <TripCardView key={trip.id} trip={trip} />)
      )}

      {results.hasNextPage ? (
        <Button
          title="Show more"
          variant="link"
          loading={results.isFetchingNextPage}
          onPress={() => void results.fetchNextPage()}
        />
      ) : null}
      {!browsing && trips.length > 0 ? (
        <Button title="Clear search and filters" variant="link" onPress={clearAll} />
      ) : null}

      <FilterSheet
        visible={sheetOpen}
        mode={mode}
        hasLocation={nearMe.point !== null}
        value={filters}
        onApply={(next) => {
          setFilters(next);
          setSheetOpen(false);
        }}
        onClose={() => setSheetOpen(false)}
      />
    </>
  );
}

function Highlights({
  mode,
  near,
  onDestination,
}: {
  mode: 'RIDE' | 'TRAVEL';
  near: { latitude: number; longitude: number } | null;
  onDestination: (name: string) => void;
}) {
  const { colors } = useTheme();
  const trending = useQuery({
    queryKey: ['discovery', 'trending', mode, near],
    queryFn: () => trendingTrips(mode, near),
  });
  const destinations = useQuery({
    queryKey: ['discovery', 'destinations', mode],
    queryFn: () => popularDestinations(mode),
  });
  const hot: TripCard[] = (trending.data?.data ?? []).filter((trip) =>
    trip.matchReasons.some((reason) => reason.endsWith('joined this week')),
  );
  return (
    <>
      {destinations.data && destinations.data.data.length > 0 ? (
        <View style={styles.block}>
          <Text accessibilityRole="header" style={[styles.section, { color: colors.text }]}>
            Popular destinations
          </Text>
          <View style={styles.wrapRow}>
            {destinations.data.data.map((place) => (
              <Pill
                key={place.name}
                label={`${place.name} (${place.tripCount})`}
                onPress={() => onDestination(place.name)}
                hint={`Search trips to ${place.name}`}
              />
            ))}
          </View>
        </View>
      ) : null}
      {hot.length > 0 ? (
        <View style={styles.block}>
          <Text accessibilityRole="header" style={[styles.section, { color: colors.text }]}>
            Trending this week
          </Text>
          {hot.slice(0, 3).map((trip) => (
            <TripCardView key={trip.id} trip={trip} />
          ))}
        </View>
      ) : null}
    </>
  );
}

function EmptyState({ canClear, onClear }: { canClear: boolean; onClear: () => void }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.empty, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <Text style={[styles.section, { color: colors.text }]}>No trips found</Text>
      <Text style={[styles.caption, { color: colors.textMuted }]}>
        {canClear
          ? 'Try fewer filters, another place name or a wider distance.'
          : 'No upcoming public trips yet. Plan one from the Create tab and others can find it here.'}
      </Text>
      {canClear ? <Button title="Clear filters" variant="secondary" onPress={onClear} /> : null}
    </View>
  );
}

function Pill({
  label,
  selected = false,
  onPress,
  hint,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  hint?: string;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[
        styles.pill,
        {
          borderColor: selected ? colors.travel : colors.border,
          backgroundColor: selected ? colors.travel : colors.surface,
        },
      ]}
    >
      <Text style={{ color: selected ? colors.onAccent : colors.text }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { gap: spacing.sm },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  block: { gap: spacing.sm },
  section: { ...typography.heading },
  caption: { ...typography.caption },
  pill: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    minHeight: 44,
    justifyContent: 'center',
  },
  empty: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
});
