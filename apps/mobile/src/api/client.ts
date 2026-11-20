import { type HealthResponse, HealthResponseSchema } from '@voyago/shared';

// Expo inlines EXPO_PUBLIC_* variables at build time. Typed as unknown because `process.env`
// is only strongly typed once Expo has generated expo-env.d.ts.
const configuredBaseUrl: unknown = process.env.EXPO_PUBLIC_API_BASE_URL;
export const API_BASE_URL: string = (
  typeof configuredBaseUrl === 'string' ? configuredBaseUrl : 'http://localhost:3000/api/v1'
).replace(/\/$/, '');

/** A 503 still carries a valid body saying which dependency is down. */
export async function fetchHealth(fetchImpl: typeof fetch = fetch): Promise<HealthResponse> {
  const res = await fetchImpl(`${API_BASE_URL}/health`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok && res.status !== 503) {
    throw new Error(`Health request failed with status ${res.status}`);
  }
  return HealthResponseSchema.parse(await res.json());
}
