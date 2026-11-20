import { router } from 'expo-router';
import { useState } from 'react';
import { completeSignup, requestOtp, verifyOtp } from '../../src/api/auth';
import { useFormError } from '../../src/auth/use-form-error';
import { Button, FormMessage, TextField } from '../../src/components/Form';
import { Screen } from '../../src/components/Screen';

type Step = { name: 'phone' } | { name: 'code' } | { name: 'profile'; signupToken: string };

export default function PhoneSignInScreen() {
  const [step, setStep] = useState<Step>({ name: 'phone' });
  const [phone, setPhone] = useState('+91');
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const error = useFormError();

  const run = async (action: () => Promise<void>) => {
    error.clear();
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      error.capture(caught);
    } finally {
      setBusy(false);
    }
  };

  const sendCode = () =>
    run(async () => {
      await requestOtp(phone);
      setStep({ name: 'code' });
    });

  const checkCode = () =>
    run(async () => {
      const result = await verifyOtp(phone, code);
      if (result.status === 'SIGNUP_REQUIRED') {
        setDisplayName(result.suggestedDisplayName ?? '');
        setStep({ name: 'profile', signupToken: result.signupToken });
      }
    });

  const finish = (signupToken: string) =>
    run(() => completeSignup({ signupToken, username, displayName }));

  return (
    <Screen title="Sign in with phone">
      {step.name === 'phone' ? (
        <>
          <TextField
            label="Mobile number"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            autoComplete="tel"
            hint="We'll text you a 6-digit code. Your number stays private."
            error={error.fields.phone}
          />
          {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
          <Button title="Send code" onPress={() => void sendCode()} loading={busy} />
        </>
      ) : null}

      {step.name === 'code' ? (
        <>
          <FormMessage tone="info">Enter the code sent to {phone}.</FormMessage>
          <TextField
            label="6-digit code"
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            maxLength={6}
            error={error.fields.code}
          />
          {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
          <Button
            title="Verify"
            onPress={() => void checkCode()}
            loading={busy}
            disabled={code.length !== 6}
          />
          <Button title="Send a new code" variant="link" onPress={() => void sendCode()} />
        </>
      ) : null}

      {step.name === 'profile' ? (
        <>
          <FormMessage tone="info">Welcome! Choose how you appear on Voyago.</FormMessage>
          <TextField
            label="Full name"
            value={displayName}
            onChangeText={setDisplayName}
            autoComplete="name"
            error={error.fields.displayName}
          />
          <TextField
            label="Username"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            error={error.fields.username}
          />
          {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
          <Button
            title="Create account"
            onPress={() => void finish(step.signupToken)}
            loading={busy}
            disabled={!username || !displayName}
          />
        </>
      ) : null}

      <Button
        title="Use email instead"
        variant="link"
        onPress={() => router.navigate('/sign-in')}
      />
    </Screen>
  );
}
