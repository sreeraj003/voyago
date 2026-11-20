import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const REFRESH_TOKEN_KEY = 'voyago.refreshToken';

/**
 * Where the refresh token lives between app launches.
 *
 * - iOS / Android: the Keychain / Keystore via expo-secure-store.
 * - Web (development preview only): localStorage, which any script on the page can read.
 *   A production web client should use an httpOnly cookie instead.
 *
 * The access token is never persisted; it lives in memory only.
 */
export const tokenStorage = {
  async getRefreshToken(): Promise<string | null> {
    if (Platform.OS === 'web') return globalThis.localStorage?.getItem(REFRESH_TOKEN_KEY) ?? null;
    return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
  },

  async setRefreshToken(token: string): Promise<void> {
    if (Platform.OS === 'web') {
      globalThis.localStorage?.setItem(REFRESH_TOKEN_KEY, token);
      return;
    }
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
  },

  async clear(): Promise<void> {
    if (Platform.OS === 'web') {
      globalThis.localStorage?.removeItem(REFRESH_TOKEN_KEY);
      return;
    }
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  },
};
