import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { request, type TestResponse } from '../test-support/http.js';
import {
  API_ADMIN_BASE_PATH,
  API_ADMIN_CHECK_PATH,
  API_HEALTH_PATH,
  API_ME_PATH,
  AUTH_ERROR_CODES,
  type AdminCheckResponse,
  type ApiErrorBody,
  type MeResponse,
} from '@gather/shared';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { errorHandler } from '../middleware/errors.js';
import { adminRouter } from '../routes/admin.js';
import { ADMIN, ALICE, BOB, createTestAuth, type TestAuth } from '../test-support/auth.js';
import { requireAdmin } from './middleware.js';

const config = loadConfig({ NODE_ENV: 'test' });

let auth: TestAuth;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  auth = await createTestAuth();
  auth.profiles.add(ALICE, 'user', 'Alice');
  auth.profiles.add(BOB, 'user', 'Bob');
  auth.profiles.add(ADMIN, 'admin', 'Root');
  app = createApp(config, { auth: auth.deps });
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const errorOf = (res: TestResponse) => (res.body as ApiErrorBody).error;

describe('unauthenticated access is rejected with 401', () => {
  it.each([API_ME_PATH, API_ADMIN_CHECK_PATH])('%s without credentials', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe(AUTH_ERROR_CODES.unauthenticated);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('rejects malformed Authorization headers', async () => {
    for (const header of ['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer  ', 'Token abc', 'Bearer a b']) {
      const res = await request(app).get(API_ME_PATH).set('Authorization', header);
      expect(res.status, header).toBe(401);
    }
  });

  it('rejects an invalid, expired, foreign-signed or unsigned token without saying why', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const tokens = [
      'not-a-jwt',
      await auth.signToken(ALICE, {}, { expiresAt: past }),
      await auth.signWithUntrustedKey(ALICE),
      auth.unsignedToken(ALICE),
      await auth.hmacConfusionToken(ALICE),
    ];
    for (const token of tokens) {
      const res = await request(app).get(API_ME_PATH).set(bearer(token));
      expect(res.status).toBe(401);
      expect(errorOf(res)).toEqual({
        code: AUTH_ERROR_CODES.invalidToken,
        message: 'Your session is invalid or has expired.',
      });
      expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    }
  });

  it('rejects an oversized token before parsing it', async () => {
    const res = await request(app)
      .get(API_ME_PATH)
      .set(bearer('a'.repeat(10_000)));
    expect(res.status).toBe(401);
  });

  it('rejects the service-role or anon API key used as a bearer token', async () => {
    for (const role of ['service_role', 'anon']) {
      const res = await request(app)
        .get(API_ADMIN_CHECK_PATH)
        .set(bearer(await auth.signToken(ADMIN, { role })));
      expect(res.status, role).toBe(401);
    }
  });

  it('leaves public endpoints open', async () => {
    expect((await request(app).get(API_HEALTH_PATH)).status).toBe(200);
  });
});

describe('authenticated access (GET /api/me)', () => {
  it("returns the caller's own profile, with the role read from the database", async () => {
    const res = await request(app)
      .get(API_ME_PATH)
      .set(bearer(await auth.signToken(ALICE, { email: 'alice@example.test' })));
    expect(res.status).toBe(200);
    expect(res.body as MeResponse).toEqual({
      user: { id: ALICE, email: 'alice@example.test', role: 'user', displayName: 'Alice' },
    });
  });

  it('reports an administrator as admin', async () => {
    const res = await request(app)
      .get(API_ME_PATH)
      .set(bearer(await auth.signToken(ADMIN)));
    expect((res.body as MeResponse).user.role).toBe('admin');
  });

  it('accepts the Bearer scheme case-insensitively', async () => {
    const res = await request(app)
      .get(API_ME_PATH)
      .set('Authorization', `bearer ${await auth.signToken(ALICE)}`);
    expect(res.status).toBe(200);
  });

  it('403s a valid account that has no application profile (never invents one)', async () => {
    auth.profiles.remove(ALICE);
    const res = await request(app)
      .get(API_ME_PATH)
      .set(bearer(await auth.signToken(ALICE)));
    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe(AUTH_ERROR_CODES.profileMissing);
  });
});

