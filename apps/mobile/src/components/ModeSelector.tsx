import { type TripMode } from '@voyago/shared';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useModeStore } from '../store/mode-store';
import { radius, spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';

const OPTIONS: { mode: TripMode; label: string }[] = [
  { mode: 'RIDE', label: 'Ride' },
  { mode: 'TRAVEL', label: 'Travel' },
];

export function ModeSelector() {
  const { colors } = useTheme();
  const mode = useModeStore((state) => state.mode);
  const setMode = useModeStore((state) => state.setMode);

  return (
    <View
      accessibilityRole="tablist"
      style={[styles.track, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      {OPTIONS.map((option) => {
        const selected = option.mode === mode;
        const accent = option.mode === 'RIDE' ? colors.ride : colors.travel;
        return (
          <Pressable
            key={option.mode}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => setMode(option.mode)}
            style={[styles.option, selected && { backgroundColor: accent }]}
          >
            <Text style={[styles.label, { color: selected ? colors.onAccent : colors.textMuted }]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.xs,
  },
  option: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.pill,
  },
  label: { ...typography.body, fontWeight: '600' },
});
