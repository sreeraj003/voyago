import { Redirect, Stack } from 'expo-router';
import { useAuthStore } from '../../src/store/auth-store';
import { useTheme } from '../../src/theme/use-theme';

export default function CommunitiesLayout() {
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
      <Stack.Screen name="new" options={{ title: 'New community' }} />
      <Stack.Screen name="[slug]/index" options={{ title: 'Community' }} />
      <Stack.Screen name="[slug]/edit" options={{ title: 'Edit community' }} />
      <Stack.Screen name="[slug]/members" options={{ title: 'Members' }} />
    </Stack>
  );
}
