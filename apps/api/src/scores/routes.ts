import { Router, type Request } from 'express';
import {
  parseCreateScore,
  parsePlayedOnParam,
  parseUpdateScore,
  type CreateScoreResponse,
  type ListScoresResponse,
  type UpdateScoreResponse,
} from '@gather/shared';
import { AppError, ValidationError } from '../errors.js';
import type { ScoreService } from './service.js';

/** The id of the verified caller. Set by `requireAuth`; a missing value means the guard was skipped, so refuse. */
function callerId(req: Request): string {
  const auth = req.auth;
  if (!auth) throw new AppError(401, 'unauthenticated', 'Authentication required.');
  return auth.userId;
}

/**
 * Score endpoints. Mounted behind `requireAuth`. Ownership: the user id comes ONLY from the verified
 * token (`req.auth`); the URL identifies a score by DATE within the caller's own scores, so there is no
 * id a client could swap to reach someone else's data, and a `userId` in a body or query is ignored.
 *
 *   GET    /api/scores              own scores, newest first
 *   POST   /api/scores              add a score (replaces the oldest when the user has five)
 *   PUT    /api/scores/:playedOn    edit the value of the score for that date
 *   DELETE /api/scores/:playedOn    delete the score for that date
 */
export function createScoresRouter(service: ScoreService): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const body: ListScoresResponse = { scores: await service.list(callerId(req)) };
    res.json(body);
  });

  router.post('/', async (req, res) => {
    const input = parseCreateScore(req.body);
    // `Parsed<T>` narrows on `ok`, but negating `!input.ok` does not always narrow it in every
    // toolchain (seen as TS2339 "Property 'errors' does not exist on type 'Parsed<T>'"). Narrowing on
    // the `errors` property itself — which only the failure variant has — is equivalent at runtime
    // (a parse either produced errors or a value, never neither/both) and narrows reliably either way.
    if ('errors' in input) throw new ValidationError(input.errors);
    const body: CreateScoreResponse = await service.add(callerId(req), input.value);
    res.status(201).json(body);
  });

  router.put('/:playedOn', async (req, res) => {
    const date = parsePlayedOnParam(req.params.playedOn);
    // See the identical comment in the POST '/' handler above.
    if ('errors' in date) throw new ValidationError(date.errors);
    const input = parseUpdateScore(req.body);
    if ('errors' in input) throw new ValidationError(input.errors);
    const body: UpdateScoreResponse = {
      score: await service.edit(callerId(req), date.value, input.value.stablefordScore),
    };
    res.json(body);
  });

  router.delete('/:playedOn', async (req, res) => {
    const date = parsePlayedOnParam(req.params.playedOn);
    // See the identical comment in the POST '/' handler above.
    if ('errors' in date) throw new ValidationError(date.errors);
    await service.remove(callerId(req), date.value);
    res.status(204).end();
  });

  return router;
}
