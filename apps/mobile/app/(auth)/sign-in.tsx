import { router } from 'expo-router';
import { useState } from 'react';
import { signIn } from '../../src/api/auth';
import { useFormError } from '../../src/auth/use-form-error';
import { Button, FormMessage, TextField } from '../../src/components/Form';
import { Screen } from '../../src/components/Screen';
import { SocialSignIn } from '../../src/components/SocialSignIn';

export default function SignInScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const error = useFormError();

  const submit = async () => {
    error.clear();
    setBusy(true);
    try {
      await signIn(email.trim(), password);
      // The auth layout redirects to Home once signed in.
    } catch (caught) {
      error.capture(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Sign in to Voyago">
      <TextField
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        error={error.fields.email}
      />
      <TextField
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        error={error.fields.password}
      />
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      <Button
        title="Sign in"
        onPress={() => void submit()}
        loading={busy}
        disabled={!email || !password}
      />
      <SocialSignIn />
      <Button
        title="Use phone number instead"
        variant="secondary"
        onPress={() => router.navigate('/phone')}
      />
      <Button
        title="Create an account"
        variant="link"
        onPress={() => router.navigate('/register')}
      />
      <Button
        title="Forgot password?"
        variant="link"
        onPress={() => router.navigate('/forgot-password')}
      />
    </Screen>
  );
}
