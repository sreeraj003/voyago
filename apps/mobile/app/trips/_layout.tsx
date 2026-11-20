import { Redirect, Stack } from 'expo-router';
import { useAuthStore } from '../../src/store/auth-store';
import { useTheme } from '../../src/theme/use-theme';

export default function TripsLayout() {
  const status = useAuthStore((state) => state.status);
  const { colors } = useTheme();
  if (status === 'signedOut') return <Redirect href="/sign-in" />;
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="new" options={{ title: 'New trip' }} />
      <Stack.Screen name="[id]/index" options={{ title: 'Trip' }} />
      <Stack.Screen name="[id]/edit" options={{ title: 'Edit trip' }} />
      <Stack.Screen name="[id]/requests" options={{ title: 'Join requests' }} />
      <Stack.Screen name="[id]/people" options={{ title: 'People on this trip' }} />
      <Stack.Screen name="[id]/invite" options={{ title: 'Invite people' }} />
    </Stack>
  );
}
