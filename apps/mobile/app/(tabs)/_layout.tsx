import Ionicons from '@expo/vector-icons/Ionicons';
import { Redirect, Tabs } from 'expo-router';
import { type ComponentProps } from 'react';
import { ActivityIndicator, type ColorValue, View } from 'react-native';
import { useAuthStore } from '../../src/store/auth-store';
import { useModeStore } from '../../src/store/mode-store';
import { useTheme } from '../../src/theme/use-theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

const tabIcon =
  (name: IconName) =>
  ({ color, size }: { color: ColorValue; size: number }) => (
    <Ionicons name={name} color={typeof color === 'string' ? color : undefined} size={size} />
  );

export default function TabsLayout() {
  const { colors } = useTheme();
  const mode = useModeStore((state) => state.mode);
  const status = useAuthStore((state) => state.status);

  if (status === 'unknown') {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.background,
        }}
      >
        <ActivityIndicator accessibilityLabel="Loading" color={colors.textMuted} />
      </View>
    );
  }
  if (status === 'signedOut') return <Redirect href="/sign-in" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: mode === 'RIDE' ? colors.ride : colors.travel,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: tabIcon('home-outline') }} />
      <Tabs.Screen
        name="explore"
        options={{ title: 'Explore', tabBarIcon: tabIcon('compass-outline') }}
      />
      <Tabs.Screen
        name="create"
        options={{ title: 'Create', tabBarIcon: tabIcon('add-circle-outline') }}
      />
      <Tabs.Screen
        name="inbox"
        options={{ title: 'Inbox', tabBarIcon: tabIcon('chatbubbles-outline') }}
      />
      <Tabs.Screen
        name="profile"
        options={{ title: 'Profile', tabBarIcon: tabIcon('person-outline') }}
      />
    </Tabs>
  );
}
