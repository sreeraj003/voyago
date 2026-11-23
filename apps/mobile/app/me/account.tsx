import { useMutation, useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';
import { deleteAccount, exportMyData, getDeletionStatus } from '../../src/api/account';
import { useFormError } from '../../src/auth/use-form-error';
import { Button, FormMessage, TextField } from '../../src/components/Form';
import { FormScreen } from '../../src/components/FormScreen';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

export default function AccountScreen() {
  const { colors } = useTheme();
  const status = useQuery({ queryKey: ['account-deletion'], queryFn: getDeletionStatus });
  const exportError = useFormError();
  const deleteError = useFormError();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const download = useMutation({
    mutationFn: async () => {
      const json = await exportMyData();
      await Share.share({ title: 'My Voyago data', message: json });
    },
    onMutate: () => exportError.clear(),
    onError: exportError.capture,
  });
  const remove = useMutation({
    mutationFn: () =>
      deleteAccount({
        confirm: confirm.trim() as 'DELETE',
        ...(status.data?.passwordRequired ? { password } : {}),
      }),
    onMutate: () => deleteError.clear(),
    onSuccess: () => router.replace('/sign-in'),
    onError: deleteError.capture,
  });
  const card = [styles.card, { backgroundColor: colors.surface, borderColor: colors.border }];
  const info = status.data;

  return (
    <FormScreen>
      <View style={card}>
        <Text accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>
          Your data
        </Text>
        <Text style={[styles.body, { color: colors.text }]}>
          Get a copy of everything Voyago holds about you: profile, trips, messages you sent,
          bookings, payments and more, as a JSON file.
        </Text>
        {exportError.message ? <FormMessage tone="error">{exportError.message}</FormMessage> : null}
        <Button
          title="Download my data"
          variant="secondary"
          loading={download.isPending}
          onPress={() => download.mutate()}
        />
      </View>

      <View style={card}>
        <Text accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>
          Delete account
        </Text>
        {status.isPending ? <FormMessage tone="info">Loading…</FormMessage> : null}
        {status.isError ? (
          <FormMessage tone="error">Could not check your account. Try again.</FormMessage>
        ) : null}
        {info ? (
          <>
            <Text style={[styles.muted, { color: colors.textMuted }]}>This is erased:</Text>
            {info.erased.map((line) => (
              <Text key={line} style={[styles.body, { color: colors.text }]}>
                • {line}
              </Text>
            ))}
            <Text style={[styles.muted, { color: colors.textMuted }]}>This is kept:</Text>
            {info.kept.map((line) => (
              <Text key={line} style={[styles.body, { color: colors.text }]}>
                • {line}
              </Text>
            ))}
            {info.canDelete ? (
              <>
                <Text style={[styles.body, { color: colors.text }]}>
                  Deleting can&apos;t be undone. You will be signed out on every device.
                </Text>
                {info.passwordRequired ? (
                  <TextField
                    label="Password"
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry
                    autoComplete="current-password"
                    error={deleteError.fields.password}
                  />
                ) : (
                  <FormMessage tone="info">
                    For your safety, sign in again first if you signed in more than 15 minutes ago.
                  </FormMessage>
                )}
                <TextField
                  label="Type DELETE to confirm"
                  value={confirm}
                  onChangeText={setConfirm}
                  autoCapitalize="characters"
                  error={deleteError.fields.confirm}
                />
                {deleteError.message ? (
                  <FormMessage tone="error">{deleteError.message}</FormMessage>
                ) : null}
                <Button
                  title="Delete my account"
                  disabled={confirm.trim() !== 'DELETE'}
                  loading={remove.isPending}
                  onPress={() => remove.mutate()}
                />
              </>
            ) : (
              <>
                <FormMessage tone="info">First, please:</FormMessage>
                {info.blockers.map((b) => (
                  <Text key={b.code} style={[styles.body, { color: colors.text }]}>
                    • {b.message}
                  </Text>
                ))}
              </>
            )}
          </>
        ) : null}
      </View>
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  heading: { ...typography.heading },
  body: { ...typography.body },
  muted: { ...typography.caption },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
});
