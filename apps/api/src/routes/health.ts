import { Router } from 'express';
import type { HealthResponse } from '@gather/shared';

/** Liveness probe. Deliberately touches no database or third-party service. */
export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  const body: HealthResponse = {
    status: 'ok',
    service: 'gather-api',
    timestamp: new Date().toISOString(),
  };
  res.json(body);
});
