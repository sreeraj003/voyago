import { Redirect, Stack } from 'expo-router';
import { useAuthStore } from '../../src/store/auth-store';
import { useTheme } from '../../src/theme/use-theme';

export default function UsersLayout() {
  const status = useAuthStore((state) => state.status);
  const { colors } = useTheme();
  if (status === 'signedOut') return <Redirect href="/sign-in" />;
  return (
    <Stack
      screenOptions={{
        title: 'Profile',
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.background },
      }}
    />
  );
}
