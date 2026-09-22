import { Router, type Request } from 'express';
import {
  isUuid,
  isValidCharitySlug,
  parseCharityListQuery,
  parseCreateCharityRequest,
  parseUpdateCharityPreference,
  parseUpdateCharityRequest,
  CHARITY_ERROR_CODES,
  type AdminCharityResponse,
  type CharityDetailResponse,
  type CharityPreferenceResponse,
  type CharitySpotlightResponse,
  type ListAdminCharitiesResponse,
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
    // `Parsed<T>` narrows on `ok`, but negating `!query.ok` does not always narrow it in every
    // toolchain (seen as TS2339 "Property 'errors' does not exist on type 'Parsed<T>'"). Narrowing on
    // the `errors` property itself — which only the failure variant has — is equivalent at runtime
    // (a parse either produced errors or a value, never neither/both) and narrows reliably either way.
    if ('errors' in query) throw new ValidationError(query.errors);
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
    // See the identical comment in createPublicCharitiesRouter above.
    if ('errors' in input) throw new ValidationError(input.errors);
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

const notFound = () =>
  new AppError(404, CHARITY_ERROR_CODES.notFound, 'That charity was not found.');

/**
 * Charity management — `/api/admin/charities/*` (PRD §11 ADM-05: add, edit, delete/archive). Mounted
 * behind `requireAuth` + `requireAdmin` in `app.ts`. Unlike the public directory, every route here can
 * see (and the list/detail routes DO return) archived charities.
 */
export function createCharitiesAdminRouter(service: CharityService): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const body: ListAdminCharitiesResponse = { charities: await service.adminList() };
    res.json(body);
  });

  router.post('/', async (req, res) => {
    const input = parseCreateCharityRequest(req.body);
    // See the identical comment in createPublicCharitiesRouter above.
    if ('errors' in input) throw new ValidationError(input.errors);
    const body: AdminCharityResponse = { charity: await service.create(input.value) };
    res.status(201).json(body);
  });

  router.get('/:id', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const body: AdminCharityResponse = { charity: await service.adminDetail(req.params.id) };
    res.json(body);
  });

  router.patch('/:id', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const input = parseUpdateCharityRequest(req.body);
    // See the identical comment in createPublicCharitiesRouter above.
    if ('errors' in input) throw new ValidationError(input.errors);
    const body: AdminCharityResponse = {
      charity: await service.update(req.params.id, input.value),
    };
    res.json(body);
  });

  router.post('/:id/archive', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const body: AdminCharityResponse = { charity: await service.archive(req.params.id) };
    res.json(body);
  });

  router.post('/:id/unarchive', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const body: AdminCharityResponse = { charity: await service.unarchive(req.params.id) };
    res.json(body);
  });

  return router;
}
