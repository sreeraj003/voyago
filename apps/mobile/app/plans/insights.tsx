import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { getOrganiserInsights } from '../../src/api/subscriptions';
import { FormMessage } from '../../src/components/Form';
import { FormScreen } from '../../src/components/FormScreen';
import { UpgradePrompt } from '../../src/components/UpgradePrompt';
import { upgradeTier } from '../../src/subscriptions/plans';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

export default function InsightsScreen() {
  const { colors } = useTheme();
  const insights = useQuery({
    queryKey: ['organiser-insights'],
    queryFn: getOrganiserInsights,
    retry: false,
  });
  const tier = upgradeTier(insights.error);
  if (insights.isPending) {
    return (
      <FormScreen>
        <FormMessage tone="info">Loading…</FormMessage>
      </FormScreen>
    );
  }
  if (tier) {
    return (
      <FormScreen>
        <UpgradePrompt tier={tier} what="Organiser insights" />
      </FormScreen>
    );
  }
  if (!insights.data) {
    return (
      <FormScreen>
        <FormMessage tone="error">Could not load your insights.</FormMessage>
      </FormScreen>
    );
  }
  const { totals, trips } = insights.data;
  const card = [styles.card, { backgroundColor: colors.surface, borderColor: colors.border }];
  return (
    <FormScreen>
      <View style={card}>
        <Text style={[styles.heading, { color: colors.text }]}>Your trips</Text>
        <Text style={[styles.body, { color: colors.text }]}>
          {totals.trips} trips · {totals.participants} people · {totals.requests} join requests
        </Text>
        <Text style={[styles.body, { color: colors.text }]}>
          Approved {totals.approvalPercent ?? 0}% of decided requests · trips{' '}
          {totals.avgFillPercent ?? 0}% full on average
        </Text>
      </View>
      {trips.length === 0 ? (
        <FormMessage tone="info">Publish a trip to see how it does.</FormMessage>
      ) : null}
      {trips.map((t) => (
        <Pressable
          key={t.tripId}
          accessibilityRole="button"
          onPress={() => router.push(`/trips/${t.tripId}`)}
        >
          <View style={card}>
            <Text style={[styles.heading, { color: colors.text }]}>{t.title}</Text>
            <Text style={[styles.muted, { color: colors.textMuted }]}>
              {new Date(t.departureAt).toLocaleDateString()} ·{' '}
              {t.status.toLowerCase().replace('_', ' ')}
            </Text>
            <Text style={[styles.body, { color: colors.text }]}>
              {t.participants} of {t.capacity} places ({t.fillPercent}%)
              {t.left > 0 ? ` · ${t.left} left` : ''}
            </Text>
            <Text style={[styles.body, { color: colors.text }]}>
              Requests: {t.requests.total} · approved {t.requests.approved} · declined{' '}
              {t.requests.rejected} · waiting {t.requests.pending}
            </Text>
            {t.avgDecisionHours !== null ? (
              <Text style={[styles.muted, { color: colors.textMuted }]}>
                You answer in {t.avgDecisionHours} hours on average
              </Text>
            ) : null}
          </View>
        </Pressable>
      ))}
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  heading: { ...typography.heading },
  body: { ...typography.body },
  muted: { ...typography.caption },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
});
