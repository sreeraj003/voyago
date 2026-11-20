import { create } from 'zustand';

type AuthState = {
  /** `unknown` until the stored session has been checked at launch. */
  status: 'unknown' | 'signedIn' | 'signedOut';
  /** Kept in memory only, never persisted. */
  accessToken: string | null;
  accessTokenExpiresAt: number | null;
  setAccessToken: (token: string, expiresInSeconds: number) => void;
  setSignedOut: () => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  status: 'unknown',
  accessToken: null,
  accessTokenExpiresAt: null,
  setAccessToken: (accessToken, expiresInSeconds) =>
    set({
      status: 'signedIn',
      accessToken,
      accessTokenExpiresAt: Date.now() + expiresInSeconds * 1000,
    }),
  setSignedOut: () => set({ status: 'signedOut', accessToken: null, accessTokenExpiresAt: null }),
}));
