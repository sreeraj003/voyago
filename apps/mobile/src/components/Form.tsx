import { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';
import { radius, spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';

type FieldProps = TextInputProps & { label: string; error?: string; hint?: string };

/** Labelled text input with an inline error, read by screen readers with the field. */
export function TextField({ label, error, hint, style, ...input }: FieldProps) {
  const { colors } = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={error ?? hint}
        placeholderTextColor={colors.textMuted}
        style={[
          styles.input,
          {
            color: colors.text,
            backgroundColor: colors.surface,
            borderColor: error ? colors.danger : colors.border,
          },
          style,
        ]}
        {...input}
      />
      {error ? (
        <Text style={[styles.caption, { color: colors.danger }]}>{error}</Text>
      ) : hint ? (
        <Text style={[styles.caption, { color: colors.textMuted }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

type ButtonProps = {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'link';
};

export function Button({ title, onPress, loading, disabled, variant = 'primary' }: ButtonProps) {
  const { colors } = useTheme();
  const inactive = Boolean(disabled || loading);
  const background =
    variant === 'primary' ? colors.ride : variant === 'secondary' ? colors.surface : 'transparent';
  const textColor =
    variant === 'primary' ? colors.onAccent : variant === 'link' ? colors.travel : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: inactive, busy: Boolean(loading) }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        variant === 'link' ? styles.link : styles.button,
        {
          backgroundColor: background,
          borderColor: variant === 'secondary' ? colors.border : 'transparent',
          opacity: inactive ? 0.6 : pressed ? 0.85 : 1,
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={textColor} />
      ) : (
        <Text style={[styles.buttonText, { color: textColor }]}>{title}</Text>
      )}
    </Pressable>
  );
}

/** A form-level message: an error from the server, or a confirmation. */
export function FormMessage({ tone, children }: { tone: 'error' | 'info'; children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <Text
      accessibilityRole="alert"
      style={[styles.message, { color: tone === 'error' ? colors.danger : colors.textMuted }]}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  field: { gap: spacing.xs },
  label: { ...typography.caption, fontWeight: '600' },
  input: {
    ...typography.body,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 4,
  },
  caption: { ...typography.caption },
  button: {
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  link: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  buttonText: { ...typography.body, fontWeight: '600' },
  message: { ...typography.body },
});
