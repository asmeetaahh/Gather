import { API_HEALTH_PATH, type HealthResponse } from '@gather/shared';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

/** Calls `GET /api/health`. Throws if the API is unreachable or answers unexpectedly. */
export async function fetchHealth(signal: AbortSignal): Promise<HealthResponse> {
  const res = await fetch(`${API_BASE_URL}${API_HEALTH_PATH}`, { signal });
  if (!res.ok) throw new Error(`Health check failed with status ${String(res.status)}`);

  const body = (await res.json()) as Partial<HealthResponse>;
  if (body.status !== 'ok') throw new Error('Health check returned an unexpected payload');
  return body as HealthResponse;
}
