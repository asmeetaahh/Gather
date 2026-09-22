import {
  API_SCORES_PATH,
  type CreateScoreRequest,
  type CreateScoreResponse,
  type ListScoresResponse,
  type UpdateScoreRequest,
  type UpdateScoreResponse,
} from '@gather/shared';
import { apiRequest } from './client';

/** `GET /api/scores` — the signed-in user's own scores, newest first (PRD §05). */
export const fetchMyScores = (accessToken: string) =>
  apiRequest<ListScoresResponse>(API_SCORES_PATH, { accessToken });

/** `POST /api/scores` — adds a score; replaces the oldest once the caller already has five. */
export const addScore = (accessToken: string, body: CreateScoreRequest) =>
  apiRequest<CreateScoreResponse>(API_SCORES_PATH, { method: 'POST', accessToken, body });

/** `PUT /api/scores/:playedOn` — edits the value of the caller's own score for that date. */
export const updateScore = (accessToken: string, playedOn: string, body: UpdateScoreRequest) =>
  apiRequest<UpdateScoreResponse>(`${API_SCORES_PATH}/${encodeURIComponent(playedOn)}`, {
    method: 'PUT',
    accessToken,
    body,
  });

/** `DELETE /api/scores/:playedOn` — deletes the caller's own score for that date. */
export const deleteScore = (accessToken: string, playedOn: string) =>
  apiRequest<undefined>(`${API_SCORES_PATH}/${encodeURIComponent(playedOn)}`, {
    method: 'DELETE',
    accessToken,
  });
