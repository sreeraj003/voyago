import { fetchHealth } from './api';

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
