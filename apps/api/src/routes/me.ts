import { Router } from 'express';
import type { MeResponse } from '@gather/shared';
import { AppError } from '../errors.js';

/**
 * The caller's own identity. Mounted behind `requireAuth`, and it reads ONLY `req.auth` (derived from
 * the verified token) — it takes no id from the URL, query or body, so one user can never ask for
 * another's profile through it (user isolation).
 */
export const meRouter = Router();

meRouter.get('/', (req, res) => {
  const auth = req.auth;
  if (!auth) throw new AppError(401, 'unauthenticated', 'Authentication required.');

  const body: MeResponse = {
    user: { id: auth.userId, email: auth.email, role: auth.role, displayName: auth.displayName },
  };
  res.json(body);
});
