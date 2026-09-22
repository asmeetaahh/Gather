import {
  API_ADMIN_DRAWS_PATH,
  API_MY_DRAWS_PATH,
  type CreateDrawRequest,
  type DrawResponse,
  type ListDrawsResponse,
  type ListMyDrawParticipationResponse,
} from '@gather/shared';
import { apiRequest } from './client';

/** `GET /api/me/draws` — the signed-in user's own participation in PUBLISHED draws (PRD §10 DSH-04). */
export const fetchMyDraws = (accessToken: string) =>
  apiRequest<ListMyDrawParticipationResponse>(API_MY_DRAWS_PATH, { accessToken });

// ---- Admin draw management (PRD §11 ADM-02/03/04) ------------------------------------------------
// Thin wrappers over the EXISTING Phase 6 draw engine/API — no draw logic is reimplemented here.

export const fetchAdminDraws = (accessToken: string) =>
  apiRequest<ListDrawsResponse>(API_ADMIN_DRAWS_PATH, { accessToken });

export const fetchAdminDraw = (accessToken: string, id: string) =>
  apiRequest<DrawResponse>(`${API_ADMIN_DRAWS_PATH}/${id}`, { accessToken });

/** Creates a new DRAFT draw for a month that has none yet (D-041: one draw per month). */
export const createDraw = (accessToken: string, body: CreateDrawRequest) =>
  apiRequest<DrawResponse>(API_ADMIN_DRAWS_PATH, { method: 'POST', accessToken, body });

/** Draws numbers and computes candidate results. Re-runnable until published (D-018/D-071). */
export const simulateDraw = (accessToken: string, id: string) =>
  apiRequest<DrawResponse>(`${API_ADMIN_DRAWS_PATH}/${id}/simulate`, {
    method: 'POST',
    accessToken,
  });

/** Freezes the draw's results and winners. Irreversible (immutable by trigger once published). */
export const publishDraw = (accessToken: string, id: string) =>
  apiRequest<DrawResponse>(`${API_ADMIN_DRAWS_PATH}/${id}/publish`, {
    method: 'POST',
    accessToken,
  });
