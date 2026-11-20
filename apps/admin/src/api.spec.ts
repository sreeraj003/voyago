import { z } from 'zod';
import { api, fetchHealth } from './api';
import { clearSession, getSession, setTokens } from './session';
import { fakeFetch, tokens } from './test-fetch';

const healthy = {
  status: 'ok',
  version: '0.1.0',
  uptimeSeconds: 5,
  timestamp: '2026-11-20T00:00:00.000Z',
  checks: { database: 'up', postgis: 'up', redis: 'up' },
};

function respond(status: number, body: unknown): typeof fetch {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

describe('fetchHealth', () => {
  it('parses a healthy response', async () => {
    await expect(fetchHealth(respond(200, healthy))).resolves.toEqual(healthy);
  });

  it('still returns the body on 503 so the UI can show which dependency is down', async () => {
    const degraded = {
      ...healthy,
      status: 'degraded',
      checks: { ...healthy.checks, redis: 'down' },
    };
    await expect(fetchHealth(respond(503, degraded))).resolves.toMatchObject({
      status: 'degraded',
    });
  });

  it('throws on other errors', async () => {
    await expect(fetchHealth(respond(500, {}))).rejects.toThrow('500');
  });

  it('rejects a malformed body', async () => {
    await expect(fetchHealth(respond(200, { status: 'ok' }))).rejects.toThrow();
  });
});

describe('api', () => {
  afterEach(() => clearSession());

  it('refreshes an expired session once and retries, sharing one refresh', async () => {
    setTokens(tokens(1).data);
    let refreshes = 0;
    let meCalls = 0;
    const calls: string[] = [];
    const fetchImpl = fakeFetch(
      {
        'POST /auth/refresh': () => ({ status: 200, body: tokens(++refreshes + 1) }),
        'GET /admin/staff': () => ({
          status: ++meCalls <= 2 ? 401 : 200,
          body: meCalls <= 2 ? { message: 'expired' } : { data: [] },
        }),
      },
      calls,
    );
    const results = await Promise.all([
      api('/admin/staff', { fetchImpl, schema: z.array(z.unknown()) }),
      api('/admin/staff', { fetchImpl, schema: z.array(z.unknown()) }),
    ]);
    expect(results).toEqual([[], []]);
    expect(refreshes).toBe(1);
    expect(getSession()?.accessToken).toBe('access-2');
  });

  it('ends the session when the refresh token is refused', async () => {
    setTokens(tokens(1).data);
    const fetchImpl = fakeFetch({
      'POST /auth/refresh': { status: 401, body: { message: 'Signed out' } },
      'GET /admin/me': { status: 401, body: { message: 'expired' } },
    });
    await expect(api('/admin/me', { fetchImpl })).rejects.toThrow('Sign in again');
    expect(getSession()).toBeNull();
  });

  it('turns API errors into readable messages', async () => {
    setTokens(tokens(1).data);
    const fetchImpl = fakeFetch({
      'POST /admin/users/x/suspend': {
        status: 400,
        body: { message: 'Validation failed', details: [{ path: 'reason', message: 'Too short' }] },
      },
    });
    await expect(
      api('/admin/users/x/suspend', { method: 'POST', body: {}, fetchImpl }),
    ).rejects.toMatchObject({ status: 400, message: 'Too short' });
  });
});
