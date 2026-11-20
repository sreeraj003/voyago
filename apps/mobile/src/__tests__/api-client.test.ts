import { fetchHealth } from '../api/client';

const healthy = {
  status: 'ok',
  version: '0.1.0',
  uptimeSeconds: 1,
  timestamp: '2026-11-20T00:00:00.000Z',
  checks: { database: 'up', postgis: 'up', redis: 'up' },
};

const respond =
  (status: number, body: unknown): typeof fetch =>
  () =>
    Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);

describe('fetchHealth', () => {
  it('parses a healthy response', async () => {
    await expect(fetchHealth(respond(200, healthy))).resolves.toEqual(healthy);
  });

  it('throws on server errors other than 503', async () => {
    await expect(fetchHealth(respond(500, {}))).rejects.toThrow('500');
  });
});
