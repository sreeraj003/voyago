import { Redirect, Stack } from 'expo-router';
import { useAuthStore } from '../../src/store/auth-store';
import { useTheme } from '../../src/theme/use-theme';

export default function PlansLayout() {
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
      <Stack.Screen name="index" options={{ title: 'Plans and billing' }} />
      <Stack.Screen name="saved-searches" options={{ title: 'Saved searches' }} />
      <Stack.Screen name="stats" options={{ title: 'Travel stats' }} />
      <Stack.Screen name="insights" options={{ title: 'Organiser insights' }} />
      <Stack.Screen name="style" options={{ title: 'Profile style' }} />
    </Stack>
  );
}
