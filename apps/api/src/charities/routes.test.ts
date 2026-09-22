import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_CHARITIES_PATH,
  API_CHARITY_SPOTLIGHT_PATH,
  API_MY_CHARITY_PATH,
  API_MY_CONTRIBUTIONS_PATH,
  AUTH_ERROR_CODES,
  CHARITY_ERROR_CODES,
  type ApiErrorBody,
  type CharityDetailResponse,
  type CharityPreferenceResponse,
  type CharitySpotlightResponse,
  type ListCharitiesResponse,
  type ListContributionsResponse,
} from '@gather/shared';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { request, type TestResponse } from '../test-support/http.js';
import { ADMIN, ALICE, BOB, createTestAuth, type TestAuth } from '../test-support/auth.js';
import { InMemoryCharities } from '../test-support/charities.js';
import { createCharityService } from './service.js';

const config = loadConfig({ NODE_ENV: 'test' });
const NOW = new Date('2026-09-21T10:00:00.000Z');

let auth: TestAuth;
let repo: InMemoryCharities;
let app: ReturnType<typeof createApp>;
let aliceToken: string;
let bobToken: string;
let riverside: string;
let oceans: string;

beforeEach(async () => {
  auth = await createTestAuth();
  auth.profiles.add(ALICE, 'user');
  auth.profiles.add(BOB, 'user');
  auth.profiles.add(ADMIN, 'admin');
  repo = new InMemoryCharities();
  riverside = repo.seedCharity({
    name: 'Riverside Youth Fund',
    description: 'Golf coaching for young people by the river.',
    tags: ['youth', 'sport'],
    featured: true,
    images: [{ path: 'riverside/cover.png', alt: 'Children on a fairway' }],
    events: [
      { title: 'Charity day', startsAt: '2026-10-01T09:00:00Z', location: 'Riverside GC' },
      { title: 'Long gone', startsAt: '2026-01-01T09:00:00Z' },
    ],
  });
  oceans = repo.seedCharity({
    name: 'Clean Oceans',
    tags: ['environment'],
    description: 'Beach clean-ups.',
  });
  repo.seedCharity({
    name: 'Old Friends',
    archived: true,
    featured: true,
    description: 'Closed down.',
  });
  repo.seedProfile(ALICE, null, 1000);
  repo.seedProfile(BOB, oceans, 2500);
  app = createApp(config, {
    auth: auth.deps,
    charities: createCharityService({ repository: repo, now: () => NOW }),
  });
  aliceToken = await auth.signToken(ALICE);
  bobToken = await auth.signToken(BOB);
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const errorOf = (res: TestResponse) => (res.body as ApiErrorBody).error;
const listed = async (query = '') =>
  (await request(app).get(`${API_CHARITIES_PATH}${query}`)).body as ListCharitiesResponse;
const names = (r: ListCharitiesResponse) => r.charities.map((c) => c.name);

describe('GET /api/charities — public directory (DIR-01)', () => {
  it('needs no sign-in and lists LISTED charities by name', async () => {
    const res = await request(app).get(API_CHARITIES_PATH);
    expect(res.status).toBe(200);
    const body = res.body as ListCharitiesResponse;
    expect(names(body)).toEqual(['Clean Oceans', 'Riverside Youth Fund']);
    expect(body).toMatchObject({ limit: 20, offset: 0, hasMore: false });
  });

  it('never exposes archived charities, however they are asked for', async () => {
    expect(names(await listed())).not.toContain('Old Friends');
    expect(names(await listed('?q=friends'))).toEqual([]);
    expect(names(await listed('?featured=true'))).toEqual(['Riverside Youth Fund']);
  });

  it('summaries carry a cover image and the next upcoming event, but not the full description', async () => {
    const { charities } = await listed('?q=riverside');
    expect(charities).toHaveLength(1);
    const c = charities[0];
    expect(c?.coverImage).toEqual({
      id: expect.any(String) as string,
      url: 'https://cdn.test/charity-media/riverside/cover.png',
      altText: 'Children on a fairway',
    });
    expect(c?.nextEventAt).toBe('2026-10-01T09:00:00Z');
    expect(c).not.toHaveProperty('description');
    expect(c).not.toHaveProperty('archivedAt');
  });

  describe('search and filters', () => {
    it('searches by word prefix, case-insensitively', async () => {
      expect(names(await listed('?q=RIVER'))).toEqual(['Riverside Youth Fund']);
      expect(names(await listed('?q=clean%20oc'))).toEqual(['Clean Oceans']);
    });

    it('searches the description as well as the name', async () => {
      expect(names(await listed('?q=coaching'))).toEqual(['Riverside Youth Fund']);
    });

    it('filters by tag, and combines tag with search and featured', async () => {
      expect(names(await listed('?tag=environment'))).toEqual(['Clean Oceans']);
      expect(names(await listed('?tag=youth&q=river'))).toEqual(['Riverside Youth Fund']);
      expect(names(await listed('?tag=environment&featured=true'))).toEqual([]);
    });

    it('returns an empty list, not an error, when nothing matches', async () => {
      const res = await request(app).get(`${API_CHARITIES_PATH}?q=zzzz`);
      expect(res.status).toBe(200);
      expect((res.body as ListCharitiesResponse).charities).toEqual([]);
    });

    it('treats search text with no words as matching nothing', async () => {
      expect(names(await listed('?q=%21%21%21'))).toEqual([]);
    });

    it.each([
      "?q=river'%3B%20drop%20table%20charities%3B--",
      '?q=a%20%26%20b%20%7C%20!c',
      '?q=x%3A*)%20%7C%20(y',
      '?q=name.ilike.%25',
    ])('hostile search text is harmless: %s', async (query) => {
      const res = await request(app).get(`${API_CHARITIES_PATH}${query}`);
      expect(res.status).toBe(200);
    });
  });

  describe('paging', () => {
    it('pages with limit/offset and reports hasMore', async () => {
      const first = await listed('?limit=1');
      expect(names(first)).toEqual(['Clean Oceans']);
      expect(first.hasMore).toBe(true);
      const second = await listed('?limit=1&offset=1');
      expect(names(second)).toEqual(['Riverside Youth Fund']);
      expect(second.hasMore).toBe(false);
    });

    it('an offset past the end is an empty page, not an error', async () => {
      const res = await request(app).get(`${API_CHARITIES_PATH}?offset=500`);
      expect(res.status).toBe(200);
      expect((res.body as ListCharitiesResponse).charities).toEqual([]);
    });
  });

  describe('query validation → 400 with per-field errors, before any database work', () => {
    it.each([
      ['limit=0', 'limit'],
      ['limit=51', 'limit'],
      ['limit=abc', 'limit'],
      ['limit=1.5', 'limit'],
      ['offset=-1', 'offset'],
      ['offset=10001', 'offset'],
      ['featured=yes', 'featured'],
      ['tag=Bad%20Tag!', 'tag'],
      [`q=${'x'.repeat(101)}`, 'q'],
      ['limit=1&limit=2', 'limit'],
      ['q=a&q=b', 'q'],
    ])('%s', async (query, field) => {
      repo.calls.list = 0;
      const res = await request(app).get(`${API_CHARITIES_PATH}?${query}`);
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('validation_failed');
      expect(errorOf(res).fieldErrors?.map((e) => e.field)).toContain(field);
      expect(repo.calls.list).toBe(0);
    });
  });
});

describe('GET /api/charities/:slug — public profile (DIR-02)', () => {
  it('returns the full profile: description, images, upcoming events only', async () => {
    const res = await request(app).get(`${API_CHARITIES_PATH}/riverside-youth-fund`);
    expect(res.status).toBe(200);
    const { charity } = res.body as CharityDetailResponse;
    expect(charity).toMatchObject({
      id: riverside,
      slug: 'riverside-youth-fund',
      description: 'Golf coaching for young people by the river.',
      tags: ['youth', 'sport'],
      isFeatured: true,
    });
    expect(charity.images).toHaveLength(1);
    expect(charity.upcomingEvents).toEqual([
      {
        id: expect.any(String) as string,
        title: 'Charity day',
        description: null,
        location: 'Riverside GC',
        startsAt: '2026-10-01T09:00:00Z',
        endsAt: null,
      },
    ]);
  });

  it('needs no sign-in', async () => {
    expect((await request(app).get(`${API_CHARITIES_PATH}/clean-oceans`)).status).toBe(200);
  });

  it.each(['old-friends', 'no-such-charity'])(
    '404 for %s (archived charities look exactly like missing ones)',
    async (slug) => {
      const res = await request(app).get(`${API_CHARITIES_PATH}/${slug}`);
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe(CHARITY_ERROR_CODES.notFound);
    },
  );

  it.each(['Bad_Slug', 'UPPER', '-lead', 'a--b', 'x'.repeat(201), '%27%3B--', '..%2F..%2Fetc'])(
    'a malformed slug (%s) is a 404 and never reaches the database',
    async (slug) => {
      repo.calls.findBySlug = 0;
      const res = await request(app).get(`${API_CHARITIES_PATH}/${slug}`);
      expect(res.status).toBe(404);
      expect(repo.calls.findBySlug).toBe(0);
    },
  );

  it('the directory is read-only: no write methods exist on it', async () => {
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app)
        [method](API_CHARITIES_PATH)
        .set(bearer(aliceToken))
        .send({ name: 'x' });
      expect(res.status, method).toBe(404);
    }
    const adminRes = await request(app)
      .post(API_CHARITIES_PATH)
      .set(bearer(await auth.signToken(ADMIN)))
      .send({ name: 'x' });
    expect(adminRes.status).toBe(404);
  });
});

