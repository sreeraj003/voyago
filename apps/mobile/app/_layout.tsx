import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { restoreSession } from '../src/api/auth';
import { useChatEvents } from '../src/chat/use-chat-events';
import { usePushNotifications } from '../src/notifications/push';

export default function RootLayout() {
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
