import {
  API_ADMIN_CHECK_PATH,
  API_ME_PATH,
  type AdminCheckResponse,
  type ApiErrorBody,
  type FieldError,
  type MeResponse,
} from '@gather/shared';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

/** An API call that did not succeed. `status` is 0 when the server could not be reached at all. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    /** The server's own message, written to be shown to end users (never internal detail). */
    readonly serverMessage: string | null = null,
    readonly fieldErrors: FieldError[] = [],
  ) {
    super(`API request failed (${String(status)}${code ? ` ${code}` : ''})`);
    this.name = 'ApiRequestError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** The user's access token. Public endpoints omit it. */
  accessToken?: string;
  body?: unknown;
  signal?: AbortSignal;
}

/** Calls the API and returns the parsed JSON. Any failure — network, HTTP status — is an `ApiRequestError`. */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
      ...(options.signal && { signal: options.signal }),
    });
  } catch {
    throw new ApiRequestError(0, null);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as Partial<ApiErrorBody> | null;
    throw new ApiRequestError(
      res.status,
      body?.error?.code ?? null,
      body?.error?.message ?? null,
      body?.error?.fieldErrors ?? [],
    );
  }
  // DELETE /api/scores/:playedOn answers 204 with no body; nothing to parse.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** The caller's own identity and role, as verified by the server. */
export const fetchMe = (accessToken: string) =>
  apiRequest<MeResponse>(API_ME_PATH, { accessToken });

/** Asks the server whether the caller is an administrator. The server, not the UI, decides. */
export const fetchAdminCheck = (accessToken: string) =>
  apiRequest<AdminCheckResponse>(API_ADMIN_CHECK_PATH, { accessToken });
