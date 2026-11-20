import { formatPaise, type PackageCard } from '@voyago/shared';
import { router } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { packageDates } from '../commercial/package-form';
import { labelFor } from '../trips/labels';
import { radius, spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';

/** A paid experience in a list, always labelled as commercial. */
export function PackageCardView({ pkg }: { pkg: PackageCard }) {
  const { colors } = useTheme();
  const accent = pkg.mode === 'RIDE' ? colors.ride : colors.travel;
  const seats = pkg.seatsLeft > 0 ? `${pkg.seatsLeft} of ${pkg.capacity} places left` : 'Full';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Paid experience by ${pkg.operator.displayName}: ${pkg.title}. ${formatPaise(pkg.pricePaise)} per person. ${seats}.`}
      onPress={() => router.push(`/packages/${pkg.id}`)}
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      {pkg.coverImageUrl ? (
        <Image source={{ uri: pkg.coverImageUrl }} style={styles.cover} />
      ) : (
        <View style={[styles.band, { backgroundColor: accent }]} />
      )}
      <View style={styles.body}>
        <CommercialTag verified={pkg.operator.verified} name={pkg.operator.displayName} />
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
          {pkg.title}
        </Text>
        <Text style={[styles.text, { color: colors.textMuted }]}>
          {labelFor(pkg.activityType)} · {pkg.destinationName} · {pkg.durationDays}{' '}
          {pkg.durationDays === 1 ? 'day' : 'days'}
        </Text>
        <Text style={[styles.text, { color: colors.textMuted }]}>
          {packageDates(pkg.startsAt, pkg.endsAt)}
        </Text>
        <View style={styles.row}>
          <Text style={[styles.price, { color: colors.text }]}>
            {formatPaise(pkg.pricePaise)}
            <Text style={[styles.text, { color: colors.textMuted }]}> per person, all taxes</Text>
          </Text>
          <Text style={[styles.text, { color: colors.textMuted }]}>{seats}</Text>
        </View>
      </View>
    </Pressable>
  );
}

/** "PAID EXPERIENCE · by Ghats Treks ✓ verified" */
export function CommercialTag({ verified, name }: { verified: boolean; name: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.tagRow}>
      <View style={[styles.tag, { borderColor: colors.travel }]}>
        <Text style={[styles.tagText, { color: colors.travel }]}>PAID EXPERIENCE</Text>
      </View>
      <Text style={[styles.text, { color: colors.textMuted }]}>
        by {name}
        {verified ? ' · ✓ verified business' : ' · not verified'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  cover: { width: '100%', aspectRatio: 1200 / 630 },
  band: { height: 6 },
  body: { padding: spacing.md, gap: spacing.xs },
  title: { ...typography.heading },
  text: { ...typography.caption },
  price: { ...typography.body, fontWeight: '700' },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: spacing.sm,
  },
  tagRow: { alignItems: 'flex-start', gap: spacing.xs },
  tag: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  tagText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
});
