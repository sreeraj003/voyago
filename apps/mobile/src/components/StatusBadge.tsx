import { type TripStatus } from '@voyago/shared';
import { StyleSheet, Text, View } from 'react-native';
import { radius, spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';

const LABELS: Record<TripStatus, string> = {
  DRAFT: 'Draft',
  PUBLISHED: 'Open',
  FULL: 'Full',
  IN_PROGRESS: 'Under way',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};

export function StatusBadge({ status }: { status: TripStatus }) {
  const { colors } = useTheme();
  const tone =
    status === 'CANCELLED' || status === 'EXPIRED'
      ? colors.danger
      : status === 'PUBLISHED' || status === 'IN_PROGRESS'
        ? colors.success
        : colors.textMuted;
  return (
    <View style={[styles.badge, { borderColor: tone }]}>
      <Text style={[styles.text, { color: tone }]}>{LABELS[status]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  text: { ...typography.caption, fontWeight: '600' },
});