describe('GET /api/charity-spotlight — homepage (public)', () => {
  it('returns featured, listed charities without sign-in', async () => {
    const res = await request(app).get(API_CHARITY_SPOTLIGHT_PATH);
    expect(res.status).toBe(200);
    expect((res.body as CharitySpotlightResponse).charities.map((c) => c.name)).toEqual([
      'Riverside Youth Fund',
    ]);
  });

  it('is an empty list when nothing is featured', async () => {
    const empty = new InMemoryCharities();
    empty.seedCharity({ name: 'Plain' });
    const emptyApp = createApp(config, {
      auth: auth.deps,
      charities: createCharityService({ repository: empty, now: () => NOW }),
    });
    const res = await request(emptyApp).get(API_CHARITY_SPOTLIGHT_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ charities: [] });
  });
});

describe('/api/me/charity — the signed-in user’s choice (CHR-01, CHR-03)', () => {
  describe('authentication', () => {
    const calls = [
      ['get', undefined],
      ['patch', { percentageBps: 1500 }],
    ] as const;

    it.each(calls)('%s without a token → 401', async (method, body) => {
      const res = await request(app)[method](API_MY_CHARITY_PATH).send(body);
      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe(AUTH_ERROR_CODES.unauthenticated);
    });

    it.each(calls)('%s with a forged token → 401 and nothing is written', async (method, body) => {
      const forged = await auth.signWithUntrustedKey(ALICE);
      const res = await request(app)[method](API_MY_CHARITY_PATH).set(bearer(forged)).send(body);
      expect(res.status).toBe(401);
      expect(repo.calls.updatePreference).toBe(0);
    });

    it('a signed-in account with no profile → 403', async () => {
      const ghost = await auth.signToken('33333333-3333-4333-8333-333333333333');
      const res = await request(app).get(API_MY_CHARITY_PATH).set(bearer(ghost));
      expect(res.status).toBe(403);
    });
  });

  it('GET returns the stored choice with the limits', async () => {
    const res = await request(app).get(API_MY_CHARITY_PATH).set(bearer(bobToken));
    expect(res.status).toBe(200);
    expect((res.body as CharityPreferenceResponse).preference).toEqual({
      charity: { id: oceans, slug: 'clean-oceans', name: 'Clean Oceans', isArchived: false },
      percentageBps: 2500,
      minBps: 1000,
      maxBps: null,
    });
  });

  it('GET for a user who has not chosen a charity yet', async () => {
    const res = await request(app).get(API_MY_CHARITY_PATH).set(bearer(aliceToken));
    expect((res.body as CharityPreferenceResponse).preference).toMatchObject({
      charity: null,
      percentageBps: 1000,
    });
  });

  describe('PATCH', () => {
    const patch = (token: string, body: unknown) =>
      request(app).patch(API_MY_CHARITY_PATH).set(bearer(token)).send(body);

    it('selects a charity', async () => {
      const res = await patch(aliceToken, { charityId: riverside });
      expect(res.status).toBe(200);
      expect((res.body as CharityPreferenceResponse).preference.charity?.slug).toBe(
        'riverside-youth-fund',
      );
      expect(repo.storedProfile(ALICE)?.charityId).toBe(riverside);
    });

    it('sets the percentage, and changes both in one request', async () => {
      const res = await patch(aliceToken, { charityId: oceans, percentageBps: 3300 });
      expect(res.status).toBe(200);
      expect((res.body as CharityPreferenceResponse).preference).toMatchObject({
        percentageBps: 3300,
        charity: { id: oceans },
      });
    });

    it('exactly 10% is accepted; 100% is accepted', async () => {
      expect((await patch(aliceToken, { percentageBps: 1000 })).status).toBe(200);
      expect((await patch(aliceToken, { percentageBps: 10000 })).status).toBe(200);
    });

    it('LOWERING is allowed down to 10% (owner decision D-064)', async () => {
      expect((await patch(bobToken, { percentageBps: 1000 })).status).toBe(200);
      expect(repo.storedProfile(BOB)?.bps).toBe(1000);
      expect((await patch(bobToken, { percentageBps: 6000 })).status).toBe(200);
      expect((await patch(bobToken, { percentageBps: 1000 })).status).toBe(200);
    });

    it.each([999, 500, 0])(
      '%i bps → 422 percentage_below_minimum, nothing changes',
      async (bps) => {
        const res = await patch(bobToken, { percentageBps: bps });
        expect(res.status).toBe(422);
        expect(errorOf(res).code).toBe(CHARITY_ERROR_CODES.percentageBelowMinimum);
        expect(repo.storedProfile(BOB)?.bps).toBe(2500);
      },
    );

    it('above 100% → 422 percentage_above_maximum', async () => {
      const res = await patch(bobToken, { percentageBps: 10001 });
      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe(CHARITY_ERROR_CODES.percentageAboveMaximum);
    });

    it('honours a configured cap', async () => {
      repo.setMaxBps(4000);
      expect((await patch(bobToken, { percentageBps: 4000 })).status).toBe(200);
      const res = await patch(bobToken, { percentageBps: 4001 });
      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe(CHARITY_ERROR_CODES.percentageAboveMaximum);
      const got = await request(app).get(API_MY_CHARITY_PATH).set(bearer(bobToken));
      expect((got.body as CharityPreferenceResponse).preference.maxBps).toBe(4000);
    });

    it('unknown charity → 404; archived charity → 422; the stored choice is kept', async () => {
      const missing = await patch(bobToken, { charityId: '00000000-0000-4000-8000-000000000000' });
      expect(missing.status).toBe(404);
      expect(errorOf(missing).code).toBe(CHARITY_ERROR_CODES.notFound);

      const gone = repo.seedCharity({ name: 'Closing', archived: true });
      const res = await patch(bobToken, { charityId: gone });
      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe(CHARITY_ERROR_CODES.unavailable);
      expect(repo.storedProfile(BOB)?.charityId).toBe(oceans);
    });

    it.each([
      [{}, 'body'],
      [{ percentageBps: '1500' }, 'percentageBps'],
      [{ percentageBps: 15.5 }, 'percentageBps'],
      [{ percentageBps: null }, 'percentageBps'],
      [{ charityId: 'not-a-uuid' }, 'charityId'],
      [{ charityId: 5 }, 'charityId'],
    ])('rejects the invalid body %j → 400 naming %s', async (body, field) => {
      const res = await patch(bobToken, body);
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('validation_failed');
      expect(errorOf(res).fieldErrors?.map((e) => e.field)).toContain(field);
      expect(repo.calls.updatePreference).toBe(0);
    });

    it('rejects a non-object body', async () => {
      for (const body of [[], 'x', 5, null]) {
        const res = await request(app)
          .patch(API_MY_CHARITY_PATH)
          .set(bearer(bobToken))
          .set('content-type', 'application/json')
          .send(JSON.stringify(body));
        expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
      }
    });

    it('needs no subscription: a user with no subscription at all can choose', async () => {
      // The app has no subscription dependency for this domain; ALICE has never subscribed.
      expect((await patch(aliceToken, { charityId: riverside, percentageBps: 1200 })).status).toBe(
        200,
      );
    });

    describe('isolation — a user can only ever change their OWN choice', () => {
      it('a userId / id in the body is ignored', async () => {
        const res = await patch(aliceToken, {
          userId: BOB,
          id: BOB,
          user_id: BOB,
          charityId: riverside,
          percentageBps: 9000,
        });
        expect(res.status).toBe(200);
        expect(repo.storedProfile(ALICE)).toEqual({ charityId: riverside, bps: 9000 });
        expect(repo.storedProfile(BOB)).toEqual({ charityId: oceans, bps: 2500 });
      });

      it('a userId in the query string is ignored', async () => {
        const res = await request(app)
          .patch(`${API_MY_CHARITY_PATH}?userId=${BOB}`)
          .set(bearer(aliceToken))
          .send({ percentageBps: 7000 });
        expect(res.status).toBe(200);
        expect(repo.storedProfile(BOB)?.bps).toBe(2500);
        expect(repo.storedProfile(ALICE)?.bps).toBe(7000);
      });

      it("GET never returns someone else's choice", async () => {
        const res = await request(app)
          .get(`${API_MY_CHARITY_PATH}?userId=${BOB}`)
          .set(bearer(aliceToken));
        expect((res.body as CharityPreferenceResponse).preference.charity).toBeNull();
      });

      it('an admin token gets no special power over another user’s choice', async () => {
        const adminToken = await auth.signToken(ADMIN);
        await request(app)
          .patch(API_MY_CHARITY_PATH)
          .set(bearer(adminToken))
          .send({ userId: BOB, percentageBps: 9999 });
        expect(repo.storedProfile(BOB)?.bps).toBe(2500);
      });
    });
  });

  it('there is no DELETE / PUT on the choice', async () => {
    for (const method of ['delete', 'put', 'post'] as const) {
      const res = await request(app)[method](API_MY_CHARITY_PATH).set(bearer(aliceToken)).send({});
      expect(res.status, method).toBe(404);
    }
  });
});

