import { router } from 'expo-router';
import { useState } from 'react';
import { forgotPassword } from '../../src/api/auth';
import { useFormError } from '../../src/auth/use-form-error';
import { Button, FormMessage, TextField } from '../../src/components/Form';
import { Screen } from '../../src/components/Screen';

export default function ForgotPasswordScreen() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const error = useFormError();

  const submit = async () => {
    error.clear();
    setBusy(true);
    try {
      await forgotPassword(email.trim());
      setSent(true);
    } catch (caught) {
      error.capture(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Reset your password">
      {sent ? (
        <FormMessage tone="info">
          If an account uses this email, a reset link is on its way. It works for 1 hour.
        </FormMessage>
      ) : (
        <>
          <TextField
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            error={error.fields.email}
          />
          {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
          <Button
            title="Send reset link"
            onPress={() => void submit()}
            loading={busy}
            disabled={!email}
          />
        </>
      )}
      <Button title="Back to sign in" variant="link" onPress={() => router.navigate('/sign-in')} />
    </Screen>
  );
}
