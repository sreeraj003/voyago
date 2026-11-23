import { Redirect, Stack } from 'expo-router';
import { useAuthStore } from '../../src/store/auth-store';
import { useTheme } from '../../src/theme/use-theme';

export default function BookingsLayout() {
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
      <Stack.Screen name="index" options={{ title: 'My bookings' }} />
      <Stack.Screen name="[id]" options={{ title: 'Booking' }} />
    </Stack>
  );
}
