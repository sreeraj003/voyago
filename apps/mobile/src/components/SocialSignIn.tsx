import { useQuery } from '@tanstack/react-query';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Google from 'expo-auth-session/providers/google';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { getAuthMethods, socialSignIn } from '../api/auth';
import { useFormError } from '../auth/use-form-error';
import { spacing } from '../theme/tokens';
import { Button, FormMessage } from './Form';

// Completes the Google popup on web.
WebBrowser.maybeCompleteAuthSession();

/** Public OAuth client ids (not secrets), from the app's env. Add the same ids to the API's GOOGLE_CLIENT_IDS. */
const envText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const googleIds = {
  webClientId: envText(process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID),
  iosClientId: envText(process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID),
  androidClientId: envText(process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID),
};
const googleIdForPlatform =
  Platform.OS === 'ios'
    ? googleIds.iosClientId
    : Platform.OS === 'android'
      ? googleIds.androidClientId
      : googleIds.webClientId;

type Result = Awaited<ReturnType<typeof socialSignIn>>;

/**
 * "Continue with Google / Apple". Each button appears once the server has the provider set up
 * and, for Google, the app has a client id for this platform.
 */
export function SocialSignIn() {
  const methods = useQuery({ queryKey: ['auth-methods'], queryFn: getAuthMethods });
  const error = useFormError();
  const [appleAvailable, setAppleAvailable] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    void AppleAuthentication.isAvailableAsync().then(setAppleAvailable);
  }, []);

  const done = (result: Result) => {
    if (result.status === 'SIGNUP_REQUIRED') {
      router.push({
        pathname: '/complete-signup',
        params: {
          signupToken: result.signupToken,
          displayName: result.suggestedDisplayName ?? '',
        },
      });
    }
    // Signed in: the auth layout redirects to Home.
  };

  const apple = async () => {
    error.clear();
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!credential.identityToken) return;
      done(await socialSignIn('apple', credential.identityToken));
    } catch (caught) {
      if ((caught as { code?: string }).code === 'ERR_REQUEST_CANCELED') return;
      error.capture(caught);
    }
  };

  const showGoogle = methods.data?.google === true && googleIdForPlatform !== '';
  const showApple = methods.data?.apple === true && appleAvailable;
  if (!showGoogle && !showApple) return null;
  return (
    <View style={styles.wrap}>
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      {showGoogle ? <GoogleButton onResult={done} onError={error.capture} /> : null}
      {showApple ? (
        <Button title="Continue with Apple" variant="secondary" onPress={() => void apple()} />
      ) : null}
    </View>
  );
}

/** Mounted only when a client id exists: the Google hook throws without one. */
function GoogleButton({
  onResult,
  onError,
}: {
  onResult: (result: Result) => void;
  onError: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [request, response, promptAsync] = Google.useIdTokenAuthRequest(googleIds);
  useEffect(() => {
    if (response?.type !== 'success') return;
    const idToken = response.params.id_token;
    if (!idToken) return;
    socialSignIn('google', idToken)
      .then(onResult)
      .catch(onError)
      .finally(() => setBusy(false));
  }, [response, onResult, onError]);
  return (
    <Button
      title="Continue with Google"
      variant="secondary"
      loading={busy}
      disabled={!request}
      onPress={() => {
        // Busy until the sign-in finishes; cleared at once if the person cancels.
        setBusy(true);
        void promptAsync()
          .then((result) => {
            if (result.type !== 'success') setBusy(false);
          })
          .catch((caught: unknown) => {
            setBusy(false);
            onError(caught);
          });
      }}
    />
  );
}

const styles = StyleSheet.create({ wrap: { gap: spacing.sm } });
