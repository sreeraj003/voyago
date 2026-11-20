import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { completeSignup } from '../../src/api/auth';
import { useFormError } from '../../src/auth/use-form-error';
import { Button, FormMessage, TextField } from '../../src/components/Form';
import { Screen } from '../../src/components/Screen';

/** Last step of a Google or Apple sign-up: choose a username and display name. */
export default function CompleteSignupScreen() {
  const params = useLocalSearchParams<{ signupToken?: string; displayName?: string }>();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState(params.displayName ?? '');
  const [busy, setBusy] = useState(false);
  const error = useFormError();

  const finish = async () => {
    if (!params.signupToken) return;
    error.clear();
    setBusy(true);
    try {
      await completeSignup({ signupToken: params.signupToken, username, displayName });
    } catch (caught) {
      error.capture(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Almost there">
      {params.signupToken ? null : (
        <FormMessage tone="error">This sign-up link has expired. Start again.</FormMessage>
      )}
      <TextField
        label="Username"
        value={username}
        onChangeText={setUsername}
        autoCapitalize="none"
        autoCorrect={false}
        error={error.fields.username}
      />
      <TextField
        label="Display name"
        value={displayName}
        onChangeText={setDisplayName}
        error={error.fields.displayName}
      />
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      <Button title="Create my account" loading={busy} onPress={() => void finish()} />
      <Button title="Back to sign in" variant="link" onPress={() => router.navigate('/sign-in')} />
    </Screen>
  );
}
