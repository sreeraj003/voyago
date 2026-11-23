import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type SavedSearch, SAVED_SEARCHES_MAX } from '@voyago/shared';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  deleteSavedSearch,
  getMySubscription,
  listSavedSearches,
  runSavedSearch,
  updateSavedSearch,
} from '../../src/api/subscriptions';
import { useFormError } from '../../src/auth/use-form-error';
import { Button, FormMessage } from '../../src/components/Form';
import { FormScreen } from '../../src/components/FormScreen';
import { TripCardView } from '../../src/components/TripCardView';
import { UpgradePrompt } from '../../src/components/UpgradePrompt';
import { upgradeTier } from '../../src/subscriptions/plans';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

export default function SavedSearchesScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const searches = useQuery({ queryKey: ['saved-searches'], queryFn: listSavedSearches });
  const mine = useQuery({ queryKey: ['my-subscription'], queryFn: () => getMySubscription() });
  const entitled = mine.data?.entitlements.includes('saved_searches') ?? false;
  if (searches.isPending) {
    return (
      <FormScreen>
        <FormMessage tone="info">Loading…</FormMessage>
      </FormScreen>
    );
  }
  const items = searches.data ?? [];
  return (
    <FormScreen>
      {mine.data && !entitled ? <UpgradePrompt tier="EXPLORER_PRO" what="Saving searches" /> : null}
      {searches.isError ? (
        <FormMessage tone="error">Could not load your searches.</FormMessage>
      ) : null}
      {searches.isSuccess && items.length === 0 ? (
        <FormMessage tone="info">
          {entitled
            ? 'Nothing saved yet. Search on Explore, then tap “Save this search”.'
            : 'Saved searches you keep appear here.'}
        </FormMessage>
      ) : null}
      {items.length > 0 ? (
        <FormMessage tone="info">
          {items.length} of {SAVED_SEARCHES_MAX}. Saved searches don't keep your location.
        </FormMessage>
      ) : null}
      {items.map((s) => (
        <SavedSearchCard key={s.id} search={s} entitled={entitled} initiallyOpen={s.id === id} />
      ))}
    </FormScreen>
  );
}

function SavedSearchCard({
  search,
  entitled,
  initiallyOpen,
}: {
  search: SavedSearch;
  entitled: boolean;
  initiallyOpen: boolean;
}) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const error = useFormError();
  const [open, setOpen] = useState(initiallyOpen && entitled);
  const results = useInfiniteQuery({
    queryKey: ['saved-search-run', search.id],
    queryFn: ({ pageParam }) => runSavedSearch(search.id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    enabled: open,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['saved-searches'] });
  const toggle = useMutation({
    mutationFn: () => updateSavedSearch(search.id, { alerts: !search.alerts }),
    onMutate: () => error.clear(),
    onSuccess: refresh,
    onError: error.capture,
  });
  const remove = useMutation({
    mutationFn: () => deleteSavedSearch(search.id),
    onSuccess: refresh,
    onError: error.capture,
  });
  const trips = results.data?.pages.flatMap((p) => p.data) ?? [];
  const tier = upgradeTier(results.error);

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.heading, { color: colors.text }]}>{search.name}</Text>
      <Text style={[styles.muted, { color: colors.textMuted }]}>
        {Object.entries(search.query)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join(' · ') || 'All trips'}
      </Text>
      <Text style={[styles.muted, { color: colors.textMuted }]}>
        New-trip alerts {search.alerts ? 'on' : 'off'}
      </Text>
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      <View style={styles.row}>
        {entitled ? (
          <View style={styles.half}>
            <Button
              title={open ? 'Hide trips' : 'See trips'}
              variant="secondary"
              onPress={() => setOpen((v) => !v)}
            />
          </View>
        ) : null}
        {entitled ? (
          <View style={styles.half}>
            <Button
              title={search.alerts ? 'Turn alerts off' : 'Turn alerts on'}
              variant="secondary"
              loading={toggle.isPending}
              onPress={() => toggle.mutate()}
            />
          </View>
        ) : null}
      </View>
      <Button
        title="Delete"
        variant="link"
        loading={remove.isPending}
        onPress={() => remove.mutate()}
      />
      {open ? (
        <View style={styles.results}>
          {results.isPending ? <FormMessage tone="info">Searching…</FormMessage> : null}
          {tier ? <UpgradePrompt tier={tier} what="Saved searches" /> : null}
          {results.isSuccess && trips.length === 0 ? (
            <FormMessage tone="info">No trips match right now.</FormMessage>
          ) : null}
          {trips.map((trip) => (
            <TripCardView key={trip.id} trip={trip} />
          ))}
          {results.hasNextPage ? (
            <Button
              title="Show more"
              variant="link"
              loading={results.isFetchingNextPage}
              onPress={() => void results.fetchNextPage()}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { ...typography.heading },
  muted: { ...typography.caption },
  row: { flexDirection: 'row', gap: spacing.sm },
  half: { flex: 1 },
  results: { gap: spacing.sm },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
});
