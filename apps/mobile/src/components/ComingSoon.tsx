import { StyleSheet, Text, View } from 'react-native';
import { radius, spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';

/** Honest placeholder for screens whose features land in a later milestone. */
export function ComingSoon({ feature, milestone }: { feature: string; milestone: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.heading, { color: colors.text }]}>{feature}</Text>
      <Text style={[styles.body, { color: colors.textMuted }]}>
        Not built yet. Planned for {milestone}.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
    gap: spacing.xs,
  },
  heading: { ...typography.heading },
  body: { ...typography.body },
});
