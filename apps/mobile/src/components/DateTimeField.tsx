import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { formatLocalDateTime, parseLocalDateTime } from '../trips/trip-form';
import { spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';
import { Button } from './Form';

type Props = {
  label: string;
  /** "YYYY-MM-DD HH:MM" in local time, or "" when empty. */
  value: string;
  onChange: (value: string) => void;
  error?: string;
  optional?: boolean;
};

/**
 * Native date and time picker (iOS / Android). Android shows the date dialog, then the time
 * dialog. The web build uses DateTimeField.web.tsx.
 */
export function DateTimeField({ label, value, onChange, error, optional }: Props) {
  const { colors } = useTheme();
  const [mode, setMode] = useState<'date' | 'time' | null>(null);
  const current = parseLocalDateTime(value);
  const date = current ? new Date(current) : defaultDate();

  const handle = (event: DateTimePickerEvent, picked?: Date) => {
    if (event.type === 'dismissed' || !picked) {
      setMode(null);
      return;
    }
    if (Platform.OS === 'android' && mode === 'date') {
      // Keep the chosen day, then ask for the time.
      onChange(formatLocalDateTime(withTime(picked, date).toISOString()));
      setMode('time');
      return;
    }
    onChange(formatLocalDateTime(picked.toISOString()));
    if (Platform.OS === 'android') setMode(null);
  };

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <Button
        title={value ? new Date(current ?? '').toLocaleString() : 'Choose date and time'}
        variant="secondary"
        onPress={() => setMode(Platform.OS === 'ios' ? (mode ? null : 'date') : 'date')}
      />
      {mode ? (
        <DateTimePicker
          value={date}
          mode={Platform.OS === 'ios' ? 'datetime' : mode}
          display={Platform.OS === 'ios' ? 'inline' : 'default'}
          minimumDate={new Date()}
          onChange={handle}
        />
      ) : null}
      {optional && value ? (
        <Button
          title={`Clear ${label.toLowerCase()}`}
          variant="link"
          onPress={() => onChange('')}
        />
      ) : null}
      {error ? <Text style={[styles.caption, { color: colors.danger }]}>{error}</Text> : null}
    </View>
  );
}

function defaultDate(): Date {
  const date = new Date(Date.now() + 86_400_000);
  date.setHours(6, 0, 0, 0);
  return date;
}

function withTime(day: Date, time: Date): Date {
  const merged = new Date(day);
  merged.setHours(time.getHours(), time.getMinutes(), 0, 0);
  return merged;
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  label: { ...typography.caption, fontWeight: '600' },
  caption: { ...typography.caption },
});
