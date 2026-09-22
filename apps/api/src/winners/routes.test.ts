import { beforeEach, describe, expect, it } from 'vitest';
import {
  API_ADMIN_WINNERS_PATH,
  API_MY_WINNERS_PATH,
  WINNER_ERROR_CODES,
  type ApiErrorBody,
  type ListWinnersResponse,
  type WinnerResponse,
} from '@gather/shared';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { ADMIN, ALICE, BOB, createTestAuth, type TestAuth } from '../test-support/auth.js';
import { InMemoryWinners } from '../test-support/winners.js';
import { request, type TestResponse } from '../test-support/http.js';
import { createWinnerService } from './service.js';

const config = loadConfig({ NODE_ENV: 'test' });

let auth: TestAuth;
let repo: InMemoryWinners;
let app: ReturnType<typeof createApp>;
let adminToken: string;
let aliceToken: string;
let bobToken: string;

function buildApp(deps: { winners?: boolean } = {}) {
  return createApp(config, {
    auth: auth.deps,
    ...(deps.winners !== false && { winners: createWinnerService({ repository: repo }) }),
  });
}

beforeEach(async () => {
  auth = await createTestAuth();
  auth.profiles.add(ADMIN, 'admin');
  auth.profiles.add(ALICE, 'user');
  auth.profiles.add(BOB, 'user');
  repo = new InMemoryWinners();
  app = buildApp();
  adminToken = await auth.signToken(ADMIN);
  aliceToken = await auth.signToken(ALICE);
  bobToken = await auth.signToken(BOB);
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const errorOf = (res: TestResponse) => (res.body as ApiErrorBody).error;
const UUID = '00000000-0000-4000-8000-000000000000';

describe('every /api/me/winners endpoint requires sign-in (PRD §10 DSH-05, ROL-03)', () => {
  const calls: readonly ['get' | 'post', string][] = [
    ['get', API_MY_WINNERS_PATH],
    ['get', `${API_MY_WINNERS_PATH}/${UUID}`],
    ['post', `${API_MY_WINNERS_PATH}/${UUID}/proof`],
    ['post', `${API_MY_WINNERS_PATH}/${UUID}/proof/reopen`],
  ];

  it.each(calls)('%s %s without a token → 401', async (method, path) => {
    expect((await request(app)[method](path)).status).toBe(401);
  });

  it.each(calls)('%s %s with a forged token → 401', async (method, path) => {
    const forged = await auth.signWithUntrustedKey(ALICE);
    expect((await request(app)[method](path).set(bearer(forged))).status).toBe(401);
  });

  it.each(calls)('%s %s → 503 when the winner service is not wired', async (method, path) => {
    const bare = buildApp({ winners: false });
    expect((await request(bare)[method](path).set(bearer(aliceToken))).status).toBe(503);
  });
});

describe('every /api/admin/winners endpoint requires an admin (PRD §11 ADM-06)', () => {
  const calls: readonly ['get' | 'post', string][] = [
    ['get', API_ADMIN_WINNERS_PATH],
    ['get', `${API_ADMIN_WINNERS_PATH}/${UUID}`],
    ['post', `${API_ADMIN_WINNERS_PATH}/${UUID}/review`],
    ['post', `${API_ADMIN_WINNERS_PATH}/${UUID}/paid`],
  ];

  it.each(calls)('%s %s without a token → 401', async (method, path) => {
    expect((await request(app)[method](path)).status).toBe(401);
  });

  it.each(calls)(
    '%s %s as a regular (non-admin) user → 403, and the repository is never even asked',
    async (method, path) => {
      const res = await request(app)[method](path).set(bearer(aliceToken));
      expect(res.status).toBe(403);
      expect(repo.auditLog).toEqual([]);
    },
  );

  it.each(calls)('%s %s with a forged token → 401', async (method, path) => {
    const forged = await auth.signWithUntrustedKey(ADMIN);
    expect((await request(app)[method](path).set(bearer(forged))).status).toBe(401);
  });

  it.each(calls)('%s %s → 503 when the winner service is not wired', async (method, path) => {
    const bare = buildApp({ winners: false });
    expect((await request(bare)[method](path).set(bearer(adminToken))).status).toBe(503);
  });
});

describe('GET /api/me/winners — non-winner cannot see winners that are not theirs', () => {
  it('lists only the caller’s own winners', async () => {
    repo.seedWinner({ userId: ALICE, matchCount: 5 });
    repo.seedWinner({ userId: BOB, matchCount: 3 });

    const res = await request(app).get(API_MY_WINNERS_PATH).set(bearer(aliceToken));
    expect(res.status).toBe(200);
    const winners = (res.body as ListWinnersResponse).winners;
    expect(winners).toHaveLength(1);
    expect(winners[0]?.matchCount).toBe(5);
  });

  it('an empty list for a signed-in user who never won anything', async () => {
    const res = await request(app).get(API_MY_WINNERS_PATH).set(bearer(aliceToken));
    expect(res.status).toBe(200);
    expect((res.body as ListWinnersResponse).winners).toEqual([]);
  });
});

describe('GET /api/me/winners/:id — another user cannot access someone else’s winner or proof', () => {
  it('404s for a winner belonging to another user (never 403 — no existence leak)', async () => {
    const winnerId = repo.seedWinner({ userId: ALICE });
    const res = await request(app).get(`${API_MY_WINNERS_PATH}/${winnerId}`).set(bearer(bobToken));
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe(WINNER_ERROR_CODES.notFound);
  });

  it('404s an unknown id, and a malformed id never reaches the repository', async () => {
    const res1 = await request(app).get(`${API_MY_WINNERS_PATH}/${UUID}`).set(bearer(aliceToken));
    expect(res1.status).toBe(404);
    const res2 = await request(app)
      .get(`${API_MY_WINNERS_PATH}/not-a-uuid`)
      .set(bearer(aliceToken));
    expect(res2.status).toBe(404);
  });

  it('the owner sees their own winner, including a signed proof URL once uploaded', async () => {
    const winnerId = repo.seedWinner({ userId: ALICE, matchCount: 4, prizeMinor: 500 });
    repo.seedUploadedObject(`${winnerId}/shot.png`);
    await request(app)
      .post(`${API_MY_WINNERS_PATH}/${winnerId}/proof`)
      .set(bearer(aliceToken))
      .send({ storagePath: `${winnerId}/shot.png` });

    const res = await request(app)
      .get(`${API_MY_WINNERS_PATH}/${winnerId}`)
      .set(bearer(aliceToken));
    expect(res.status).toBe(200);
    const winner = (res.body as WinnerResponse).winner;
    expect(winner.matchCount).toBe(4);
    expect(winner.proofs).toHaveLength(1);
    expect(winner.proofs[0]?.url).not.toBeNull();
  });
});

describe('POST /api/me/winners/:id/proof — a winner can upload proof; a non-winner cannot', () => {
  it('registers already-uploaded proof and moves verification to pending_review', async () => {
    const winnerId = repo.seedWinner({ userId: ALICE });
    repo.seedUploadedObject(`${winnerId}/shot.png`);

    const res = await request(app)
      .post(`${API_MY_WINNERS_PATH}/${winnerId}/proof`)
      .set(bearer(aliceToken))
      .send({ storagePath: `${winnerId}/shot.png` });
    expect(res.status).toBe(200);
    expect((res.body as WinnerResponse).winner.verificationStatus).toBe('pending_review');
  });

  it('a non-winner (never won anything) cannot create/upload proof: 404, never leaking that the winner exists', async () => {
    const winnerId = repo.seedWinner({ userId: ALICE });
    repo.seedUploadedObject(`${winnerId}/shot.png`);

    const res = await request(app)
      .post(`${API_MY_WINNERS_PATH}/${winnerId}/proof`)
      .set(bearer(bobToken))
      .send({ storagePath: `${winnerId}/shot.png` });
    expect(res.status).toBe(404);
  });

  it('409s when the winner is not currently awaiting proof', async () => {
    const winnerId = repo.seedWinner({ userId: ALICE, verificationStatus: 'pending_review' });
    const res = await request(app)
      .post(`${API_MY_WINNERS_PATH}/${winnerId}/proof`)
      .set(bearer(aliceToken))
      .send({ storagePath: `${winnerId}/x.png` });
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe(WINNER_ERROR_CODES.proofNotAwaiting);
  });

  it('422s when the storage object has not actually been uploaded yet', async () => {
    const winnerId = repo.seedWinner({ userId: ALICE });
    const res = await request(app)
      .post(`${API_MY_WINNERS_PATH}/${winnerId}/proof`)
      .set(bearer(aliceToken))
      .send({ storagePath: `${winnerId}/never-uploaded.png` });
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe(WINNER_ERROR_CODES.proofObjectMissing);
  });

  it('rejects an invalid body before touching the repository', async () => {
    const winnerId = repo.seedWinner({ userId: ALICE });
    const res = await request(app)
      .post(`${API_MY_WINNERS_PATH}/${winnerId}/proof`)
      .set(bearer(aliceToken))
      .send({});
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('validation_failed');
  });
});

describe('POST /api/me/winners/:id/proof/reopen — rejected proof can be replaced', () => {
  it('reopens a rejected winner so a new proof can be registered', async () => {
    const winnerId = repo.seedWinner({ userId: ALICE, verificationStatus: 'rejected' });
    const reopened = await request(app)
      .post(`${API_MY_WINNERS_PATH}/${winnerId}/proof/reopen`)
      .set(bearer(aliceToken));
    expect(reopened.status).toBe(200);
    expect((reopened.body as WinnerResponse).winner.verificationStatus).toBe('awaiting_proof');

    repo.seedUploadedObject(`${winnerId}/second-try.png`);
    const uploaded = await request(app)
      .post(`${API_MY_WINNERS_PATH}/${winnerId}/proof`)
      .set(bearer(aliceToken))
      .send({ storagePath: `${winnerId}/second-try.png` });
    expect(uploaded.status).toBe(200);
    expect((uploaded.body as WinnerResponse).winner.verificationStatus).toBe('pending_review');
  });

  it('409s reopening a winner that is not rejected (e.g. still awaiting proof)', async () => {
    const winnerId = repo.seedWinner({ userId: ALICE });
    const res = await request(app)
      .post(`${API_MY_WINNERS_PATH}/${winnerId}/proof/reopen`)
      .set(bearer(aliceToken));
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe(WINNER_ERROR_CODES.notRejected);
  });

  it('approved proof cannot be improperly overwritten: reopening an approved winner is refused', async () => {
    const winnerId = repo.seedWinner({ userId: ALICE, verificationStatus: 'approved' });
    const res = await request(app)
      .post(`${API_MY_WINNERS_PATH}/${winnerId}/proof/reopen`)
      .set(bearer(aliceToken));
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe(WINNER_ERROR_CODES.notRejected);
  });

  it('another user cannot reopen someone else’s rejected winner', async () => {
    const winnerId = repo.seedWinner({ userId: ALICE, verificationStatus: 'rejected' });
    const res = await request(app)
      .post(`${API_MY_WINNERS_PATH}/${winnerId}/proof/reopen`)
      .set(bearer(bobToken));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/admin/winners — admin can securely review every winner', () => {
  it('lists every winner, across users', async () => {
    repo.seedWinner({ userId: ALICE });
    repo.seedWinner({ userId: BOB });
    const res = await request(app).get(API_ADMIN_WINNERS_PATH).set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect((res.body as ListWinnersResponse).winners).toHaveLength(2);
  });

  it('an admin can read the winner detail, including proofs, of ANY user', async () => {
    const winnerId = repo.seedWinner({ userId: ALICE, verificationStatus: 'pending_review' });
    const res = await request(app)
      .get(`${API_ADMIN_WINNERS_PATH}/${winnerId}`)
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect((res.body as WinnerResponse).winner.id).toBe(winnerId);
  });

  it('404s an unknown winner', async () => {
    const res = await request(app).get(`${API_ADMIN_WINNERS_PATH}/${UUID}`).set(bearer(adminToken));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/admin/winners/:id/review — approve/reject (PRD §09 DRW-11)', () => {
  it('approves a pending submission and writes an audit log entry', async () => {
    const winnerId = repo.seedWinner({ userId: ALICE, verificationStatus: 'pending_review' });
    const res = await request(app)
      .post(`${API_ADMIN_WINNERS_PATH}/${winnerId}/review`)
      .set(bearer(adminToken))
      .send({ decision: 'approved' });
    expect(res.status).toBe(200);
    expect((res.body as WinnerResponse).winner.verificationStatus).toBe('approved');
    expect(repo.auditLog).toEqual([
      { actorId: ADMIN, action: 'winner.approved', entityType: 'winner', entityId: winnerId },
    ]);
  });

  it('rejects with a note, recorded in the audit log', async () => {
    const winnerId = repo.seedWinner({ userId: ALICE, verificationStatus: 'pending_review' });
    const res = await request(app)
      .post(`${API_ADMIN_WINNERS_PATH}/${winnerId}/review`)
      .set(bearer(adminToken))
      .send({ decision: 'rejected', note: 'Blurry screenshot' });
    expect(res.status).toBe(200);
    const winner = (res.body as WinnerResponse).winner;
    expect(winner.verificationStatus).toBe('rejected');
    expect(winner.reviewNote).toBe('Blurry screenshot');
    expect(repo.auditLog).toEqual([
      {
        actorId: ADMIN,
        action: 'winner.rejected',
        entityType: 'winner',
        entityId: winnerId,
        details: { note: 'Blurry screenshot' },
      },
    ]);
  });

  it('409s reviewing a winner that is not pending review (nothing submitted yet)', async () => {
    const winnerId = repo.seedWinner({ userId: ALICE });
    const res = await request(app)
      .post(`${API_ADMIN_WINNERS_PATH}/${winnerId}/review`)
      .set(bearer(adminToken))
      .send({ decision: 'approved' });
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe(WINNER_ERROR_CODES.notPendingReview);
  });

  it('approved proof cannot be improperly overwritten: a second review call is refused', async () => {
    const winnerId = repo.seedWinner({ userId: ALICE, verificationStatus: 'pending_review' });
    await request(app)
      .post(`${API_ADMIN_WINNERS_PATH}/${winnerId}/review`)
      .set(bearer(adminToken))
      .send({ decision: 'approved' });
    const res = await request(app)
      .post(`${API_ADMIN_WINNERS_PATH}/${winnerId}/review`)
      .set(bearer(adminToken))
      .send({ decision: 'rejected' });
    expect(res.status).toBe(409);
    expect(repo.winnerRow(winnerId)?.verificationStatus).toBe('approved'); // unchanged
  });

  it('rejects an invalid decision before touching the repository', async () => {
    const winnerId = repo.seedWinner({ userId: ALICE, verificationStatus: 'pending_review' });
    const res = await request(app)
      .post(`${API_ADMIN_WINNERS_PATH}/${winnerId}/review`)
      .set(bearer(adminToken))
      .send({ decision: 'maybe' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/winners/:id/paid — payout transitions are authorized and valid (PRD §09 DRW-12)', () => {
  it('marks an approved winner paid and writes an audit log entry', async () => {
    const winnerId = repo.seedWinner({ userId: ALICE, verificationStatus: 'approved' });
    const res = await request(app)
      .post(`${API_ADMIN_WINNERS_PATH}/${winnerId}/paid`)
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect((res.body as WinnerResponse).winner.payoutStatus).toBe('paid');
    expect(repo.auditLog).toEqual([
      { actorId: ADMIN, action: 'winner.paid', entityType: 'winner', entityId: winnerId },
    ]);
  });

  it('409s marking an unapproved winner paid (awaiting_proof, pending_review or rejected)', async () => {
    for (const status of ['awaiting_proof', 'pending_review', 'rejected'] as const) {
      const winnerId = repo.seedWinner({ userId: ALICE, verificationStatus: status });
      const res = await request(app)
        .post(`${API_ADMIN_WINNERS_PATH}/${winnerId}/paid`)
        .set(bearer(adminToken));
      expect(res.status, status).toBe(409);
      expect(errorOf(res).code, status).toBe(WINNER_ERROR_CODES.notApproved);
    }
  });

  it('is idempotent over HTTP: marking an already-paid winner paid again still succeeds, unchanged', async () => {
    const winnerId = repo.seedWinner({ userId: ALICE, verificationStatus: 'approved' });
    const first = await request(app)
      .post(`${API_ADMIN_WINNERS_PATH}/${winnerId}/paid`)
      .set(bearer(adminToken));
    const second = await request(app)
      .post(`${API_ADMIN_WINNERS_PATH}/${winnerId}/paid`)
      .set(bearer(adminToken));
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('404s an unknown winner', async () => {
    const res = await request(app)
      .post(`${API_ADMIN_WINNERS_PATH}/${UUID}/paid`)
      .set(bearer(adminToken));
    expect(res.status).toBe(404);
  });
});

describe('there is no way to delete or directly edit a winner over HTTP', () => {
  it('DELETE / PUT are not routes on either surface', async () => {
    for (const base of [API_MY_WINNERS_PATH, API_ADMIN_WINNERS_PATH]) {
      for (const method of ['delete', 'put'] as const) {
        const token = base === API_MY_WINNERS_PATH ? aliceToken : adminToken;
        const res = await request(app)[method](`${base}/${UUID}`).set(bearer(token));
        expect(res.status, `${method} ${base}`).toBe(404);
      }
    }
  });
});