describe('/api/me/contributions — own history only (CHR-04)', () => {
  it('requires authentication', async () => {
    const res = await request(app).get(API_MY_CONTRIBUTIONS_PATH);
    expect(res.status).toBe(401);
  });

  it("returns the caller's contributions with per-currency totals — nobody else's", async () => {
    repo.seedContribution(ALICE, {
      amountMinor: 500,
      currency: 'USD',
      createdAt: '2026-02-01T00:00:00Z',
    });
    repo.seedContribution(ALICE, {
      amountMinor: 300,
      currency: 'USD',
      source: 'donation',
      percentageBps: null,
      basisMinor: null,
      createdAt: '2026-03-01T00:00:00Z',
    });
    repo.seedContribution(BOB, { amountMinor: 123_456, currency: 'USD' });
    const res = await request(app).get(API_MY_CONTRIBUTIONS_PATH).set(bearer(aliceToken));
    expect(res.status).toBe(200);
    const body = res.body as ListContributionsResponse;
    expect(body.contributions.map((c) => c.amountMinor)).toEqual([300, 500]);
    expect(body.totals).toEqual([{ currency: 'USD', amountMinor: 800 }]);
  });

  it('ignores a userId in the query string', async () => {
    repo.seedContribution(BOB, { amountMinor: 999, currency: 'USD' });
    const res = await request(app)
      .get(`${API_MY_CONTRIBUTIONS_PATH}?userId=${BOB}`)
      .set(bearer(aliceToken));
    expect(res.body).toEqual({ contributions: [], totals: [] });
  });

  it('is read-only: there is no way to create a contribution through the API in this phase', async () => {
    const res = await request(app)
      .post(API_MY_CONTRIBUTIONS_PATH)
      .set(bearer(aliceToken))
      .send({ amountMinor: 500, currency: 'USD', charityId: riverside });
    expect(res.status).toBe(404);
    expect(repo.calls.listContributions).toBe(0);
  });
});

