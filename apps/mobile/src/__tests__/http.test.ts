import { z } from 'zod';
import { ApiRequestError, apiRequest } from '../api/http';
import { useAuthStore } from '../store/auth-store';

const stored: { refreshToken: string | null } = { refreshToken: null };
jest.mock('../auth/token-storage', () => ({
  tokenStorage: {
    getRefreshToken: () => Promise.resolve(stored.refreshToken),
    setRefreshToken: (token: string) => {
      stored.refreshToken = token;
      return Promise.resolve();
    },
    clear: () => {
      stored.refreshToken = null;
      return Promise.resolve();
    },
  },
}));

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: () => Promise.resolve(body) }) as Response;

const newTokens = {
  accessToken: 'access-2',
  expiresIn: 900,
  refreshToken: 'r'.repeat(43),
  tokenType: 'Bearer',
};

describe('apiRequest', () => {
  beforeEach(() => {
    stored.refreshToken = 'o'.repeat(43);
    useAuthStore.getState().setAccessToken('access-1', 900);
  });

  it('refreshes once on 401, stores the rotated token and retries', async () => {
    const calls: { url: string; auth?: string }[] = [];
    const fetchImpl = jest.fn((url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization;
      calls.push({ url, auth });
      if (url.endsWith('/auth/refresh')) return Promise.resolve(json(200, { data: newTokens }));
      return Promise.resolve(
        auth === 'Bearer access-2' ? json(200, { data: { ok: true } }) : json(401, {}),
      );
    }) as unknown as typeof fetch;

    await expect(
      apiRequest('/me', { schema: z.object({ ok: z.boolean() }), fetchImpl }),
    ).resolves.toEqual({ ok: true });
    expect(calls.map((c) => c.url.split('/api/v1')[1])).toEqual(['/me', '/auth/refresh', '/me']);
    expect(stored.refreshToken).toBe(newTokens.refreshToken);
    expect(useAuthStore.getState().accessToken).toBe('access-2');
  });

  it('signs out locally when the refresh token is rejected', async () => {
    const fetchImpl = jest.fn(() => Promise.resolve(json(401, {}))) as unknown as typeof fetch;
    await expect(apiRequest('/me', { fetchImpl })).rejects.toBeInstanceOf(ApiRequestError);
    expect(stored.refreshToken).toBeNull();
    expect(useAuthStore.getState().status).toBe('signedOut');
  });

  it('exposes the server message and field errors', async () => {
    const fetchImpl = jest.fn(() =>
      Promise.resolve(
        json(400, {
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation failed',
          details: [{ path: 'username', message: 'This username is reserved' }],
          requestId: 'abc',
          timestamp: '2026-11-20T00:00:00.000Z',
          path: '/api/v1/auth/register',
        }),
      ),
    ) as unknown as typeof fetch;
    const error = await apiRequest('/auth/register', {
      method: 'POST',
      body: {},
      auth: false,
      fetchImpl,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).fieldErrors).toEqual({
      username: 'This username is reserved',
    });
  });
});
