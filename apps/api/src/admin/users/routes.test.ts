import { beforeEach, describe, expect, it } from 'vitest';
import {
  API_ADMIN_USERS_PATH,
  type AdminUserResponse,
  type ApiErrorBody,
  type ListAdminUsersResponse,
} from '@gather/shared';
import { createApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { ADMIN, ALICE, BOB, createTestAuth, type TestAuth } from '../../test-support/auth.js';
import { InMemoryBilling } from '../../test-support/billing.js';
import { InMemoryCharities } from '../../test-support/charities.js';
import { FakeSubscriptions, InMemoryScores } from '../../test-support/scores.js';
import { InMemoryWinners } from '../../test-support/winners.js';
import { InMemoryAdminUsers } from '../../test-support/admin-users.js';
import { request, type TestResponse } from '../../test-support/http.js';
import { createScoreService } from '../../scores/service.js';
import { createAdminUserService } from './service.js';

const config = loadConfig({ NODE_ENV: 'test' });

let auth: TestAuth;
let users: InMemoryAdminUsers;
let scoresRepo: InMemoryScores;
let subs: FakeSubscriptions;
let app: ReturnType<typeof createApp>;
let adminToken: string;
let aliceToken: string;

function buildApp(deps: { adminUsers?: boolean; scores?: boolean } = {}) {
  const scores = createScoreService({ repository: scoresRepo, subscriptions: subs });
  return createApp(config, {
    auth: auth.deps,
    ...(deps.scores !== false && { scores }),
    ...(deps.adminUsers !== false && {
      adminUsers: createAdminUserService({
        users,
        scores,
        charities: new InMemoryCharities(),
        billing: new InMemoryBilling(),
        winners: new InMemoryWinners(),
      }),
    }),
  });
}

beforeEach(async () => {
  auth = await createTestAuth();
  auth.profiles.add(ADMIN, 'admin');
  auth.profiles.add(ALICE, 'user');
  users = new InMemoryAdminUsers();
  scoresRepo = new InMemoryScores();
  subs = new FakeSubscriptions();
  app = buildApp();
  adminToken = await auth.signToken(ADMIN);
  aliceToken = await auth.signToken(ALICE);
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const errorOf = (res: TestResponse) => (res.body as ApiErrorBody).error;
const UUID = '00000000-0000-4000-8000-000000000000';

describe('every /api/admin/users endpoint requires an admin (PRD §11 ADM-01)', () => {
  const calls: readonly ['get' | 'post' | 'patch' | 'put' | 'delete', string][] = [
    ['get', API_ADMIN_USERS_PATH],
    ['get', `${API_ADMIN_USERS_PATH}/${UUID}`],
    ['patch', `${API_ADMIN_USERS_PATH}/${UUID}`],
    ['post', `${API_ADMIN_USERS_PATH}/${UUID}/scores`],
    ['put', `${API_ADMIN_USERS_PATH}/${UUID}/scores/2027-01-01`],
    ['delete', `${API_ADMIN_USERS_PATH}/${UUID}/scores/2027-01-01`],
  ];

  it.each(calls)('%s %s without a token → 401', async (method, path) => {
    expect((await request(app)[method](path)).status).toBe(401);
  });

  it.each(calls)('%s %s as a non-admin → 403', async (method, path) => {
    expect((await request(app)[method](path).set(bearer(aliceToken))).status).toBe(403);
  });

  it.each(calls)('%s %s → 503 when adminUsers is not wired', async (method, path) => {
    const bare = buildApp({ adminUsers: false });
    expect((await request(bare)[method](path).set(bearer(adminToken))).status).toBe(503);
  });
});

describe('GET /api/admin/users', () => {
  it('lists every user', async () => {
    users.seedUser({ id: ALICE, email: 'alice@example.test' });
    users.seedUser({ id: BOB, email: 'bob@example.test' });
    const res = await request(app).get(API_ADMIN_USERS_PATH).set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect((res.body as ListAdminUsersResponse).users).toHaveLength(2);
  });

  it('is empty with no users', async () => {
    const res = await request(app).get(API_ADMIN_USERS_PATH).set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect((res.body as ListAdminUsersResponse).users).toEqual([]);
  });
});

describe('GET /api/admin/users/:id', () => {
  it('404s an unknown user', async () => {
    const res = await request(app).get(`${API_ADMIN_USERS_PATH}/${UUID}`).set(bearer(adminToken));
    expect(res.status).toBe(404);
  });

  it('a malformed id is a 404 and never reaches the repository', async () => {
    const res = await request(app)
      .get(`${API_ADMIN_USERS_PATH}/not-a-uuid`)
      .set(bearer(adminToken));
    expect(res.status).toBe(404);
  });

  it("returns one user's full detail, never mixing in another's", async () => {
    users.seedUser({ id: ALICE, email: 'alice@example.test', displayName: 'Alice' });
    users.seedUser({ id: BOB, email: 'bob@example.test', displayName: 'Bob' });
    const res = await request(app).get(`${API_ADMIN_USERS_PATH}/${ALICE}`).set(bearer(adminToken));
    expect(res.status).toBe(200);
    const user = (res.body as AdminUserResponse).user;
    expect(user.id).toBe(ALICE);
    expect(user.displayName).toBe('Alice');
  });
});

describe('PATCH /api/admin/users/:id — edit a profile (ADM-01)', () => {
  it('updates the display name', async () => {
    users.seedUser({ id: ALICE, displayName: 'Old Name' });
    const res = await request(app)
      .patch(`${API_ADMIN_USERS_PATH}/${ALICE}`)
      .set(bearer(adminToken))
      .send({ displayName: 'New Name' });
    expect(res.status).toBe(200);
    expect((res.body as AdminUserResponse).user.displayName).toBe('New Name');
  });

  it('rejects an empty display name before touching the repository', async () => {
    users.seedUser({ id: ALICE });
    const res = await request(app)
      .patch(`${API_ADMIN_USERS_PATH}/${ALICE}`)
      .set(bearer(adminToken))
      .send({ displayName: '' });
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('validation_failed');
  });

  it('ignores an attempt to set role through this endpoint (D-059: role stays SQL-only)', async () => {
    users.seedUser({ id: ALICE, role: 'user' });
    const res = await request(app)
      .patch(`${API_ADMIN_USERS_PATH}/${ALICE}`)
      .set(bearer(adminToken))
      .send({ displayName: 'Alice', role: 'admin' });
    expect(res.status).toBe(200);
    expect((res.body as AdminUserResponse).user.role).toBe('user');
  });

  it('404s an unknown user', async () => {
    const res = await request(app)
      .patch(`${API_ADMIN_USERS_PATH}/${UUID}`)
      .set(bearer(adminToken))
      .send({ displayName: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('admin score mutations (ADM-01 "edit golf scores") — same rules as the user’s own route', () => {
  it('adds a score for the target user only, once they are an active subscriber', async () => {
    users.seedUser({ id: ALICE });
    subs.active.add(ALICE);
    const res = await request(app)
      .post(`${API_ADMIN_USERS_PATH}/${ALICE}/scores`)
      .set(bearer(adminToken))
      .send({ playedOn: '2027-01-01', stablefordScore: 30 });
    expect(res.status).toBe(201);
    expect(scoresRepo.stored(ALICE)).toHaveLength(1);
    expect(scoresRepo.stored(BOB)).toHaveLength(0); // never touches another user
  });

  it('refuses to add a score for a user who is NOT an active subscriber (SUB-05/D-062, no admin bypass)', async () => {
    users.seedUser({ id: ALICE });
    const res = await request(app)
      .post(`${API_ADMIN_USERS_PATH}/${ALICE}/scores`)
      .set(bearer(adminToken))
      .send({ playedOn: '2027-01-01', stablefordScore: 30 });
    expect(res.status).toBe(403);
  });

  it('edits a score for the target user', async () => {
    subs.active.add(ALICE);
    scoresRepo.seed(ALICE, '2027-01-01', 20);
    const res = await request(app)
      .put(`${API_ADMIN_USERS_PATH}/${ALICE}/scores/2027-01-01`)
      .set(bearer(adminToken))
      .send({ stablefordScore: 33 });
    expect(res.status).toBe(200);
    expect(scoresRepo.stored(ALICE)[0]?.stablefordScore).toBe(33);
  });

  it('deletes a score for the target user', async () => {
    subs.active.add(ALICE);
    scoresRepo.seed(ALICE, '2027-01-01', 20);
    const res = await request(app)
      .delete(`${API_ADMIN_USERS_PATH}/${ALICE}/scores/2027-01-01`)
      .set(bearer(adminToken));
    expect(res.status).toBe(204);
    expect(scoresRepo.stored(ALICE)).toHaveLength(0);
  });

  it('editing/deleting a nonexistent score 404s, naming no internal detail', async () => {
    subs.active.add(ALICE);
    const put = await request(app)
      .put(`${API_ADMIN_USERS_PATH}/${ALICE}/scores/2027-01-01`)
      .set(bearer(adminToken))
      .send({ stablefordScore: 20 });
    expect(put.status).toBe(404);
    const del = await request(app)
      .delete(`${API_ADMIN_USERS_PATH}/${ALICE}/scores/2027-01-01`)
      .set(bearer(adminToken));
    expect(del.status).toBe(404);
  });

  it('a malformed date in the URL is rejected before reaching the repository', async () => {
    subs.active.add(ALICE);
    const res = await request(app)
      .put(`${API_ADMIN_USERS_PATH}/${ALICE}/scores/not-a-date`)
      .set(bearer(adminToken))
      .send({ stablefordScore: 20 });
    expect(res.status).toBe(400);
  });
});
