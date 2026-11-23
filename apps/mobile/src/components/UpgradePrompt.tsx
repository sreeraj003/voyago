import { type PaidTier, TIER_NAMES } from '@voyago/shared';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { radius, spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';
import { Button } from './Form';

/** Shown where a paid feature was refused: which plan has it, and a way to see the plans. */
export function UpgradePrompt({ tier, what }: { tier: PaidTier; what: string }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityRole="summary"
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <Text style={[styles.heading, { color: colors.text }]}>
        {what} is part of {TIER_NAMES[tier]}
      </Text>
      <Text style={[styles.body, { color: colors.textMuted }]}>
        Safety, messages and free trips stay free for everyone.
      </Text>
      <Button title="See plans" variant="secondary" onPress={() => router.push('/plans')} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  heading: { ...typography.heading },
  body: { ...typography.caption },
});
