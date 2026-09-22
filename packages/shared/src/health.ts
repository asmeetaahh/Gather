/** Path of the API liveness endpoint. Shared so the api route and the web client cannot drift. */
export const API_HEALTH_PATH = '/api/health' as const;

/** Response body of `GET /api/health`. */
export interface HealthResponse {
  status: 'ok';
  service: 'gather-api';
  /** ISO-8601 timestamp of when the response was generated. */
  timestamp: string;
}
