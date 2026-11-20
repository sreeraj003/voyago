import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { confirmEmail } from '../src/api/auth';
import { ApiRequestError } from '../src/api/http';
import { Button, FormMessage } from '../src/components/Form';
import { Screen } from '../src/components/Screen';

/** Opened from the emailed link: /verify-email?token=… */
export default function VerifyEmailScreen() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  // 'checking', 'done', or the error message to show.
  const [state, setState] = useState<string>('checking');

  useEffect(() => {
    confirmEmail(token ?? '')
      .then(() => setState('done'))
      .catch((error: unknown) =>
        setState(error instanceof ApiRequestError ? error.message : 'Could not reach Voyago.'),
      );
  }, [token]);

  return (
    <Screen title="Verify email">
      <FormMessage tone={state === 'done' || state === 'checking' ? 'info' : 'error'}>
        {state === 'checking'
          ? 'Checking your link…'
          : state === 'done'
            ? 'Your email is verified.'
            : state}
      </FormMessage>
      <Button title="Continue" variant="secondary" onPress={() => router.replace('/')} />
    </Screen>
  );
}
