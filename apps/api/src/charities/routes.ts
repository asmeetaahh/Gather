import { Router, type Request } from 'express';
import {
  isValidCharitySlug,
  parseCharityListQuery,
  parseUpdateCharityPreference,
  CHARITY_ERROR_CODES,
  type CharityDetailResponse,
  type CharityPreferenceResponse,
  type CharitySpotlightResponse,
  type ListCharitiesResponse,
} from '@gather/shared';
import { AppError, ValidationError } from '../errors.js';
import type { CharityService } from './service.js';

/** The id of the verified caller (set by `requireAuth`); if it is missing the guard was skipped, so refuse. */
function callerId(req: Request): string {
  const auth = req.auth;
  if (!auth) throw new AppError(401, 'unauthenticated', 'Authentication required.');
  return auth.userId;
}

/**
 * PUBLIC directory — `GET /api/charities` (search + filter) and `GET /api/charities/:slug` (profile).
 * No sign-in required (PRD §03). Only listed charities are ever returned.
 */
export function createPublicCharitiesRouter(service: CharityService): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const query = parseCharityListQuery(req.query);
    if (!query.ok) throw new ValidationError(query.errors);
    const body: ListCharitiesResponse = await service.list(query.value);
    res.json(body);
  });

  router.get('/:slug', async (req, res) => {
    const { slug } = req.params;
    // A malformed slug cannot match any charity: answer 404 without touching the database.
    if (!isValidCharitySlug(slug))
      throw new AppError(404, CHARITY_ERROR_CODES.notFound, 'That charity was not found.');
    const body: CharityDetailResponse = { charity: await service.detail(slug) };
    res.json(body);
  });

  return router;
}

/** PUBLIC homepage spotlight — `GET /api/charity-spotlight` (PRD §08). */
export function createSpotlightRouter(service: CharityService): Router {
  const router = Router();
  router.get('/', async (_req, res) => {
    const body: CharitySpotlightResponse = { charities: await service.spotlight() };
    res.json(body);
  });
  return router;
}

/**
 * The signed-in user's charity choice — `GET` / `PATCH /api/me/charity`. Mounted behind `requireAuth`; the
 * user id comes only from the verified token, so a `userId` in a body or query is ignored.
 */
export function createMyCharityRouter(service: CharityService): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const body: CharityPreferenceResponse = {
      preference: await service.getPreference(callerId(req)),
    };
    res.json(body);
  });

  router.patch('/', async (req, res) => {
    const input = parseUpdateCharityPreference(req.body);
    if (!input.ok) throw new ValidationError(input.errors);
    const body: CharityPreferenceResponse = {
      preference: await service.updatePreference(callerId(req), input.value),
    };
    res.json(body);
  });

  return router;
}

/** The signed-in user's own contributions (read-only) — `GET /api/me/contributions`. */
export function createMyContributionsRouter(service: CharityService): Router {
  const router = Router();
  router.get('/', async (req, res) => {
    res.json(await service.listContributions(callerId(req)));
  });
  return router;
}
