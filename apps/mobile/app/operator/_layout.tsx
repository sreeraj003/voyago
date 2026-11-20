import { Redirect, Stack } from 'expo-router';
import { useAuthStore } from '../../src/store/auth-store';
import { useTheme } from '../../src/theme/use-theme';

export default function OperatorLayout() {
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
      <Stack.Screen name="index" options={{ title: 'My business' }} />
      <Stack.Screen name="profile" options={{ title: 'Business details' }} />
      <Stack.Screen name="documents" options={{ title: 'Verification documents' }} />
      <Stack.Screen name="questions" options={{ title: 'Customer questions' }} />
      <Stack.Screen name="packages/new" options={{ title: 'New package' }} />
      <Stack.Screen name="packages/[id]" options={{ title: 'Package' }} />
    </Stack>
  );
}
