import { API_MY_DRAWS_PATH, type ListMyDrawParticipationResponse } from '@gather/shared';
import { apiRequest } from './client';

/** `GET /api/me/draws` — the signed-in user's own participation in PUBLISHED draws (PRD §10 DSH-04). */
export const fetchMyDraws = (accessToken: string) =>
  apiRequest<ListMyDrawParticipationResponse>(API_MY_DRAWS_PATH, { accessToken });
