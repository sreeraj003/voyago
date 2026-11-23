import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { restoreSession } from '../src/api/auth';
import { useChatEvents } from '../src/chat/use-chat-events';
import { installCrashReporter, setCurrentRoute } from '../src/monitoring/crash-reporter';
import { usePushNotifications } from '../src/notifications/push';

// Uncaught errors are reported without any personal data (see docs/OPERATIONS.md).
installCrashReporter();

export default function RootLayout() {
  const segments = useSegments();
  useEffect(() => setCurrentRoute(segments), [segments]);
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000 } } }),
  );

  // Restore the signed-in session (if any) from the stored refresh token.
  useEffect(() => {
    void restoreSession();
  }, []);

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="auto" />
        <SessionEffects />
        <Stack screenOptions={{ headerShown: false }} />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

/** App-wide while signed in, on every screen: live chat updates and push notifications. */
function SessionEffects() {
  useChatEvents();
  usePushNotifications();
  return null;
}
