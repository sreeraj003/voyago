import { ApiErrorSchema, type AuthTokens, AuthTokensSchema } from '@voyago/shared';
import { type z } from 'zod';
import { tokenStorage } from '../auth/token-storage';
import { useAuthStore } from '../store/auth-store';
import { API_BASE_URL } from './client';

/** An API error with the server's user-facing message and per-field details. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

type RequestOptions<T> = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Zod schema for the `data` of the response. Omit for 204 responses. */
  schema?: z.ZodType<T>;
  /** Send the access token (default true). */
  auth?: boolean;
  fetchImpl?: typeof fetch;
};

let refreshing: Promise<boolean> | null = null;

/**
 * Exchanges the stored refresh token for new tokens. Concurrent callers share one request,
 * because the server rotates refresh tokens and treats a reused one as theft.
 */
export function refreshSession(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const refreshToken = await tokenStorage.getRefreshToken();
      if (!refreshToken) return false;
      const res = await fetchImpl(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        // 401 means the session is over; anything else (offline, 5xx) keeps it for a retry.
        if (res.status === 401) await signOutLocally();
        return false;
      }
      const body = (await res.json()) as { data: unknown };
      await storeTokens(AuthTokensSchema.parse(body.data));
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function storeTokens(tokens: AuthTokens): Promise<void> {
  await tokenStorage.setRefreshToken(tokens.refreshToken);
  useAuthStore.getState().setAccessToken(tokens.accessToken, tokens.expiresIn);
}

export async function signOutLocally(): Promise<void> {
  await tokenStorage.clear();
  useAuthStore.getState().setSignedOut();
}

/** Calls the API; on 401 refreshes the session once and retries. */
export async function apiRequest<T = void>(
  path: string,
  options: RequestOptions<T> = {},
): Promise<T> {
  const { method = 'GET', body, schema, auth = true, fetchImpl = fetch } = options;

  const send = () => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const accessToken = useAuthStore.getState().accessToken;
    if (auth && accessToken) headers.authorization = `Bearer ${accessToken}`;
    return fetchImpl(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  let res = await send();
  if (res.status === 401 && auth) {
    if (await refreshSession(fetchImpl)) res = await send();
  }
  if (!res.ok) throw await toError(res);
  if (!schema || res.status === 204) return undefined as T;
  const json = (await res.json()) as { data: unknown };
  return schema.parse(json.data);
}

async function toError(res: Response): Promise<ApiRequestError> {
  try {
    const parsed = ApiErrorSchema.safeParse(await res.json());
    if (parsed.success) {
      const fields = Object.fromEntries(
        (parsed.data.details ?? []).map((detail) => [detail.path, detail.message]),
      );
      return new ApiRequestError(res.status, parsed.data.message, fields);
    }
  } catch {
    // Not JSON: fall through to a generic message.
  }
  return new ApiRequestError(res.status, 'Something went wrong. Please try again.');
}
