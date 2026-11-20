import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { registerPushToken, removePushToken } from '../api/chat';
import { useFeatures } from '../api/use-features';
import { beforeSignOut } from '../auth/sign-out-hooks';
import { useAuthStore } from '../store/auth-store';
import { routeFor } from './route';

export type PushState = 'enabled' | 'denied' | 'unsupported' | 'not-configured' | 'off';

let registeredToken: string | null = null;

/** The Expo project id (EAS_PROJECT_ID at build time); push tokens can't be issued without it. */
function projectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined;
  const id = extra?.eas?.projectId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function fromPermission(status: Notifications.PermissionStatus): PushState {
  if (status === Notifications.PermissionStatus.GRANTED) return 'enabled';
  return status === Notifications.PermissionStatus.DENIED ? 'denied' : 'off';
}

const supported = () => Platform.OS !== 'web' && Device.isDevice;

/** Current state without asking the person anything. */
export async function pushState(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  if (!projectId()) return 'not-configured';
  const { status } = await Notifications.getPermissionsAsync();
  return fromPermission(status);
}

/**
 * Registers this device with the API for push notifications. With `ask`, shows the system
 * permission prompt if needed; without it, registers only if permission was already given.
 */
export async function enablePush(ask: boolean): Promise<PushState> {
  if (!supported()) return 'unsupported';
  const id = projectId();
  if (!id) return 'not-configured';
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== Notifications.PermissionStatus.GRANTED && ask) {
    ({ status } = await Notifications.requestPermissionsAsync());
  }
  if (status !== Notifications.PermissionStatus.GRANTED) return fromPermission(status);
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Messages and trip updates',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });
  await registerPushToken(token, Platform.OS === 'ios' ? 'IOS' : 'ANDROID');
  registeredToken = token;
  return 'enabled';
}

// Signing out stops pushes to this device.
beforeSignOut(async () => {
  if (!registeredToken) return;
  const token = registeredToken;
  registeredToken = null;
  await removePushToken(token);
});

/**
 * Mounted once while signed in: registers for pushes when the server can send them and the
 * person already allowed notifications, and opens the right screen when one is tapped.
 */
export function usePushNotifications(): void {
  const signedIn = useAuthStore((state) => state.status === 'signedIn');
  const features = useFeatures();
  useEffect(() => {
    if (!signedIn || !features.push || !supported()) return;
    void enablePush(false).catch(() => undefined);
  }, [signedIn, features.push]);

  useEffect(() => {
    if (!supported()) return;
    Notifications.setNotificationHandler({
      handleNotification: () =>
        Promise.resolve({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: false,
          shouldSetBadge: false,
        }),
    });
    const open = (response: Notifications.NotificationResponse) => {
      const route = routeFor(response.notification.request.content.data ?? {});
      if (route) router.push(route);
    };
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    return () => subscription.remove();
  }, []);
}
