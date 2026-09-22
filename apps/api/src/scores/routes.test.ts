import { beforeEach, describe, expect, it, vi } from 'vitest';
import { request, type TestResponse } from '../test-support/http.js';
import {
  API_SCORES_PATH,
  AUTH_ERROR_CODES,
  SCORE_ERROR_CODES,
  type ApiErrorBody,
  type CreateScoreResponse,
  type ListScoresResponse,
  type UpdateScoreResponse,
} from '@gather/shared';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { ADMIN, ALICE, BOB, createTestAuth, type TestAuth } from '../test-support/auth.js';
import { FakeSubscriptions, InMemoryScores } from '../test-support/scores.js';
import { createScoreService } from './service.js';

const config = loadConfig({ NODE_ENV: 'test' });

let auth: TestAuth;
let scores: InMemoryScores;
let subs: FakeSubscriptions;
let app: ReturnType<typeof createApp>;
let aliceToken: string;
let bobToken: string;

beforeEach(async () => {
  auth = await createTestAuth();
  auth.profiles.add(ALICE, 'user');
  auth.profiles.add(BOB, 'user');
  auth.profiles.add(ADMIN, 'admin');
  scores = new InMemoryScores();
  subs = new FakeSubscriptions();
  subs.active.add(ALICE);
  subs.active.add(BOB);
  app = createApp(config, {
    auth: auth.deps,
    scores: createScoreService({ repository: scores, subscriptions: subs }),
  });
  aliceToken = await auth.signToken(ALICE);
  bobToken = await auth.signToken(BOB);
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const errorOf = (res: TestResponse) => (res.body as ApiErrorBody).error;
const listAs = async (token: string) =>
  ((await request(app).get(API_SCORES_PATH).set(bearer(token))).body as ListScoresResponse).scores;
const add = (token: string, playedOn: string, stablefordScore: number) =>
  request(app).post(API_SCORES_PATH).set(bearer(token)).send({ playedOn, stablefordScore });
const dates = (list: { playedOn: string }[]) => list.map((s) => s.playedOn);

/** Adds five scores 2026-03-01 … 2026-03-05 for a user. */
async function fillFive(token: string) {
  for (let day = 1; day <= 5; day++) await add(token, `2026-03-0${String(day)}`, 30);
}

describe('unauthenticated access is rejected', () => {
  const requests = [
    ['get', API_SCORES_PATH],
    ['post', API_SCORES_PATH],
    ['put', `${API_SCORES_PATH}/2026-03-01`],
    ['delete', `${API_SCORES_PATH}/2026-03-01`],
  ] as const;

  it.each(requests)(
    '%s %s without a token → 401, and storage is never reached',
    async (method, path) => {
      const res = await request(app)
        [method](path)
        .send({ playedOn: '2026-03-01', stablefordScore: 30 });
      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe(AUTH_ERROR_CODES.unauthenticated);
      expect(scores.calls).toEqual({ list: 0, add: 0, update: 0, remove: 0 });
      expect(subs.calls).toBe(0);
    },
  );

  it.each(requests)('%s %s with an invalid token → 401', async (method, path) => {
    const res = await request(app)[method](path).set(bearer('garbage')).send({});
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe(AUTH_ERROR_CODES.invalidToken);
    expect(scores.calls.list + scores.calls.add + scores.calls.update + scores.calls.remove).toBe(
      0,
    );
  });

  it('answers 503 when authentication or the score service is not configured — never a pass-through', async () => {
    const noAuth = createApp(config, {});
    expect((await request(noAuth).get(API_SCORES_PATH).set(bearer(aliceToken))).status).toBe(503);
    const noScores = createApp(config, { auth: auth.deps });
    const res = await request(noScores).get(API_SCORES_PATH).set(bearer(aliceToken));
    expect(res.status).toBe(503);
    expect(errorOf(res).code).toBe('service_unavailable');
  });
});

describe('only subscribers can write; the check happens on every request (SUB-05)', () => {
  beforeEach(() => {
    subs.active.delete(BOB); // Bob is registered but not subscribed
  });

  it('a non-subscriber is refused on every write and nothing reaches storage', async () => {
    const attempts = [
      request(app)
        .post(API_SCORES_PATH)
        .set(bearer(bobToken))
        .send({ playedOn: '2026-03-01', stablefordScore: 30 }),
      request(app)
        .put(`${API_SCORES_PATH}/2026-03-01`)
        .set(bearer(bobToken))
        .send({ stablefordScore: 30 }),
      request(app).delete(`${API_SCORES_PATH}/2026-03-01`).set(bearer(bobToken)),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe(SCORE_ERROR_CODES.subscriptionRequired);
    }
    expect(scores.calls).toEqual({ list: 0, add: 0, update: 0, remove: 0 });
  });

  it('a non-subscriber can still read their own (here empty) history', async () => {
    const res = await request(app).get(API_SCORES_PATH).set(bearer(bobToken));
    expect(res.status).toBe(200);
    expect((res.body as ListScoresResponse).scores).toEqual([]);
    expect(subs.calls).toBe(0); // reading does not need an entitlement
  });

  it('a lapsed subscriber keeps read access to their history but loses write access immediately', async () => {
    scores.seed(BOB, '2026-03-01', 30);
    expect((await listAs(bobToken)).length).toBe(1);
    expect((await add(bobToken, '2026-03-02', 30)).status).toBe(403);
    expect(scores.stored(BOB)).toHaveLength(1);
  });

  it('follows subscription state per request: subscribing enables writes, lapsing disables them again', async () => {
    expect((await add(bobToken, '2026-03-01', 30)).status).toBe(403);
    subs.active.add(BOB);
    expect((await add(bobToken, '2026-03-01', 30)).status).toBe(201);
    subs.active.delete(BOB);
    expect((await add(bobToken, '2026-03-02', 30)).status).toBe(403);
  });

  it('does not exempt administrators: they need a subscription to write their own scores', async () => {
    const res = await add(await auth.signToken(ADMIN), '2026-03-01', 30);
    expect(res.status).toBe(403);
  });

  it('fails closed when the entitlement lookup fails: no write, generic 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    subs.failWith = new Error('rpc is_active_subscriber: db-host.internal refused');
    const res = await add(aliceToken, '2026-03-01', 30);
    expect(res.status).toBe(500);
    expect(errorOf(res).code).toBe('internal_error');
    expect(JSON.stringify(res.body)).not.toMatch(/db-host|refused/);
    expect(scores.calls.add).toBe(0);
  });
});

describe('adding and listing (SCR-01, SCR-07)', () => {
  it('creates a score and returns it with 201', async () => {
    const res = await add(aliceToken, '2026-03-05', 36);
    expect(res.status).toBe(201);
    const body = res.body as CreateScoreResponse;
    expect(body.score).toMatchObject({ playedOn: '2026-03-05', stablefordScore: 36 });
    expect(body.replacedPlayedOn).toBeNull();
  });

  it('lists scores newest → oldest regardless of the order they were entered', async () => {
    for (const day of ['03', '01', '05', '02', '04']) await add(aliceToken, `2026-03-${day}`, 30);
    expect(dates(await listAs(aliceToken))).toEqual([
      '2026-03-05',
      '2026-03-04',
      '2026-03-03',
      '2026-03-02',
      '2026-03-01',
    ]);
  });

  it('accepts the boundary values 1 and 45', async () => {
    expect((await add(aliceToken, '2026-03-01', 1)).status).toBe(201);
    expect((await add(aliceToken, '2026-03-02', 45)).status).toBe(201);
  });

  it('returns an empty list for a user with no scores', async () => {
    expect(await listAs(aliceToken)).toEqual([]);
  });
});

describe('the five-score boundary (SCR-05, SCR-06, D-061)', () => {
  it('keeps the first five with nothing replaced', async () => {
    for (let day = 1; day <= 5; day++) {
      const res = await add(aliceToken, `2026-03-0${String(day)}`, 30);
      expect((res.body as CreateScoreResponse).replacedPlayedOn).toBeNull();
    }
    expect(await listAs(aliceToken)).toHaveLength(5);
  });

  it('the sixth score replaces the oldest BY DATE and says which date was replaced', async () => {
    await fillFive(aliceToken);
    const res = await add(aliceToken, '2026-03-06', 41);
    expect(res.status).toBe(201);
    expect((res.body as CreateScoreResponse).replacedPlayedOn).toBe('2026-03-01');
    expect(dates(await listAs(aliceToken))).toEqual([
      '2026-03-06',
      '2026-03-05',
      '2026-03-04',
      '2026-03-03',
      '2026-03-02',
    ]);
  });

  it('replaces by round date, not entry order (the earliest date entered last is still the oldest)', async () => {
    for (const day of ['05', '04', '03', '02', '01']) await add(aliceToken, `2026-03-${day}`, 30);
    const res = await add(aliceToken, '2026-03-06', 30);
    expect((res.body as CreateScoreResponse).replacedPlayedOn).toBe('2026-03-01');
  });

  it('holds at five through many additions', async () => {
    await fillFive(aliceToken);
    for (let day = 6; day <= 15; day++)
      await add(aliceToken, `2026-03-${String(day).padStart(2, '0')}`, 30);
    expect(dates(await listAs(aliceToken))).toEqual([
      '2026-03-15',
      '2026-03-14',
      '2026-03-13',
      '2026-03-12',
      '2026-03-11',
    ]);
  });

  it('rejects a date older than all five with 422 and changes nothing', async () => {
    await fillFive(aliceToken);
    const before = await listAs(aliceToken);
    const res = await add(aliceToken, '2026-02-15', 30);
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe(SCORE_ERROR_CODES.tooOld);
    expect(await listAs(aliceToken)).toEqual(before);
  });

  it('a duplicate date at the limit is 409 and does NOT cost the user their oldest score', async () => {
    await fillFive(aliceToken);
    const res = await add(aliceToken, '2026-03-04', 31);
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe(SCORE_ERROR_CODES.duplicateDate);
    expect(dates(await listAs(aliceToken))).toContain('2026-03-01');
    expect(await listAs(aliceToken)).toHaveLength(5);
  });

  it('deleting one frees a slot, so the next addition replaces nothing', async () => {
    await fillFive(aliceToken);
    await request(app).delete(`${API_SCORES_PATH}/2026-03-05`).set(bearer(aliceToken));
    const res = await add(aliceToken, '2026-03-06', 30);
    expect((res.body as CreateScoreResponse).replacedPlayedOn).toBeNull();
    expect(await listAs(aliceToken)).toHaveLength(5);
  });
});

describe('one score per date; editing an existing date updates it (SCR-04, SCR-08)', () => {
  it('rejects a second score for the same date with 409', async () => {
    await add(aliceToken, '2026-03-01', 30);
    const res = await add(aliceToken, '2026-03-01', 31);
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe(SCORE_ERROR_CODES.duplicateDate);
    expect(await listAs(aliceToken)).toHaveLength(1);
  });

  it('PUT updates the value in place: same score, no duplicate, no eviction', async () => {
    await fillFive(aliceToken);
    const original = (await listAs(aliceToken)).find((s) => s.playedOn === '2026-03-03');
    const res = await request(app)
      .put(`${API_SCORES_PATH}/2026-03-03`)
      .set(bearer(aliceToken))
      .send({ stablefordScore: 44 });
    expect(res.status).toBe(200);
    const { score } = res.body as UpdateScoreResponse;
    expect(score).toMatchObject({ id: original?.id, playedOn: '2026-03-03', stablefordScore: 44 });
    expect(await listAs(aliceToken)).toHaveLength(5);
    expect(dates(await listAs(aliceToken))).toContain('2026-03-01');
  });

  it('PUT cannot change the date: a playedOn in the body is ignored', async () => {
    await add(aliceToken, '2026-03-03', 30);
    await request(app)
      .put(`${API_SCORES_PATH}/2026-03-03`)
      .set(bearer(aliceToken))
      .send({ stablefordScore: 20, playedOn: '2020-01-01' });
    expect(dates(await listAs(aliceToken))).toEqual(['2026-03-03']);
  });

  it('PUT for a date the user has no score for is 404 and creates nothing', async () => {
    const res = await request(app)
      .put(`${API_SCORES_PATH}/2026-03-03`)
      .set(bearer(aliceToken))
      .send({ stablefordScore: 30 });
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe(SCORE_ERROR_CODES.notFound);
    expect(await listAs(aliceToken)).toEqual([]);
  });

  it('DELETE removes the score (204, empty body); deleting it again is 404', async () => {
    await add(aliceToken, '2026-03-03', 30);
    const first = await request(app)
      .delete(`${API_SCORES_PATH}/2026-03-03`)
      .set(bearer(aliceToken));
    expect(first.status).toBe(204);
    expect(first.text).toBe('');
    expect(await listAs(aliceToken)).toEqual([]);
    const second = await request(app)
      .delete(`${API_SCORES_PATH}/2026-03-03`)
      .set(bearer(aliceToken));
    expect(second.status).toBe(404);
  });
});

describe('validation (SCR-02, SCR-03) — bad input never reaches storage', () => {
  const invalidBodies: [name: string, body: unknown, fields: string[]][] = [
    ['score 0', { playedOn: '2026-03-01', stablefordScore: 0 }, ['stablefordScore']],
    ['score 46', { playedOn: '2026-03-01', stablefordScore: 46 }, ['stablefordScore']],
    ['negative score', { playedOn: '2026-03-01', stablefordScore: -5 }, ['stablefordScore']],
    ['fractional score', { playedOn: '2026-03-01', stablefordScore: 30.5 }, ['stablefordScore']],
    ['score as a string', { playedOn: '2026-03-01', stablefordScore: '30' }, ['stablefordScore']],
    ['score as a boolean', { playedOn: '2026-03-01', stablefordScore: true }, ['stablefordScore']],
    ['null score', { playedOn: '2026-03-01', stablefordScore: null }, ['stablefordScore']],
    ['missing score', { playedOn: '2026-03-01' }, ['stablefordScore']],
    ['missing date', { stablefordScore: 30 }, ['playedOn']],
    ['null date', { playedOn: null, stablefordScore: 30 }, ['playedOn']],
    ['numeric date', { playedOn: 20260301, stablefordScore: 30 }, ['playedOn']],
    ['impossible date', { playedOn: '2026-02-30', stablefordScore: 30 }, ['playedOn']],
    ['wrong format', { playedOn: '01/03/2026', stablefordScore: 30 }, ['playedOn']],
    [
      'date-time instead of date',
      { playedOn: '2026-03-01T10:00:00Z', stablefordScore: 30 },
      ['playedOn'],
    ],
    ['both invalid', { playedOn: 'nope', stablefordScore: 99 }, ['playedOn', 'stablefordScore']],
    ['empty object', {}, ['playedOn', 'stablefordScore']],
    ['array body', [{ playedOn: '2026-03-01', stablefordScore: 30 }], ['body']],
    ['string body', 'hello', ['body']],
  ];

  it.each(invalidBodies)(
    'POST %s → 400 validation_failed naming the field(s)',
    async (_name, body, fields) => {
      const res = await request(app).post(API_SCORES_PATH).set(bearer(aliceToken)).send(body);
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe(SCORE_ERROR_CODES.validation);
      expect(errorOf(res).fieldErrors?.map((e) => e.field)).toEqual(fields);
      expect(scores.calls.add).toBe(0);
    },
  );

  it('rejects malformed JSON with a generic 400 and no detail', async () => {
    const res = await request(app)
      .post(API_SCORES_PATH)
      .set(bearer(aliceToken))
      .set('Content-Type', 'application/json')
      .send('{"playedOn":');
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('bad_request');
    expect(scores.calls.add).toBe(0);
  });

  it('rejects a request with no body', async () => {
    const res = await request(app).post(API_SCORES_PATH).set(bearer(aliceToken));
    expect(res.status).toBe(400);
    expect(scores.calls.add).toBe(0);
  });

  it('PUT validates the value and the date in the path', async () => {
    const badValue = await request(app)
      .put(`${API_SCORES_PATH}/2026-03-01`)
      .set(bearer(aliceToken))
      .send({ stablefordScore: 46 });
    expect(badValue.status).toBe(400);
    const badDate = await request(app)
      .put(`${API_SCORES_PATH}/2026-02-30`)
      .set(bearer(aliceToken))
      .send({ stablefordScore: 30 });
    expect(badDate.status).toBe(400);
    expect(errorOf(badDate).fieldErrors?.[0]?.field).toBe('playedOn');
    expect(scores.calls.update).toBe(0);
  });

  it('DELETE validates the date in the path', async () => {
    for (const bad of ['not-a-date', '2026-13-01', '2026-1-1']) {
      const res = await request(app).delete(`${API_SCORES_PATH}/${bad}`).set(bearer(aliceToken));
      expect(res.status, bad).toBe(400);
    }
    expect(scores.calls.remove).toBe(0);
  });

  it('accepts a future date, because that rule is undecided (D-027) and not enforced', async () => {
    expect((await add(aliceToken, '2099-01-01', 30)).status).toBe(201);
  });
});

describe("ownership and isolation: users never see or change another user's scores", () => {
  beforeEach(async () => {
    await add(aliceToken, '2026-03-01', 30);
    await add(aliceToken, '2026-03-02', 31);
  });

  it('a user lists only their own scores', async () => {
    expect(await listAs(bobToken)).toEqual([]);
    expect(await listAs(aliceToken)).toHaveLength(2);
  });

  it("cannot edit another user's score: the same date is a different (missing) score for them", async () => {
    const res = await request(app)
      .put(`${API_SCORES_PATH}/2026-03-01`)
      .set(bearer(bobToken))
      .send({ stablefordScore: 1 });
    expect(res.status).toBe(404);
    expect(
      (await listAs(aliceToken)).find((s) => s.playedOn === '2026-03-01')?.stablefordScore,
    ).toBe(30);
  });

  it("cannot delete another user's score", async () => {
    const res = await request(app).delete(`${API_SCORES_PATH}/2026-03-01`).set(bearer(bobToken));
    expect(res.status).toBe(404);
    expect(await listAs(aliceToken)).toHaveLength(2);
  });

  it('two users can hold a score for the same date independently', async () => {
    expect((await add(bobToken, '2026-03-01', 22)).status).toBe(201);
    expect(
      (await listAs(aliceToken)).find((s) => s.playedOn === '2026-03-01')?.stablefordScore,
    ).toBe(30);
    expect((await listAs(bobToken)).find((s) => s.playedOn === '2026-03-01')?.stablefordScore).toBe(
      22,
    );
  });

  it("one user's eviction never touches another user's scores", async () => {
    await fillFive(bobToken);
    for (let day = 3; day <= 9; day++) await add(aliceToken, `2026-03-0${String(day)}`, 30); // Alice evicts repeatedly
    expect(dates(await listAs(bobToken))).toEqual([
      '2026-03-05',
      '2026-03-04',
      '2026-03-03',
      '2026-03-02',
      '2026-03-01',
    ]);
  });

  it('ignores an owner supplied in the body, query string or headers: identity comes only from the token', async () => {
    const res = await request(app)
      .post(`${API_SCORES_PATH}?userId=${BOB}&user_id=${BOB}`)
      .set(bearer(aliceToken))
      .set('X-User-Id', BOB)
      .send({ playedOn: '2026-03-10', stablefordScore: 20, userId: BOB, user_id: BOB });
    expect(res.status).toBe(201);
    expect(dates(scores.stored(ALICE))).toContain('2026-03-10');
    expect(scores.stored(BOB)).toEqual([]);

    const list = await request(app).get(`${API_SCORES_PATH}?userId=${ALICE}`).set(bearer(bobToken));
    expect((list.body as ListScoresResponse).scores).toEqual([]);
  });

  it("a token's subject decides everything: swapping tokens swaps the data set", async () => {
    expect(await listAs(aliceToken)).toHaveLength(2);
    expect(await listAs(bobToken)).toHaveLength(0);
    expect(await listAs(await auth.signToken(ALICE))).toHaveLength(2);
  });

  it('there is no way to address another user: every storage call carries the verified id', async () => {
    const spy = vi.spyOn(scores, 'add');
    await add(bobToken, '2026-04-01', 30);
    expect(spy).toHaveBeenCalledWith(BOB, { playedOn: '2026-04-01', stablefordScore: 30 });
  });
});

describe('failures are contained', () => {
  it('a storage failure is a generic 500 that leaks nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    scores.failWith = new Error('relation "scores" does not exist at db-host.internal');
    for (const res of [
      await request(app).get(API_SCORES_PATH).set(bearer(aliceToken)),
      await add(aliceToken, '2026-03-01', 30),
    ]) {
      expect(res.status).toBe(500);
      expect(errorOf(res).code).toBe('internal_error');
      expect(JSON.stringify(res.body)).not.toMatch(/relation|db-host/);
    }
  });
});