describe('user isolation', () => {
  it('each user gets only their own identity', async () => {
    const asAlice = await request(app)
      .get(API_ME_PATH)
      .set(bearer(await auth.signToken(ALICE)));
    const asBob = await request(app)
      .get(API_ME_PATH)
      .set(bearer(await auth.signToken(BOB)));
    expect((asAlice.body as MeResponse).user.id).toBe(ALICE);
    expect((asBob.body as MeResponse).user.id).toBe(BOB);
  });

  it('cannot be redirected to another user by query string or body: the id only ever comes from the token', async () => {
    const token = await auth.signToken(ALICE);
    for (const query of [`userId=${BOB}`, `id=${BOB}`, `user_id=${BOB}`, `sub=${BOB}`]) {
      const res = await request(app).get(`${API_ME_PATH}?${query}`).set(bearer(token));
      expect((res.body as MeResponse).user.id, query).toBe(ALICE);
    }
    const post = await request(app).post(API_ME_PATH).set(bearer(token)).send({ userId: BOB });
    expect(post.status).toBe(404); // no write route exists; nothing was changed or disclosed
  });

  it('cannot be spoofed with an identity header', async () => {
    const res = await request(app)
      .get(API_ME_PATH)
      .set(bearer(await auth.signToken(ALICE)))
      .set('X-User-Id', BOB)
      .set('X-Role', 'admin');
    expect((res.body as MeResponse).user).toMatchObject({ id: ALICE, role: 'user' });
  });
});

describe('authorization: admin routes need profiles.role = admin (never client claims)', () => {
  it('lets an administrator in', async () => {
    const res = await request(app)
      .get(API_ADMIN_CHECK_PATH)
      .set(bearer(await auth.signToken(ADMIN)));
    expect(res.status).toBe(200);
    expect(res.body as AdminCheckResponse).toEqual({ ok: true, role: 'admin' });
  });

  it('turns a regular user away with 403 (authenticated, not authorized)', async () => {
    const res = await request(app)
      .get(API_ADMIN_CHECK_PATH)
      .set(bearer(await auth.signToken(ALICE)));
    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe(AUTH_ERROR_CODES.forbidden);
  });

  it('ignores every admin claim a client can put in its own token', async () => {
    const forged = [
      { app_metadata: { role: 'admin' } },
      { user_metadata: { role: 'admin', is_admin: true } },
      { user_role: 'admin' },
      { is_admin: true },
      { admin: true },
      { app_role: 'admin' },
      { roles: ['admin'] },
    ];
    for (const claims of forged) {
      const res = await request(app)
        .get(API_ADMIN_CHECK_PATH)
        .set(bearer(await auth.signToken(ALICE, claims)));
      expect(res.status, JSON.stringify(claims)).toBe(403);
    }
  });

  it('reads the role on every request: a demotion or promotion takes effect immediately', async () => {
    const adminToken = await auth.signToken(ADMIN);
    const aliceToken = await auth.signToken(ALICE);

    expect((await request(app).get(API_ADMIN_CHECK_PATH).set(bearer(adminToken))).status).toBe(200);
    auth.profiles.setRole(ADMIN, 'user'); // same, still-valid token
    expect((await request(app).get(API_ADMIN_CHECK_PATH).set(bearer(adminToken))).status).toBe(403);

    expect((await request(app).get(API_ADMIN_CHECK_PATH).set(bearer(aliceToken))).status).toBe(403);
    auth.profiles.setRole(ALICE, 'admin');
    expect((await request(app).get(API_ADMIN_CHECK_PATH).set(bearer(aliceToken))).status).toBe(200);
  });

  it('a deleted account loses access even while its token is still valid', async () => {
    const token = await auth.signToken(ADMIN);
    auth.profiles.remove(ADMIN);
    const res = await request(app).get(API_ADMIN_CHECK_PATH).set(bearer(token));
    expect(res.status).toBe(403);
  });
});

