/** A fake fetch for tests: routes "METHOD /path" to a status and JSON body. */
export type Route = { status: number; body?: unknown } | (() => { status: number; body?: unknown });

export function fakeFetch(routes: Record<string, Route>, calls: string[] = []): typeof fetch {
  return (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const key = `${init?.method ?? 'GET'} ${path}`;
    calls.push(key);
    const route = routes[key];
    if (!route) return new Promise<Response>(() => undefined);
    const { status, body } = typeof route === 'function' ? route() : route;
    return Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

export const tokens = (n: number) => ({
  data: {
    accessToken: `access-${n}`,
    refreshToken: `refresh-${n}`.padEnd(43, 'x'),
    expiresIn: 900,
    tokenType: 'Bearer' as const,
  },
});
