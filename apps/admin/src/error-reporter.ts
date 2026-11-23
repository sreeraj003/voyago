import { type ClientErrorInput } from '@voyago/shared';
import { API_BASE_URL } from './api';

const MAX_REPORTS = 10;
let sent = 0;

/** The page as a pattern: ids become :id, and the query string is never sent. */
export function routePattern(pathname: string): string {
  return pathname
    .split('/')
    .map((part) => (/^[0-9a-f-]{20,}$/i.test(part) || /^\d+$/.test(part) ? ':id' : part))
    .join('/')
    .slice(0, 120);
}

/** The error's class, message and code locations only: no page contents, no account. */
export function toReport(error: unknown, pathname: string, fatal: boolean): ClientErrorInput {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    platform: 'admin',
    appVersion: import.meta.env.VITE_APP_VERSION ?? 'dev',
    message: `${err.name}: ${err.message}`.slice(0, 500),
    stack: err.stack?.split('\n').slice(0, 30).join('\n').slice(0, 4000),
    fatal,
    route: routePattern(pathname),
  };
}

/** Sends one report; never throws, and stops after a few per page load. */
export async function reportError(
  error: unknown,
  { fatal = false, fetchImpl = fetch, pathname = window.location.pathname } = {},
): Promise<void> {
  if (sent >= MAX_REPORTS) return;
  sent += 1;
  try {
    await fetchImpl(`${API_BASE_URL}/client-errors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toReport(error, pathname, fatal)),
      keepalive: true,
    });
  } catch {
    // Reporting must never cause another error.
  }
}

export function installErrorReporter() {
  window.addEventListener('error', (event) => void reportError(event.error ?? event.message));
  window.addEventListener('unhandledrejection', (event) => void reportError(event.reason));
}
