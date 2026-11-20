import { type TripCard } from '@voyago/shared';
import { router } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { labelFor } from '../trips/labels';
import { formatRupees } from '../trips/trip-form';
import { formatDistance, formatDuration } from '../trips/trip-route';
import { radius, spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

/** A discovery result. Tapping opens the trip. */
export function TripCardView({ trip }: { trip: TripCard }) {
  const { colors } = useTheme();
  const accent = trip.mode === 'RIDE' ? colors.ride : colors.travel;
  const facts = [
    trip.route
      ? `${formatDistance(trip.route.distanceMeters)} · ${formatDuration(trip.route.durationSeconds)} by road`
      : null,
    trip.estimatedBudgetPaise !== null
      ? `${formatRupees(trip.estimatedBudgetPaise)} each (est.)`
      : null,
    trip.difficulty ? labelFor(trip.difficulty) : null,
    trip.minEngineCc ? `${trip.minEngineCc} cc+` : null,
  ].filter(Boolean);
  const places =
    trip.seatsLeft > 0 ? `${trip.seatsLeft} of ${trip.maxParticipants} places left` : 'Full';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${trip.title}. ${trip.origin.name} to ${trip.destination.name}. ${when(trip.departureAt)}. ${places}.`}
      onPress={() => router.push(`/trips/${trip.id}`)}
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      {trip.coverImageUrl ? (
        <Image
          source={{ uri: trip.coverImageUrl }}
          style={styles.cover}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <View style={[styles.band, { backgroundColor: accent }]} />
      )}
      <View style={styles.body}>
        <Text style={[styles.kicker, { color: accent }]}>
          {labelFor(trip.activityType).toUpperCase()} · {when(trip.departureAt)}
        </Text>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
          {trip.title}
        </Text>
        <Text style={[styles.text, { color: colors.text }]} numberOfLines={1}>
          {trip.origin.name} → {trip.destination.name}
        </Text>
        {facts.length > 0 ? (
          <Text style={[styles.caption, { color: colors.textMuted }]}>{facts.join(' · ')}</Text>
        ) : null}
        <Text style={[styles.caption, { color: colors.textMuted }]}>
          {places} · by {trip.organiser.displayName}
        </Text>
        {trip.matchReasons.length > 0 ? (
          <Text style={[styles.caption, { color: colors.textMuted }]} numberOfLines={2}>
            Why it's here: {trip.matchReasons.join(', ')}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** Placeholder shapes while results load. */
export function TripCardSkeleton() {
  const { colors } = useTheme();
  const bar = (width: `${number}%`, height = 14) => (
    <View style={[styles.bar, { width, height, backgroundColor: colors.border }]} />
  );
  return (
    <View
      accessibilityLabel="Loading trips"
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <View style={[styles.band, { backgroundColor: colors.border }]} />
      <View style={styles.body}>
        {bar('40%', 12)}
        {bar('85%', 18)}
        {bar('60%')}
        {bar('50%', 12)}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: 'hidden' },
  cover: { width: '100%', aspectRatio: 1200 / 630 },
  band: { height: 6 },
  body: { padding: spacing.md, gap: spacing.xs },
  kicker: { ...typography.caption, fontWeight: '700', letterSpacing: 0.4 },
  title: { ...typography.heading },
  text: { ...typography.body },
  caption: { ...typography.caption },
  bar: { borderRadius: radius.sm },
});
