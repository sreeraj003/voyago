import { type ClientErrorInput } from '@voyago/shared';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { API_BASE_URL } from '../api/client';

const MAX_REPORTS = 10;
let sent = 0;
/** The current screen as a route pattern (e.g. /trips/[id]), never the filled-in path. */
let currentRoute: string | undefined;

/** expo-router segments, e.g. ['(tabs)', 'trips', '[id]'] → /trips/[id]. Groups are dropped. */
export function routeFromSegments(segments: readonly string[]): string {
  const parts = segments.filter((s) => !(s.startsWith('(') && s.endsWith(')')));
  return `/${parts.join('/')}`.slice(0, 120);
}

export function setCurrentRoute(segments: readonly string[]) {
  currentRoute = routeFromSegments(segments);
}

/** The error's class, message and code locations only: no screen contents, no account. */
export function toReport(error: unknown, fatal: boolean): ClientErrorInput {
  const err = error instanceof Error ? error : new Error(String(error));
  const platform = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web';
  return {
    platform,
    appVersion: (Constants.expoConfig?.version ?? 'dev').slice(0, 40),
    message: `${err.name}: ${err.message}`.slice(0, 500),
    stack: err.stack?.split('\n').slice(0, 30).join('\n').slice(0, 4000),
    fatal,
    route: currentRoute,
  };
}

/** Sends one report; never throws, and stops after a few per app start. */
export async function reportError(
  error: unknown,
  fatal = false,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (sent >= MAX_REPORTS) return;
  sent += 1;
  try {
    await fetchImpl(`${API_BASE_URL}/client-errors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toReport(error, fatal)),
    });
  } catch {
    // Reporting must never cause another error.
  }
}

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;
type ErrorUtilsShape = {
  getGlobalHandler: () => GlobalHandler;
  setGlobalHandler: (handler: GlobalHandler) => void;
};

/** Reports uncaught JavaScript errors, then hands them to React Native's own handler. */
export function installCrashReporter(
  errorUtils: ErrorUtilsShape | undefined = (globalThis as { ErrorUtils?: ErrorUtilsShape })
    .ErrorUtils,
) {
  if (!errorUtils) return;
  const previous = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    void reportError(error, Boolean(isFatal));
    previous(error, isFatal);
  });
}

/** Lets tests start from zero. */
export function resetCrashReporter() {
  sent = 0;
  currentRoute = undefined;
}