describe('when things are not configured or break', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers 503 on every charity endpoint when the service is not configured', async () => {
    const bare = createApp(config, { auth: auth.deps });
    for (const path of [
      API_CHARITIES_PATH,
      `${API_CHARITIES_PATH}/x`,
      API_CHARITY_SPOTLIGHT_PATH,
    ]) {
      expect((await request(bare).get(path)).status, path).toBe(503);
    }
    for (const path of [API_MY_CHARITY_PATH, API_MY_CONTRIBUTIONS_PATH]) {
      expect((await request(bare).get(path).set(bearer(aliceToken))).status, path).toBe(503);
    }
  });

  it('answers 503 on the user endpoints when auth is not configured (fails closed)', async () => {
    const noAuth = createApp(config, { charities: createCharityService({ repository: repo }) });
    for (const path of [API_MY_CHARITY_PATH, API_MY_CONTRIBUTIONS_PATH]) {
      expect((await request(noAuth).get(path).set(bearer(aliceToken))).status, path).toBe(503);
    }
    // The public directory does not depend on auth.
    expect((await request(noAuth).get(API_CHARITIES_PATH)).status).toBe(200);
  });

  it('a database failure is a generic 500 that leaks nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    repo.failWith = new Error('relation "charities" does not exist (secret detail)');
    for (const [path, token] of [
      [API_CHARITIES_PATH, undefined],
      [`${API_CHARITIES_PATH}/clean-oceans`, undefined],
      [API_CHARITY_SPOTLIGHT_PATH, undefined],
      [API_MY_CHARITY_PATH, aliceToken],
      [API_MY_CONTRIBUTIONS_PATH, aliceToken],
    ] as const) {
      const res = await request(app)
        .get(path)
        .set(token ? bearer(token) : {});
      expect(res.status, path).toBe(500);
      expect(res.text).not.toMatch(/secret detail|relation/);
      expect(errorOf(res).code).toBe('internal_error');
    }
  });
});
