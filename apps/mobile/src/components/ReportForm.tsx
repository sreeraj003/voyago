import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { report } from '../api/social';
import { useFormError } from '../auth/use-form-error';
import { REPORT_REASON_OPTIONS } from '../trips/labels';
import { spacing } from '../theme/tokens';
import { Choice } from './Choice';
import { Button, FormMessage, TextField } from './Form';

type Reason = (typeof REPORT_REASON_OPTIONS)[number]['value'];

/** "Report" link that opens a short form. Reports go to the moderation team. */
export function ReportForm({
  targetType,
  targetId,
  label = 'Report',
}: {
  targetType: 'USER' | 'TRIP' | 'COMMUNITY' | 'POST';
  targetId: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<Reason>('SPAM');
  const [details, setDetails] = useState('');
  const error = useFormError();
  const send = useMutation({
    mutationFn: () =>
      report({
        targetType,
        targetId,
        reason,
        ...(details.trim() ? { details: details.trim() } : {}),
      }),
    onMutate: () => error.clear(),
    onSuccess: () => setDetails(''),
    onError: (caught) => error.capture(caught),
  });

  if (send.isSuccess) {
    return (
      <FormMessage tone="info">
        Thanks. Our moderators will review this. You can also block them from their profile.
      </FormMessage>
    );
  }
  if (!open) return <Button title={label} variant="link" onPress={() => setOpen(true)} />;
  return (
    <View style={styles.wrap}>
      <Choice
        label="What is wrong?"
        value={reason}
        options={REPORT_REASON_OPTIONS}
        onChange={setReason}
      />
      <TextField
        label="Details (optional)"
        value={details}
        onChangeText={setDetails}
        multiline
        maxLength={2000}
        error={error.fields.details}
      />
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      <Button
        title="Send report"
        variant="secondary"
        loading={send.isPending}
        onPress={() => send.mutate()}
      />
      <Button title="Cancel" variant="link" onPress={() => setOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({ wrap: { gap: spacing.sm } });
