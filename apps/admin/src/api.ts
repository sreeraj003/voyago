import { type HealthResponse, HealthResponseSchema, type LoginInput } from '@voyago/shared';
import { type z } from 'zod';
import { clearSession, getSession, parseTokens, setTokens, storedRefreshToken } from './session';

export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api/v1'
).replace(/\/$/, '');

/** Fetches API health. A 503 still carries a valid body describing which dependency is down. */
export async function fetchHealth(fetchImpl: typeof fetch = fetch): Promise<HealthResponse> {
  const res = await fetchImpl(`${API_BASE_URL}/health`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok && res.status !== 503) {
    throw new Error(`Health request failed with status ${res.status}`);
  }
  return HealthResponseSchema.parse(await res.json());
}

/** An error answer from the API, with the server's message and field details. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as {
      message?: string;
      details?: { path: string; message: string }[];
    };
    const details = body.details ?? [];
    const message =
      details.length > 0
        ? details.map((d) => d.message).join('. ')
        : (body.message ?? `Request failed (${res.status})`);
    return new ApiError(res.status, message, details);
  } catch {
    return new ApiError(res.status, `Request failed (${res.status})`);
  }
}

export async function signIn(input: LoginInput, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFrom(res);
  setTokens(parseTokens(await res.json()));
}

let refreshing: Promise<boolean> | null = null;

/**
 * Exchanges the refresh token for new tokens. Concurrent callers share one request, because the
 * refresh token rotates and may be used only once.
 */
export function refreshSession(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  refreshing ??= (async () => {
    const refreshToken = getSession()?.refreshToken ?? storedRefreshToken();
    if (!refreshToken) return false;
    try {
      const res = await fetchImpl(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        if (res.status === 400 || res.status === 401) clearSession();
        return false;
      }
      setTokens(parseTokens(await res.json()));
      return true;
    } catch {
      return false;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function signOut(fetchImpl: typeof fetch = fetch): Promise<void> {
  const token = getSession()?.accessToken;
  clearSession();
  if (!token) return;
  try {
    await fetchImpl(`${API_BASE_URL}/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    // Signed out locally either way.
  }
}

interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  schema?: z.ZodType<T>;
  /** Parse `{ data }` (the default) or the whole body (paged lists). */
  envelope?: 'data' | 'whole';
  fetchImpl?: typeof fetch;
}

/**
 * Calls the API as the signed-in staff member. An expired access token is refreshed once and the
 * request retried; if that fails the session ends. Answers are validated with the shared schemas.
 */
export async function api<T>(path: string, options: RequestOptions<T> = {}): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const send = () => {
    const token = getSession()?.accessToken;
    return fetchImpl(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  };
  let res = await send();
  if (res.status === 401) {
    if (await refreshSession(fetchImpl)) {
      res = await send();
    }
    if (res.status === 401) {
      clearSession();
      throw new ApiError(401, 'Your session ended. Sign in again.');
    }
  }
  if (!res.ok) throw await errorFrom(res);
  if (res.status === 204 || !options.schema) return undefined as T;
  const body: unknown = await res.json();
  const payload = options.envelope === 'whole' ? body : (body as { data?: unknown }).data;
  return options.schema.parse(payload);
}
