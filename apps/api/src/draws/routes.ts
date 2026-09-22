import { Router, type Request } from 'express';
import {
  isUuid,
  parseCreateDrawRequest,
  DRAW_ERROR_CODES,
  type DrawResponse,
  type ListDrawsResponse,
  type ListMyDrawParticipationResponse,
} from '@gather/shared';
import { AppError, ValidationError } from '../errors.js';
import type { DrawService } from './service.js';

/** The id of the verified caller (set by `requireAuth`); if it is missing the guard was skipped, so refuse. */
function callerId(req: Request): string {
  const auth = req.auth;
  if (!auth) throw new AppError(401, 'unauthenticated', 'Authentication required.');
  return auth.userId;
}

/**
 * Draw management — `/api/admin/draws/*`. Mounted behind `requireAuth` + `requireAdmin` in `app.ts`
 * (PRD §11 ADM-02/03/04): every route here is an administrator action.
 */
export function createDrawsAdminRouter(service: DrawService): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const body: ListDrawsResponse = await service.list();
    res.json(body);
  });

  router.post('/', async (req, res) => {
    const input = parseCreateDrawRequest(req.body);
    // `Parsed<T>` narrows on `ok`, but negating `!input.ok` does not always narrow it in every
    // toolchain (seen as TS2339 "Property 'errors' does not exist on type 'Parsed<T>'"). Narrowing on
    // the `errors` property itself — which only the failure variant has — is equivalent at runtime
    // (a parse either produced errors or a value, never neither/both) and narrows reliably either way.
    if ('errors' in input) throw new ValidationError(input.errors);
    const body: DrawResponse = { draw: await service.create(callerId(req), input.value) };
    res.status(201).json(body);
  });

  router.get('/:id', async (req, res) => {
    // A malformed id cannot match any draw: answer 404 without touching the database.
    if (!isUuid(req.params.id)) {
      throw new AppError(404, DRAW_ERROR_CODES.notFound, 'No such draw exists.');
    }
    const body: DrawResponse = { draw: await service.get(req.params.id) };
    res.json(body);
  });

  router.post('/:id/simulate', async (req, res) => {
    if (!isUuid(req.params.id)) {
      throw new AppError(404, DRAW_ERROR_CODES.notFound, 'No such draw exists.');
    }
    const body: DrawResponse = { draw: await service.simulate(req.params.id) };
    res.json(body);
  });

  router.post('/:id/publish', async (req, res) => {
    if (!isUuid(req.params.id)) {
      throw new AppError(404, DRAW_ERROR_CODES.notFound, 'No such draw exists.');
    }
    const body: DrawResponse = { draw: await service.publish(req.params.id, callerId(req)) };
    res.json(body);
  });

  return router;
}

/**
 * A signed-in user's own draw participation — `/api/me/draws` (PRD §10 DSH-04). Mounted behind
 * `requireAuth` only (no admin check): every draw returned is scoped to the caller by
 * `DrawService.listMine`, which only ever reads published draws (D-050).
 */
export function createMyDrawsRouter(service: DrawService): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const body: ListMyDrawParticipationResponse = await service.listMine(callerId(req));
    res.json(body);
  });

  return router;
}
