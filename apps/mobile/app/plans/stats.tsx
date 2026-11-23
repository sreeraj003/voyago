import { useQuery } from '@tanstack/react-query';
import { StyleSheet, Text, View } from 'react-native';
import { getTravelStats } from '../../src/api/subscriptions';
import { FormMessage } from '../../src/components/Form';
import { FormScreen } from '../../src/components/FormScreen';
import { UpgradePrompt } from '../../src/components/UpgradePrompt';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

const activity = (value: string) =>
  value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');

export default function StatsScreen() {
  const { colors } = useTheme();
  const stats = useQuery({ queryKey: ['travel-stats'], queryFn: getTravelStats });
  if (stats.isPending) {
    return (
      <FormScreen>
        <FormMessage tone="info">Loading…</FormMessage>
      </FormScreen>
    );
  }
  if (!stats.data) {
    return (
      <FormScreen>
        <FormMessage tone="error">Could not load your statistics.</FormMessage>
      </FormScreen>
    );
  }
  const { basic, enhanced } = stats.data;
  const card = [styles.card, { backgroundColor: colors.surface, borderColor: colors.border }];
  const line = (label: string, value: string | number) => (
    <Text key={label} style={[styles.body, { color: colors.text }]}>
      <Text style={styles.bold}>{value}</Text> {label}
    </Text>
  );
  return (
    <FormScreen>
      <View style={card}>
        {line('trips joined', basic.tripsJoined)}
        {line('trips organised', basic.tripsOrganised)}
        {line('coming up', basic.upcoming)}
      </View>
      {enhanced ? (
        <>
          <View style={card}>
            <Text style={[styles.heading, { color: colors.text }]}>Completed trips</Text>
            {line('completed', enhanced.completed)}
            {line('km planned on them', enhanced.distanceKm)}
            {line('different destinations', enhanced.destinations)}
            {line('people travelled with', enhanced.companions)}
            <Text style={[styles.muted, { color: colors.textMuted }]}>
              Distances come from the planned route or the organiser's estimate, not tracking.
            </Text>
          </View>
          {enhanced.byActivity.length > 0 ? (
            <View style={card}>
              <Text style={[styles.heading, { color: colors.text }]}>By activity</Text>
              {enhanced.byActivity.map((a) => line(activity(a.activityType), a.trips))}
            </View>
          ) : null}
          {enhanced.byMonth.length > 0 ? (
            <View style={card}>
              <Text style={[styles.heading, { color: colors.text }]}>Last 12 months</Text>
              {enhanced.byMonth.map((m) => line(m.month, m.trips))}
            </View>
          ) : null}
        </>
      ) : (
        <UpgradePrompt tier="EXPLORER_PRO" what="Detailed travel statistics" />
      )}
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  heading: { ...typography.heading },
  body: { ...typography.body },
  bold: { fontWeight: '700' },
  muted: { ...typography.caption },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
});
