import { beforeEach, describe, expect, it } from 'vitest';
import { API_ADMIN_REPORTS_PATH, type AdminReportsResponse } from '@gather/shared';
import { createApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { ADMIN, ALICE, createTestAuth, type TestAuth } from '../../test-support/auth.js';
import { InMemoryDraws } from '../../test-support/draws.js';
import { InMemoryWinners } from '../../test-support/winners.js';
import { InMemoryAdminReports } from '../../test-support/admin-reports.js';
import { request } from '../../test-support/http.js';
import { createAdminReportsService } from './service.js';

const config = loadConfig({ NODE_ENV: 'test' });

let auth: TestAuth;
let reportsRepo: InMemoryAdminReports;
let app: ReturnType<typeof createApp>;
let adminToken: string;
let aliceToken: string;

function buildApp(deps: { adminReports?: boolean } = {}) {
  return createApp(config, {
    auth: auth.deps,
    ...(deps.adminReports !== false && {
      adminReports: createAdminReportsService({
        reports: reportsRepo,
        draws: new InMemoryDraws(),
        winners: new InMemoryWinners(),
      }),
    }),
  });
}

beforeEach(async () => {
  auth = await createTestAuth();
  auth.profiles.add(ADMIN, 'admin');
  auth.profiles.add(ALICE, 'user');
  reportsRepo = new InMemoryAdminReports();
  app = buildApp();
  adminToken = await auth.signToken(ADMIN);
  aliceToken = await auth.signToken(ALICE);
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('GET /api/admin/reports (PRD §11 ADM-07)', () => {
  it('401s with no token', async () => {
    expect((await request(app).get(API_ADMIN_REPORTS_PATH)).status).toBe(401);
  });

  it('403s a non-admin', async () => {
    expect((await request(app).get(API_ADMIN_REPORTS_PATH).set(bearer(aliceToken))).status).toBe(
      403,
    );
  });

  it('503s when adminReports is not wired', async () => {
    const bare = buildApp({ adminReports: false });
    expect((await request(bare).get(API_ADMIN_REPORTS_PATH).set(bearer(adminToken))).status).toBe(
      503,
    );
  });

  it('an admin gets real, live figures', async () => {
    reportsRepo.setUserCount(10);
    reportsRepo.setActiveSubscribers(4);
    const res = await request(app).get(API_ADMIN_REPORTS_PATH).set(bearer(adminToken));
    expect(res.status).toBe(200);
    const { reports } = res.body as AdminReportsResponse;
    expect(reports.totalUsers).toBe(10);
    expect(reports.activeSubscribers).toBe(4);
    expect(reports.draws).toEqual({ total: 0, draft: 0, simulated: 0, published: 0 });
  });
});
