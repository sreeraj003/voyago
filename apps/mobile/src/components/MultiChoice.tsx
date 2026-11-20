import { Pressable, StyleSheet, Text, View } from 'react-native';
import { radius, spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';

type Option = { value: string; label: string };

/** A row of toggle chips; any number can be selected. */
export function MultiChoice({
  label,
  hint,
  options,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  options: readonly Option[];
  value: readonly string[];
  onChange: (value: string[]) => void;
}) {
  const { colors } = useTheme();
  const toggle = (item: string) =>
    onChange(value.includes(item) ? value.filter((v) => v !== item) : [...value, item]);
  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <View accessibilityLabel={label} style={styles.row}>
        {options.map((option) => {
          const selected = value.includes(option.value);
          return (
            <Pressable
              key={option.value}
              accessibilityRole="checkbox"
              accessibilityLabel={option.label}
              accessibilityState={{ checked: selected }}
              onPress={() => toggle(option.value)}
              style={[
                styles.chip,
                {
                  borderColor: selected ? colors.travel : colors.border,
                  backgroundColor: selected ? colors.travel : colors.surface,
                },
              ]}
            >
              <Text style={{ color: selected ? colors.onAccent : colors.text }}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {hint ? <Text style={[styles.hint, { color: colors.textMuted }]}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  label: { ...typography.caption, fontWeight: '600' },
  hint: { ...typography.caption },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    minHeight: 44,
    justifyContent: 'center',
  },
});
