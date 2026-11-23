import { reportError, routePattern, toReport } from './error-reporter';

describe('error reporter', () => {
  it('sends route patterns, never ids or query strings', () => {
    expect(routePattern('/users/123e4567-e89b-12d3-a456-426614174000')).toBe('/users/:id');
    expect(routePattern('/reports')).toBe('/reports');
  });

  it('builds a report with the error only', () => {
    const report = toReport(new TypeError('x is undefined'), '/trips/42', true);
    expect(report).toMatchObject({
      platform: 'admin',
      message: 'TypeError: x is undefined',
      fatal: true,
      route: '/trips/:id',
    });
  });

  it('posts to the API and swallows network failures', async () => {
    const calls: string[] = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      return Promise.reject(new Error('offline'));
    }) as unknown as typeof fetch;
    await expect(
      reportError(new Error('boom'), { fetchImpl, pathname: '/' }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([expect.stringMatching(/^POST .*\/client-errors$/)]);
  });
});
