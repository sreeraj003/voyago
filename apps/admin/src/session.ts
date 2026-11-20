import { type AuthTokens, AuthTokensSchema } from '@voyago/shared';
import { useSyncExternalStore } from 'react';

/**
 * The staff member's session. The access token lives only in memory. The refresh token is kept
 * in sessionStorage so a page reload stays signed in, but it is gone when the tab closes, and it
 * rotates on every refresh (a copied token signs the session out on the server).
 */
export interface Session {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
}

const STORAGE_KEY = 'voyago.admin.refresh';
let session: Session | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function getSession(): Session | null {
  return session;
}

export function setTokens(tokens: AuthTokens, now = Date.now()): void {
  session = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: now + tokens.expiresIn * 1000,
  };
  try {
    storage()?.setItem(STORAGE_KEY, tokens.refreshToken);
  } catch {
    // Storage can be blocked; the session then lasts until reload.
  }
  emit();
}

export function clearSession(): void {
  session = null;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored.
  }
  emit();
}

export function storedRefreshToken(): string | null {
  try {
    return storage()?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function parseTokens(body: unknown): AuthTokens {
  return AuthTokensSchema.parse((body as { data?: unknown }).data);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current session, re-rendering when it changes. */
export function useSession(): Session | null {
  return useSyncExternalStore(subscribe, getSession, getSession);
}
