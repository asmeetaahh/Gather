import type { AppRole } from './enums.js';

/** Returns the caller's own, server-verified identity. Requires a valid access token. */
export const API_ME_PATH = '/api/me' as const;

/** Every administrator endpoint lives under this prefix, behind server-side admin authorization. */
export const API_ADMIN_BASE_PATH = '/api/admin' as const;

/** Succeeds only for an administrator. Used by the web app to confirm admin access with the server. */
export const API_ADMIN_CHECK_PATH = `${API_ADMIN_BASE_PATH}/check` as const;

/**
 * Response of `GET /api/me`.
 *
 * `role` comes from `profiles.role` in the database on every request — never from the token — so
 * it is the only value the web app may use to decide what to show (D-005). `email` is taken from the
 * verified token purely for display.
 */
export interface MeResponse {
  user: {
    id: string;
    email: string | null;
    role: AppRole;
    displayName: string | null;
  };
}

/** Response of `GET /api/admin/check`. */
export interface AdminCheckResponse {
  ok: true;
  role: 'admin';
}

/** Stable `error.code` values returned by authentication and authorization failures. */
export const AUTH_ERROR_CODES = {
  /** No credentials were supplied. HTTP 401. */
  unauthenticated: 'unauthenticated',
  /** Credentials were supplied but are malformed, expired, or not trusted. HTTP 401. */
  invalidToken: 'invalid_token',
  /** Authenticated, but not allowed to do this (e.g. a non-admin on an admin route). HTTP 403. */
  forbidden: 'forbidden',
  /** A valid account with no application profile row. Should not happen; HTTP 403. */
  profileMissing: 'profile_missing',
  /** Authentication is not configured or its provider is unreachable. HTTP 503. */
  authUnavailable: 'auth_unavailable',
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];
