/** Injection token for `fetch`, so provider adapters can be unit-tested without the network. */
export const HTTP_FETCH = Symbol('HTTP_FETCH');
export type HttpFetch = typeof fetch;

/** Aborts provider calls that hang, so a slow provider never stalls a request for long. */
export const PROVIDER_TIMEOUT_MS = 5_000;
