import { Router } from 'express';
import type { AdminCheckResponse } from '@gather/shared';

/**
 * Administrator endpoints. Every route added here is automatically protected: `app.ts` mounts this
 * router behind `requireAuth` + `requireAdmin`, so anonymous callers get 401 and non-admins 403 before
 * any handler runs. The route-enumeration test in `routes.test.ts` fails if that ever stops being true.
 *
 * Phase 2 only provides the check endpoint; admin features arrive in later phases.
 */
export const adminRouter = Router();

adminRouter.get('/check', (_req, res) => {
  const body: AdminCheckResponse = { ok: true, role: 'admin' };
  res.json(body);
});
