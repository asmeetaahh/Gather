import {
  API_ADMIN_CHARITIES_PATH,
  API_CHARITIES_PATH,
  API_CHARITY_SPOTLIGHT_PATH,
  API_MY_CHARITY_PATH,
  type AdminCharityResponse,
  type CharityDetailResponse,
  type CharityListQuery,
  type CharityPreferenceResponse,
  type CharitySpotlightResponse,
  type CreateCharityRequest,
  type ListAdminCharitiesResponse,
  type ListCharitiesResponse,
  type UpdateCharityPreferenceRequest,
  type UpdateCharityRequest,
} from '@gather/shared';
import { apiRequest } from './client';

/** `GET /api/charities` — public directory with search, tag and featured filters. */
export function fetchCharities(query: CharityListQuery, signal?: AbortSignal) {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.tag) params.set('tag', query.tag);
  if (query.featured) params.set('featured', 'true');
  params.set('limit', String(query.limit));
  params.set('offset', String(query.offset));
  return apiRequest<ListCharitiesResponse>(`${API_CHARITIES_PATH}?${params.toString()}`, {
    ...(signal && { signal }),
  });
}

/** `GET /api/charities/:slug` — public profile. */
export function fetchCharity(slug: string, signal?: AbortSignal) {
  return apiRequest<CharityDetailResponse>(`${API_CHARITIES_PATH}/${encodeURIComponent(slug)}`, {
    ...(signal && { signal }),
  });
}

/** `GET /api/charity-spotlight` — featured charities for the homepage. */
export function fetchCharitySpotlight(signal?: AbortSignal) {
  return apiRequest<CharitySpotlightResponse>(API_CHARITY_SPOTLIGHT_PATH, {
    ...(signal && { signal }),
  });
}

/** `GET /api/me/charity` — the signed-in user's charity and percentage. */
export const fetchMyCharity = (accessToken: string) =>
  apiRequest<CharityPreferenceResponse>(API_MY_CHARITY_PATH, { accessToken });

/** `PATCH /api/me/charity` — change the charity and/or the percentage. The server validates again. */
export const updateMyCharity = (accessToken: string, body: UpdateCharityPreferenceRequest) =>
  apiRequest<CharityPreferenceResponse>(API_MY_CHARITY_PATH, {
    method: 'PATCH',
    accessToken,
    body,
  });

// ---- Admin charity management (PRD §11 ADM-05) ---------------------------------------------------
// The directory/profile/spotlight above show only LISTED charities. These are the only way to
// create, edit or archive one; archived charities are only ever visible through these endpoints.

/** `GET /api/admin/charities` — every charity, including archived ones. */
export const fetchAdminCharities = (accessToken: string) =>
  apiRequest<ListAdminCharitiesResponse>(API_ADMIN_CHARITIES_PATH, { accessToken });

export const fetchAdminCharity = (accessToken: string, id: string) =>
  apiRequest<AdminCharityResponse>(`${API_ADMIN_CHARITIES_PATH}/${id}`, { accessToken });

export const createCharity = (accessToken: string, body: CreateCharityRequest) =>
  apiRequest<AdminCharityResponse>(API_ADMIN_CHARITIES_PATH, {
    method: 'POST',
    accessToken,
    body,
  });

export const updateCharity = (accessToken: string, id: string, body: UpdateCharityRequest) =>
  apiRequest<AdminCharityResponse>(`${API_ADMIN_CHARITIES_PATH}/${id}`, {
    method: 'PATCH',
    accessToken,
    body,
  });

/** Archiving hides a charity from the public directory/spotlight/signup; it never deletes it. */
export const archiveCharity = (accessToken: string, id: string) =>
  apiRequest<AdminCharityResponse>(`${API_ADMIN_CHARITIES_PATH}/${id}/archive`, {
    method: 'POST',
    accessToken,
  });

export const unarchiveCharity = (accessToken: string, id: string) =>
  apiRequest<AdminCharityResponse>(`${API_ADMIN_CHARITIES_PATH}/${id}/unarchive`, {
    method: 'POST',
    accessToken,
  });
