import { useQuery } from '@tanstack/react-query';
import { StyleSheet, Text, View } from 'react-native';
import { fetchHealth } from '../api/client';
import { radius, spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';

export function ApiStatus() {
  const { colors } = useTheme();
  const { data, error, isPending } = useQuery({
    queryKey: ['health'],
    queryFn: () => fetchHealth(),
  });

  const label = isPending
    ? 'Checking server…'
    : error
      ? 'Server unreachable'
      : data.status === 'ok'
        ? 'Server connected'
        : 'Server degraded';
  const tone = isPending
    ? colors.textMuted
    : !error && data?.status === 'ok'
      ? colors.success
      : colors.danger;

  return (
    <View
      accessibilityRole="summary"
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <View style={[styles.dot, { backgroundColor: tone }]} />
      <Text style={[styles.text, { color: colors.text }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  text: { ...typography.body },
});
