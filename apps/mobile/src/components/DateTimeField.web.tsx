import { createElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';

type Props = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  optional?: boolean;
};

/** Web: the browser's own date-time picker (`<input type="datetime-local">`). */
export function DateTimeField({ label, value, onChange, error }: Props) {
  const { colors } = useTheme();
  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      {createElement('input', {
        type: 'datetime-local',
        'aria-label': label,
        value: value.replace(' ', 'T'),
        onChange: (event: { target: { value: string } }) =>
          onChange(event.target.value.replace('T', ' ')),
        style: {
          fontSize: 16,
          padding: 12,
          borderRadius: 8,
          border: `1px solid ${error ? colors.danger : colors.border}`,
          background: colors.surface,
          color: colors.text,
          colorScheme: 'light dark',
        },
      })}
      {error ? <Text style={[styles.caption, { color: colors.danger }]}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  label: { ...typography.caption, fontWeight: '600' },
  caption: { ...typography.caption },
});
