import { type HealthResponse, HealthResponseSchema } from '@voyago/shared';

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
