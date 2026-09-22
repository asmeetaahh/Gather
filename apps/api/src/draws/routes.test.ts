import { beforeEach, describe, expect, it } from 'vitest';
import {
  API_ADMIN_DRAWS_PATH,
  DRAW_ERROR_CODES,
  type ApiErrorBody,
  type DrawResponse,
  type ListDrawsResponse,
} from '@gather/shared';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { ADMIN, ALICE, createTestAuth, type TestAuth } from '../test-support/auth.js';
import { InMemoryDraws } from '../test-support/draws.js';
import { request, type TestResponse } from '../test-support/http.js';
import { createDrawService } from './service.js';

const config = loadConfig({ NODE_ENV: 'test' });

let auth: TestAuth;
let repo: InMemoryDraws;
let app: ReturnType<typeof createApp>;
let adminToken: string;
let aliceToken: string;

function buildApp(deps: { draws?: boolean } = {}) {
  return createApp(config, {
    auth: auth.deps,
    ...(deps.draws !== false && { draws: createDrawService({ repository: repo }) }),
  });
}

beforeEach(async () => {
  auth = await createTestAuth();
  auth.profiles.add(ADMIN, 'admin');
  auth.profiles.add(ALICE, 'user');
  repo = new InMemoryDraws();
  repo.setPoolBps(1000);
  repo.setActivePlanCurrency('USD');
  app = buildApp();
  adminToken = await auth.signToken(ADMIN);
  aliceToken = await auth.signToken(ALICE);
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const errorOf = (res: TestResponse) => (res.body as ApiErrorBody).error;
const UUID = '00000000-0000-4000-8000-000000000000';

describe('every /api/admin/draws endpoint requires an admin (PRD §11 ADM-02/03/04)', () => {
  const calls: readonly ['get' | 'post', string][] = [
    ['get', API_ADMIN_DRAWS_PATH],
    ['post', API_ADMIN_DRAWS_PATH],
    ['get', `${API_ADMIN_DRAWS_PATH}/${UUID}`],
    ['post', `${API_ADMIN_DRAWS_PATH}/${UUID}/simulate`],
    ['post', `${API_ADMIN_DRAWS_PATH}/${UUID}/publish`],
  ];

  it.each(calls)('%s %s without a token → 401', async (method, path) => {
    const res = await request(app)[method](path);
    expect(res.status).toBe(401);
  });

  it.each(calls)(
    '%s %s as a regular (non-admin) user → 403, and the service is never even asked',
    async (method, path) => {
      const res = await request(app)[method](path).set(bearer(aliceToken));
      expect(res.status).toBe(403);
      expect(repo.calls).toEqual({ simulate: 0, publish: 0, create: 0 });
    },
  );

  it.each(calls)('%s %s with a forged token → 401', async (method, path) => {
    const forged = await auth.signWithUntrustedKey(ADMIN);
    expect((await request(app)[method](path).set(bearer(forged))).status).toBe(401);
  });

  it.each(calls)(
    '%s %s → 503 when the draw service is not wired (after authentication)',
    async (method, path) => {
      const bare = buildApp({ draws: false });
      expect((await request(bare)[method](path).set(bearer(adminToken))).status).toBe(503);
    },
  );
});

describe('GET /api/admin/draws', () => {
  it('lists draws, admin only', async () => {
    await request(app)
      .post(API_ADMIN_DRAWS_PATH)
      .set(bearer(adminToken))
      .send({ drawMonth: '2026-11-01', mode: 'random' });
    const res = await request(app).get(API_ADMIN_DRAWS_PATH).set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect((res.body as ListDrawsResponse).draws).toHaveLength(1);
  });
});

describe('POST /api/admin/draws', () => {
  it('creates a draft draw', async () => {
    const res = await request(app)
      .post(API_ADMIN_DRAWS_PATH)
      .set(bearer(adminToken))
      .send({ drawMonth: '2026-11-01', mode: 'algorithmic' });
    expect(res.status).toBe(201);
    expect((res.body as DrawResponse).draw).toMatchObject({
      drawMonth: '2026-11-01',
      mode: 'algorithmic',
      status: 'draft',
    });
  });

  it('409s a duplicate month', async () => {
    await request(app)
      .post(API_ADMIN_DRAWS_PATH)
      .set(bearer(adminToken))
      .send({ drawMonth: '2026-11-01', mode: 'random' });
    const res = await request(app)
      .post(API_ADMIN_DRAWS_PATH)
      .set(bearer(adminToken))
      .send({ drawMonth: '2026-11-01', mode: 'random' });
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe(DRAW_ERROR_CODES.duplicateMonth);
  });

  it.each([
    [{}, ['drawMonth', 'mode']],
    [{ drawMonth: '2026-11-15', mode: 'random' }, ['drawMonth']],
    [{ drawMonth: '2026-11-01', mode: 'weighted' }, ['mode']],
  ])(
    'rejects an invalid body %j → 400, naming the field(s), before touching the repository',
    async (body, fields) => {
      const res = await request(app).post(API_ADMIN_DRAWS_PATH).set(bearer(adminToken)).send(body);
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('validation_failed');
      expect(
        errorOf(res)
          .fieldErrors?.map((e) => e.field)
          .sort(),
      ).toEqual([...fields].sort());
      expect(repo.calls.create).toBe(0);
    },
  );

  it('ignores a createdBy/id/status in the body — only the verified admin is recorded', async () => {
    const res = await request(app).post(API_ADMIN_DRAWS_PATH).set(bearer(adminToken)).send({
      drawMonth: '2026-11-01',
      mode: 'random',
      id: 'x',
      status: 'published',
      createdBy: ALICE,
    });
    expect(res.status).toBe(201);
    expect((res.body as DrawResponse).draw.status).toBe('draft');
  });
});

describe('GET /api/admin/draws/:id', () => {
  it('404s an unknown draw', async () => {
    const res = await request(app).get(`${API_ADMIN_DRAWS_PATH}/${UUID}`).set(bearer(adminToken));
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe(DRAW_ERROR_CODES.notFound);
  });

  it.each(['not-a-uuid', '12345', '../../etc/passwd', 'DROP TABLE draws'])(
    'a malformed id (%s) is a 404 and never reaches the repository',
    async (id) => {
      const res = await request(app)
        .get(`${API_ADMIN_DRAWS_PATH}/${encodeURIComponent(id)}`)
        .set(bearer(adminToken));
      expect(res.status).toBe(404);
    },
  );

  it('returns the full detail including tier results once simulated', async () => {
    const created = await request(app)
      .post(API_ADMIN_DRAWS_PATH)
      .set(bearer(adminToken))
      .send({ drawMonth: '2026-11-01', mode: 'random' });
    const id = (created.body as DrawResponse).draw.id;
    await request(app).post(`${API_ADMIN_DRAWS_PATH}/${id}/simulate`).set(bearer(adminToken));
    const res = await request(app).get(`${API_ADMIN_DRAWS_PATH}/${id}`).set(bearer(adminToken));
    expect(res.status).toBe(200);
    const draw = (res.body as DrawResponse).draw;
    expect(draw.status).toBe('simulated');
    expect(draw.winningNumbers).toHaveLength(5);
    expect(draw.tierResults.map((t) => t.matchCount).sort()).toEqual([3, 4, 5]);
  });
});

describe('the full lifecycle over HTTP: DRAFT → SIMULATED → PUBLISHED (DRW-05)', () => {
  it('create, simulate, publish — in order', async () => {
    repo.seedEligible(ALICE, [1, 2, 3, 4, 5]);
    repo.setNumberRange({ min: 1, max: 5 });
    repo.seedPayment({
      basisMinor: 1000,
      currency: 'USD',
      intervalMonths: 1,
      periodStartMonth: '2026-11-01',
    });

    const created = await request(app)
      .post(API_ADMIN_DRAWS_PATH)
      .set(bearer(adminToken))
      .send({ drawMonth: '2026-11-01', mode: 'random' });
    const id = (created.body as DrawResponse).draw.id;

    const simulated = await request(app)
      .post(`${API_ADMIN_DRAWS_PATH}/${id}/simulate`)
      .set(bearer(adminToken));
    expect(simulated.status).toBe(200);
    expect((simulated.body as DrawResponse).draw.status).toBe('simulated');

    const published = await request(app)
      .post(`${API_ADMIN_DRAWS_PATH}/${id}/publish`)
      .set(bearer(adminToken));
    expect(published.status).toBe(200);
    expect((published.body as DrawResponse).draw.status).toBe('published');
  });

  it('publishing before simulating is refused (the lifecycle cannot be skipped)', async () => {
    const created = await request(app)
      .post(API_ADMIN_DRAWS_PATH)
      .set(bearer(adminToken))
      .send({ drawMonth: '2026-11-01', mode: 'random' });
    const id = (created.body as DrawResponse).draw.id;
    const res = await request(app)
      .post(`${API_ADMIN_DRAWS_PATH}/${id}/publish`)
      .set(bearer(adminToken));
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe(DRAW_ERROR_CODES.notSimulated);
  });

  it('re-simulating a published draw is refused', async () => {
    const created = await request(app)
      .post(API_ADMIN_DRAWS_PATH)
      .set(bearer(adminToken))
      .send({ drawMonth: '2026-11-01', mode: 'random' });
    const id = (created.body as DrawResponse).draw.id;
    await request(app).post(`${API_ADMIN_DRAWS_PATH}/${id}/simulate`).set(bearer(adminToken));
    await request(app).post(`${API_ADMIN_DRAWS_PATH}/${id}/publish`).set(bearer(adminToken));
    const res = await request(app)
      .post(`${API_ADMIN_DRAWS_PATH}/${id}/simulate`)
      .set(bearer(adminToken));
    expect(res.status).toBe(422);
  });

  it('publishing twice is idempotent over HTTP: the second call succeeds and changes nothing further', async () => {
    const created = await request(app)
      .post(API_ADMIN_DRAWS_PATH)
      .set(bearer(adminToken))
      .send({ drawMonth: '2026-11-01', mode: 'random' });
    const id = (created.body as DrawResponse).draw.id;
    await request(app).post(`${API_ADMIN_DRAWS_PATH}/${id}/simulate`).set(bearer(adminToken));
    const first = await request(app)
      .post(`${API_ADMIN_DRAWS_PATH}/${id}/publish`)
      .set(bearer(adminToken));
    const second = await request(app)
      .post(`${API_ADMIN_DRAWS_PATH}/${id}/publish`)
      .set(bearer(adminToken));
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('concurrent HTTP publish requests never double-create winners', async () => {
    repo.seedEligible(ALICE, [1, 2, 3, 4, 5]);
    repo.setNumberRange({ min: 1, max: 5 });
    repo.seedPayment({
      basisMinor: 1000,
      currency: 'USD',
      intervalMonths: 1,
      periodStartMonth: '2026-11-01',
    });
    const created = await request(app)
      .post(API_ADMIN_DRAWS_PATH)
      .set(bearer(adminToken))
      .send({ drawMonth: '2026-11-01', mode: 'random' });
    const id = (created.body as DrawResponse).draw.id;
    await request(app).post(`${API_ADMIN_DRAWS_PATH}/${id}/simulate`).set(bearer(adminToken));
    await Promise.all([
      request(app).post(`${API_ADMIN_DRAWS_PATH}/${id}/publish`).set(bearer(adminToken)),
      request(app).post(`${API_ADMIN_DRAWS_PATH}/${id}/publish`).set(bearer(adminToken)),
    ]);
    expect(repo.winnersOf(id)).toHaveLength(1);
  });
});

describe('configuration failures surface as clear 422s, never a raw 500', () => {
  it('no prize pool configuration at all', async () => {
    repo.clearPool();
    const created = await request(app)
      .post(API_ADMIN_DRAWS_PATH)
      .set(bearer(adminToken))
      .send({ drawMonth: '2026-11-01', mode: 'random' });
    const id = (created.body as DrawResponse).draw.id;
    const res = await request(app)
      .post(`${API_ADMIN_DRAWS_PATH}/${id}/simulate`)
      .set(bearer(adminToken));
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe(DRAW_ERROR_CODES.poolNotConfigured);
  });

  it('mixed-currency funding', async () => {
    repo.seedPayment({
      basisMinor: 500,
      currency: 'USD',
      intervalMonths: 1,
      periodStartMonth: '2026-11-01',
    });
    repo.seedPayment({
      basisMinor: 500,
      currency: 'EUR',
      intervalMonths: 1,
      periodStartMonth: '2026-11-01',
    });
    const created = await request(app)
      .post(API_ADMIN_DRAWS_PATH)
      .set(bearer(adminToken))
      .send({ drawMonth: '2026-11-01', mode: 'random' });
    const id = (created.body as DrawResponse).draw.id;
    const res = await request(app)
      .post(`${API_ADMIN_DRAWS_PATH}/${id}/simulate`)
      .set(bearer(adminToken));
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe(DRAW_ERROR_CODES.mixedCurrency);
  });
});

describe('there is no way to delete or directly edit a draw over HTTP', () => {
  it('DELETE / PUT are not routes', async () => {
    for (const method of ['delete', 'put'] as const) {
      const res = await request(app)
        [method](`${API_ADMIN_DRAWS_PATH}/${UUID}`)
        .set(bearer(adminToken));
      expect(res.status, method).toBe(404);
    }
  });
});
