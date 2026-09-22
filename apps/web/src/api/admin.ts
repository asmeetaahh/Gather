import {
  API_ADMIN_REPORTS_PATH,
  API_ADMIN_USERS_PATH,
  type AdminReportsResponse,
  type AdminUserResponse,
  type CreateScoreRequest,
  type CreateScoreResponse,
  type ListAdminUsersResponse,
  type UpdateAdminUserRequest,
  type UpdateScoreRequest,
  type UpdateScoreResponse,
} from '@gather/shared';
import { apiRequest } from './client';

// ---- Admin user management (PRD §11 ADM-01) ----------------------------------------------------

export const fetchAdminUsers = (accessToken: string) =>
  apiRequest<ListAdminUsersResponse>(API_ADMIN_USERS_PATH, { accessToken });

export const fetchAdminUser = (accessToken: string, id: string) =>
  apiRequest<AdminUserResponse>(`${API_ADMIN_USERS_PATH}/${id}`, { accessToken });

/** The only profile field an admin may edit directly (D-059: role stays SQL-only). */
export const updateAdminUserDisplayName = (
  accessToken: string,
  id: string,
  body: UpdateAdminUserRequest,
) =>
  apiRequest<AdminUserResponse>(`${API_ADMIN_USERS_PATH}/${id}`, {
    method: 'PATCH',
    accessToken,
    body,
  });

/**
 * These three reuse the SAME `ScoreService` rules as the user's own `/api/scores` (an active
 * subscription is still required, addressed at `:id` instead of the caller's own id) — no admin
 * bypass exists server-side, so none is implied here either.
 */
export const addAdminUserScore = (accessToken: string, id: string, body: CreateScoreRequest) =>
  apiRequest<CreateScoreResponse>(`${API_ADMIN_USERS_PATH}/${id}/scores`, {
    method: 'POST',
    accessToken,
    body,
  });

export const updateAdminUserScore = (
  accessToken: string,
  id: string,
  playedOn: string,
  body: UpdateScoreRequest,
) =>
  apiRequest<UpdateScoreResponse>(
    `${API_ADMIN_USERS_PATH}/${id}/scores/${encodeURIComponent(playedOn)}`,
    { method: 'PUT', accessToken, body },
  );

export const deleteAdminUserScore = (accessToken: string, id: string, playedOn: string) =>
  apiRequest<void>(`${API_ADMIN_USERS_PATH}/${id}/scores/${encodeURIComponent(playedOn)}`, {
    method: 'DELETE',
    accessToken,
  });

// ---- Admin reports (PRD §11 ADM-07) --------------------------------------------------------------

/** Live figures computed on every call — never a stored/cached report (see `AdminReportsDto`). */
export const fetchAdminReports = (accessToken: string) =>
  apiRequest<AdminReportsResponse>(API_ADMIN_REPORTS_PATH, { accessToken });
