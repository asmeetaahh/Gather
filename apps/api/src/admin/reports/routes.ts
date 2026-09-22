import { Router } from 'express';
import type { AdminReportsService } from './service.js';

/** Admin reports — `/api/admin/reports` (PRD §11 ADM-07). Mounted behind `requireAuth` + `requireAdmin`. */
export function createReportsAdminRouter(service: AdminReportsService): Router {
  const router = Router();
  router.get('/', async (_req, res) => {
    res.json(await service.get());
  });
  return router;
}
