import { type TripSummary } from '@voyago/shared';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { radius, spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';

export const shortWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

/** A trip in a community or feed list. Tapping opens the trip. */
export function TripSummaryCard({ trip, kicker }: { trip: TripSummary; kicker?: string }) {
  const { colors } = useTheme();
  const accent = trip.mode === 'RIDE' ? colors.ride : colors.travel;
  const places =
    trip.status === 'FULL' ? 'Full' : `${trip.participantCount} of ${trip.maxParticipants} going`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${trip.title}. ${trip.originName} to ${trip.destinationName}. ${shortWhen(trip.departureAt)}. ${places}.`}
      onPress={() => router.push(`/trips/${trip.id}`)}
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <View style={[styles.band, { backgroundColor: accent }]} />
      <View style={styles.body}>
        <Text style={[styles.kicker, { color: accent }]}>
          {kicker ?? (trip.mode === 'RIDE' ? 'RIDE' : 'TRAVEL')} · {shortWhen(trip.departureAt)}
        </Text>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
          {trip.title}
        </Text>
        <Text style={[styles.text, { color: colors.text }]} numberOfLines={1}>
          {trip.originName} → {trip.destinationName}
        </Text>
        <Text style={[styles.caption, { color: colors.textMuted }]}>
          {places} · by @{trip.organiser.username}
          {trip.community ? ` · ${trip.community.name}` : ''}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: 'hidden' },
  band: { height: 6 },
  body: { padding: spacing.md, gap: spacing.xs },
  kicker: { ...typography.caption, fontWeight: '700' },
  title: { ...typography.heading },
  text: { ...typography.body },
  caption: { ...typography.caption },
});
