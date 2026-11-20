import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { resetPassword } from '../src/api/auth';
import { useFormError } from '../src/auth/use-form-error';
import { Button, FormMessage, TextField } from '../src/components/Form';
import { Screen } from '../src/components/Screen';

/** Opened from the emailed link: /reset-password?token=… */
export default function ResetPasswordScreen() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const error = useFormError();

  const submit = async () => {
    error.clear();
    setBusy(true);
    try {
      await resetPassword(token ?? '', password);
      setDone(true);
    } catch (caught) {
      error.capture(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Choose a new password">
      {done ? (
        <FormMessage tone="info">
          Password changed. You have been signed out everywhere.
        </FormMessage>
      ) : (
        <>
          <TextField
            label="New password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="new-password"
            hint="At least 10 characters."
            error={error.fields.password ?? error.fields.token}
          />
          {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
          <Button
            title="Save password"
            onPress={() => void submit()}
            loading={busy}
            disabled={!password}
          />
        </>
      )}
      <Button title="Go to sign in" variant="link" onPress={() => router.replace('/sign-in')} />
    </Screen>
  );
}
