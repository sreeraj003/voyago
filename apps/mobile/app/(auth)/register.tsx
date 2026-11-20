import { router } from 'expo-router';
import { useState } from 'react';
import { register } from '../../src/api/auth';
import { useFormError } from '../../src/auth/use-form-error';
import { Button, FormMessage, TextField } from '../../src/components/Form';
import { Screen } from '../../src/components/Screen';
import { SocialSignIn } from '../../src/components/SocialSignIn';

export default function RegisterScreen() {
  const [form, setForm] = useState({ displayName: '', username: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const error = useFormError();
  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });

  const submit = async () => {
    error.clear();
    setBusy(true);
    try {
      await register({ ...form, email: form.email.trim() });
    } catch (caught) {
      error.capture(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Create your account">
      <TextField
        label="Full name"
        value={form.displayName}
        onChangeText={set('displayName')}
        autoComplete="name"
        error={error.fields.displayName}
      />
      <TextField
        label="Username"
        value={form.username}
        onChangeText={set('username')}
        autoCapitalize="none"
        autoComplete="username-new"
        hint="3 to 30 letters, numbers, dots or underscores. Shown on your profile."
        error={error.fields.username}
      />
      <TextField
        label="Email"
        value={form.email}
        onChangeText={set('email')}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        hint="Private. Never shown on your profile."
        error={error.fields.email}
      />
      <TextField
        label="Password"
        value={form.password}
        onChangeText={set('password')}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
        hint="At least 10 characters."
        error={error.fields.password}
      />
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      <Button
        title="Create account"
        onPress={() => void submit()}
        loading={busy}
        disabled={Object.values(form).some((value) => value.length === 0)}
      />
      <SocialSignIn />
      <Button
        title="I already have an account"
        variant="link"
        onPress={() => router.navigate('/sign-in')}
      />
    </Screen>
  );
}
