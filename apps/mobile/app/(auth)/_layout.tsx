import { Redirect, Stack } from 'expo-router';
import { useAuthStore } from '../../src/store/auth-store';

export default function AuthLayout() {
  const status = useAuthStore((state) => state.status);
  if (status === 'signedIn') return <Redirect href="/" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
