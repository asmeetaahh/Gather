import {
  API_CHARITIES_PATH,
  API_CHARITY_SPOTLIGHT_PATH,
  API_MY_CHARITY_PATH,
  type CharityDetailResponse,
  type CharityListQuery,
  type CharityPreferenceResponse,
  type CharitySpotlightResponse,
  type ListCharitiesResponse,
  type UpdateCharityPreferenceRequest,
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
