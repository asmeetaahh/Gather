import { Router, type Request } from 'express';
import {
  isUuid,
  parseRegisterWinnerProofRequest,
  parseReviewWinnerRequest,
  WINNER_ERROR_CODES,
  type ListWinnersResponse,
  type WinnerResponse,
} from '@gather/shared';
import { AppError, ValidationError } from '../errors.js';
import type { WinnerService } from './service.js';

/** The id of the verified caller (set by `requireAuth`); if it is missing the guard was skipped, so refuse. */
function callerId(req: Request): string {
  const auth = req.auth;
  if (!auth) throw new AppError(401, 'unauthenticated', 'Authentication required.');
  return auth.userId;
}

const notFound = () => new AppError(404, WINNER_ERROR_CODES.notFound, 'No such winner exists.');

/**
 * A signed-in user's own winnings — `/api/me/winners/*` (PRD §10 DSH-05; ROL-03 "upload winner
 * proof"). Every id is scoped to the caller; a winner belonging to someone else answers 404.
 */
export function createMyWinnersRouter(service: WinnerService): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const body: ListWinnersResponse = await service.listMine(callerId(req));
    res.json(body);
  });

  router.get('/:id', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const body: WinnerResponse = { winner: await service.getMine(req.params.id, callerId(req)) };
    res.json(body);
  });

  router.post('/:id/proof', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const input = parseRegisterWinnerProofRequest(req.body);
    // `Parsed<T>` narrows on `ok`, but negating `!input.ok` does not always narrow it in every
    // toolchain (seen as TS2339 "Property 'errors' does not exist on type 'Parsed<T>'"). Narrowing on
    // the `errors` property itself — which only the failure variant has — is equivalent at runtime
    // (a parse either produced errors or a value, never neither/both) and narrows reliably either way.
    if ('errors' in input) throw new ValidationError(input.errors);
    const body: WinnerResponse = {
      winner: await service.registerProof(req.params.id, callerId(req), input.value),
    };
    res.json(body);
  });

  router.post('/:id/proof/reopen', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const body: WinnerResponse = {
      winner: await service.reopenForResubmission(req.params.id, callerId(req)),
    };
    res.json(body);
  });

  return router;
}

/**
 * Winner verification and payout management — `/api/admin/winners/*` (PRD §11 ADM-06). Mounted
 * behind `requireAuth` + `requireAdmin` in `app.ts`.
 */
export function createWinnersAdminRouter(service: WinnerService): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const body: ListWinnersResponse = await service.listAll();
    res.json(body);
  });

  router.get('/:id', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const body: WinnerResponse = { winner: await service.getAdmin(req.params.id) };
    res.json(body);
  });

  router.post('/:id/review', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const input = parseReviewWinnerRequest(req.body);
    // See the identical comment in the POST '/:id/proof' handler above.
    if ('errors' in input) throw new ValidationError(input.errors);
    const body: WinnerResponse = {
      winner: await service.review(req.params.id, callerId(req), input.value),
    };
    res.json(body);
  });

  router.post('/:id/paid', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const body: WinnerResponse = { winner: await service.markPaid(req.params.id, callerId(req)) };
    res.json(body);
  });

  return router;
}