describe('every admin route is protected (deny by default)', () => {
  interface Layer {
    route?: { path: string; methods: Record<string, boolean> };
  }
  const routes = (adminRouter.stack as unknown as Layer[]).flatMap((layer) =>
    layer.route
      ? Object.keys(layer.route.methods).map((method) => ({
          method,
          path: layer.route?.path ?? '',
        }))
      : [],
  );

  it('enumerates at least one admin route (guards against an empty, vacuous test)', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it.each(routes)(
    '$method $path: anonymous 401, regular user 403, administrator allowed',
    async ({ method, path }) => {
      const url = `${API_ADMIN_BASE_PATH}${path}`;
      const call = (token?: string) => {
        const req = request(app)[method as 'get'](url);
        return token ? req.set(bearer(token)) : req;
      };

      expect((await call()).status).toBe(401);
      expect((await call(await auth.signToken(ALICE))).status).toBe(403);
      const admin = await call(await auth.signToken(ADMIN));
      expect([401, 403]).not.toContain(admin.status);
    },
  );

  it('even unknown admin paths answer 401/403 before 404, so route existence is not revealed', async () => {
    const url = `${API_ADMIN_BASE_PATH}/does-not-exist`;
    expect((await request(app).get(url)).status).toBe(401);
    expect(
      (
        await request(app)
          .get(url)
          .set(bearer(await auth.signToken(ALICE)))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get(url)
          .set(bearer(await auth.signToken(ADMIN)))
      ).status,
    ).toBe(404);
  });

  it('every HTTP method on an admin path is guarded, not just GET', async () => {
    const url = API_ADMIN_CHECK_PATH;
    const aliceToken = await auth.signToken(ALICE);
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      expect((await request(app)[method](url)).status, method).toBe(401);
      expect((await request(app)[method](url).set(bearer(aliceToken))).status, method).toBe(403);
    }
  });

  it('requireAdmin denies by default when it runs without an authenticated caller', async () => {
    const misconfigured = express();
    misconfigured.get('/x', requireAdmin, (_req, res) => {
      res.json({ reached: true });
    });
    misconfigured.use(errorHandler);
    const res = await request(misconfigured).get('/x');
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('reached');
  });
});

describe('fails closed when authentication cannot be completed', () => {
  it('answers 503 on every authenticated route when auth is not configured, even with a token', async () => {
    const unconfigured = createApp(config);
    const token = await auth.signToken(ADMIN);
    for (const path of [API_ME_PATH, API_ADMIN_CHECK_PATH, `${API_ADMIN_BASE_PATH}/anything`]) {
      const res = await request(unconfigured).get(path).set(bearer(token));
      expect(res.status, path).toBe(503);
      expect(errorOf(res).code).toBe(AUTH_ERROR_CODES.authUnavailable);
    }
    expect((await request(unconfigured).get(API_HEALTH_PATH)).status).toBe(200);
  });

  it('answers 503 (not 401, not 200) when the token verifier cannot reach its keys', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = createApp(config, {
      auth: {
        profiles: auth.profiles,
        verifier: () => Promise.reject(new TypeError('fetch failed')),
      },
    });
    const res = await request(broken)
      .get(API_ADMIN_CHECK_PATH)
      .set(bearer(await auth.signToken(ADMIN)));
    expect(res.status).toBe(503);
    expect(errorOf(res).code).toBe(AUTH_ERROR_CODES.authUnavailable);
    expect(JSON.stringify(res.body)).not.toMatch(/fetch failed/);
  });

  it('answers a generic 500 and grants nothing when the profile lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    auth.profiles.failWith = new Error('connection to db-host.internal:5432 refused');
    const token = await auth.signToken(ADMIN);
    for (const path of [API_ME_PATH, API_ADMIN_CHECK_PATH]) {
      const res = await request(app).get(path).set(bearer(token));
      expect(res.status, path).toBe(500);
      expect(errorOf(res).code).toBe('internal_error');
      expect(JSON.stringify(res.body)).not.toMatch(/db-host|5432|refused/);
    }
  });
});
