import { Router } from 'express';
import {
  isUuid,
  parseCreateScore,
  parsePlayedOnParam,
  parseUpdateAdminUserRequest,
  parseUpdateScore,
  ADMIN_USER_ERROR_CODES,
  type AdminUserResponse,
  type CreateScoreResponse,
  type ListAdminUsersResponse,
  type UpdateScoreResponse,
} from '@gather/shared';
import { AppError, ValidationError } from '../../errors.js';
import type { ScoreService } from '../../scores/service.js';
import type { AdminUserService } from './service.js';

const notFound = () => new AppError(404, ADMIN_USER_ERROR_CODES.notFound, 'No such user exists.');

/**
 * Admin user management — `/api/admin/users/*` (PRD §11 ADM-01). Mounted behind `requireAuth` +
 * `requireAdmin` in `app.ts`. Score mutations reuse `ScoreService` directly, addressed at `:id`
 * instead of the caller's own id — the SAME rules apply (an active subscription is still required;
 * SUB-05/D-062), never a silent admin bypass.
 */
export function createUsersAdminRouter(service: AdminUserService, scores: ScoreService): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const body: ListAdminUsersResponse = await service.list();
    res.json(body);
  });

  router.get('/:id', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const body: AdminUserResponse = { user: await service.detail(req.params.id) };
    res.json(body);
  });

  router.patch('/:id', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const input = parseUpdateAdminUserRequest(req.body);
    // `Parsed<T>` narrows on `ok`, but negating `!input.ok` does not always narrow it in every
    // toolchain (seen as TS2339 "Property 'errors' does not exist on type 'Parsed<T>'"). Narrowing on
    // the `errors` property itself — which only the failure variant has — is equivalent at runtime
    // (a parse either produced errors or a value, never neither/both) and narrows reliably either way.
    if ('errors' in input) throw new ValidationError(input.errors);
    const body: AdminUserResponse = {
      user: await service.updateDisplayName(req.params.id, input.value),
    };
    res.json(body);
  });

  router.post('/:id/scores', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const input = parseCreateScore(req.body);
    // See the identical comment in the PATCH '/:id' handler above.
    if ('errors' in input) throw new ValidationError(input.errors);
    const body: CreateScoreResponse = await scores.add(req.params.id, input.value);
    res.status(201).json(body);
  });

  router.put('/:id/scores/:playedOn', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const date = parsePlayedOnParam(req.params.playedOn);
    // See the identical comment in the PATCH '/:id' handler above.
    if ('errors' in date) throw new ValidationError(date.errors);
    const input = parseUpdateScore(req.body);
    if ('errors' in input) throw new ValidationError(input.errors);
    const body: UpdateScoreResponse = {
      score: await scores.edit(req.params.id, date.value, input.value.stablefordScore),
    };
    res.json(body);
  });

  router.delete('/:id/scores/:playedOn', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const date = parsePlayedOnParam(req.params.playedOn);
    // See the identical comment in the PATCH '/:id' handler above.
    if ('errors' in date) throw new ValidationError(date.errors);
    await scores.remove(req.params.id, date.value);
    res.status(204).end();
  });

  return router;
}
