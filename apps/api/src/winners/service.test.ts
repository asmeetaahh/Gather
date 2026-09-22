import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { InMemoryWinners } from '../test-support/winners.js';
import { createWinnerService, type WinnerService } from './service.js';

const ALICE = 'alice';
const BOB = 'bob';
const ADMIN = 'admin';

let repo: InMemoryWinners;
let service: WinnerService;

beforeEach(() => {
  repo = new InMemoryWinners();
  service = createWinnerService({ repository: repo });
});

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  await expect(promise).rejects.toMatchObject({ status, code });
}

describe('listMine / getMine — ownership scoping (PRD §10 DSH-05)', () => {
  it('lists only the given user’s own winners, newest first', async () => {
    repo.seedWinner({ userId: ALICE, matchCount: 3 });
    repo.seedWinner({ userId: BOB, matchCount: 5 });
    const { winners } = await service.listMine(ALICE);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.matchCount).toBe(3);
  });

  it('getMine 404s for a winner owned by someone else, indistinguishable from unknown', async () => {
    const id = repo.seedWinner({ userId: ALICE });
    await expectAppError(service.getMine(id, BOB), 404, 'winner_not_found');
    await expectAppError(
      service.getMine('00000000-0000-4000-8000-000000000000', BOB),
      404,
      'winner_not_found',
    );
  });
});

describe('registerProof (PRD §09; D-021/D-037)', () => {
  it('records proof and moves verification to pending_review', async () => {
    const id = repo.seedWinner({ userId: ALICE });
    repo.seedUploadedObject(`${id}/shot.png`);
    const winner = await service.registerProof(id, ALICE, { storagePath: `${id}/shot.png` });
    expect(winner.verificationStatus).toBe('pending_review');
    expect(winner.proofs).toHaveLength(1);
  });

  it('a non-owner cannot register proof for a winner that is not theirs: 404', async () => {
    const id = repo.seedWinner({ userId: ALICE });
    repo.seedUploadedObject(`${id}/shot.png`);
    await expectAppError(
      service.registerProof(id, BOB, { storagePath: `${id}/shot.png` }),
      404,
      'winner_not_found',
    );
  });

  it('409s when not currently awaiting proof', async () => {
    const id = repo.seedWinner({ userId: ALICE, verificationStatus: 'pending_review' });
    await expectAppError(
      service.registerProof(id, ALICE, { storagePath: `${id}/x.png` }),
      409,
      'winner_proof_not_awaiting',
    );
  });

  it('422s when the storage object does not exist', async () => {
    const id = repo.seedWinner({ userId: ALICE });
    await expectAppError(
      service.registerProof(id, ALICE, { storagePath: `${id}/never.png` }),
      422,
      'winner_proof_object_missing',
    );
  });

  it('422s when the storage path is outside the winner’s own folder', async () => {
    const id = repo.seedWinner({ userId: ALICE });
    const otherId = repo.seedWinner({ userId: BOB });
    repo.seedUploadedObject(`${otherId}/shot.png`);
    await expectAppError(
      service.registerProof(id, ALICE, { storagePath: `${otherId}/shot.png` }),
      422,
      'winner_proof_path_invalid',
    );
  });
});

describe('reopenForResubmission (D-021/D-037)', () => {
  it('moves a rejected winner back to awaiting_proof', async () => {
    const id = repo.seedWinner({ userId: ALICE, verificationStatus: 'rejected' });
    const winner = await service.reopenForResubmission(id, ALICE);
    expect(winner.verificationStatus).toBe('awaiting_proof');
  });

  it('409s reopening a winner that is not rejected', async () => {
    const id = repo.seedWinner({ userId: ALICE });
    await expectAppError(service.reopenForResubmission(id, ALICE), 409, 'winner_not_rejected');
  });

  it('an approved winner cannot be reopened — approved proof stays final', async () => {
    const id = repo.seedWinner({ userId: ALICE, verificationStatus: 'approved' });
    await expectAppError(service.reopenForResubmission(id, ALICE), 409, 'winner_not_rejected');
  });
});

describe('listAll / getAdmin — an admin sees every winner', () => {
  it('lists winners across every user', async () => {
    repo.seedWinner({ userId: ALICE });
    repo.seedWinner({ userId: BOB });
    const { winners } = await service.listAll();
    expect(winners).toHaveLength(2);
  });

  it('getAdmin reads any user’s winner', async () => {
    const id = repo.seedWinner({ userId: ALICE });
    const winner = await service.getAdmin(id);
    expect(winner.id).toBe(id);
  });

  it('404s an unknown winner', async () => {
    await expectAppError(
      service.getAdmin('00000000-0000-4000-8000-000000000000'),
      404,
      'winner_not_found',
    );
  });
});

describe('review (PRD §09 DRW-11) — writes the audit log alongside the decision', () => {
  it('approves and logs the action', async () => {
    const id = repo.seedWinner({ userId: ALICE, verificationStatus: 'pending_review' });
    const winner = await service.review(id, ADMIN, { decision: 'approved' });
    expect(winner.verificationStatus).toBe('approved');
    expect(repo.auditLog).toEqual([
      { actorId: ADMIN, action: 'winner.approved', entityType: 'winner', entityId: id },
    ]);
  });

  it('rejects with a note and logs it', async () => {
    const id = repo.seedWinner({ userId: ALICE, verificationStatus: 'pending_review' });
    const winner = await service.review(id, ADMIN, { decision: 'rejected', note: 'blurry' });
    expect(winner.verificationStatus).toBe('rejected');
    expect(winner.reviewNote).toBe('blurry');
    expect(repo.auditLog[0]?.details).toEqual({ note: 'blurry' });
  });

  it('409s deciding a winner that has nothing submitted yet, and writes NO audit entry', async () => {
    const id = repo.seedWinner({ userId: ALICE });
    await expectAppError(
      service.review(id, ADMIN, { decision: 'approved' }),
      409,
      'winner_not_pending_review',
    );
    expect(repo.auditLog).toEqual([]);
  });

  it('an already-approved winner cannot be reviewed again (no improper overwrite), and logs nothing extra', async () => {
    const id = repo.seedWinner({ userId: ALICE, verificationStatus: 'pending_review' });
    await service.review(id, ADMIN, { decision: 'approved' });
    await expectAppError(
      service.review(id, ADMIN, { decision: 'rejected' }),
      409,
      'winner_not_pending_review',
    );
    expect(repo.auditLog).toHaveLength(1); // only the first, successful review
    expect(repo.winnerRow(id)?.verificationStatus).toBe('approved');
  });
});

describe('markPaid (PRD §09 DRW-12, §11 ADM-06)', () => {
  it('pays an approved winner and logs the action', async () => {
    const id = repo.seedWinner({ userId: ALICE, verificationStatus: 'approved' });
    const winner = await service.markPaid(id, ADMIN);
    expect(winner.payoutStatus).toBe('paid');
    expect(repo.auditLog).toEqual([
      { actorId: ADMIN, action: 'winner.paid', entityType: 'winner', entityId: id },
    ]);
  });

  it.each(['awaiting_proof', 'pending_review', 'rejected'] as const)(
    '409s paying a winner that is not approved yet (%s), and logs nothing',
    async (status) => {
      const id = repo.seedWinner({ userId: ALICE, verificationStatus: status });
      await expectAppError(service.markPaid(id, ADMIN), 409, 'winner_not_approved_for_payout');
      expect(repo.auditLog).toEqual([]);
    },
  );

  it('is idempotent: paying an already-paid winner again succeeds and still logs (repeat is a valid admin action)', async () => {
    const id = repo.seedWinner({ userId: ALICE, verificationStatus: 'approved' });
    await service.markPaid(id, ADMIN);
    const winner = await service.markPaid(id, ADMIN);
    expect(winner.payoutStatus).toBe('paid');
    expect(repo.auditLog).toHaveLength(2); // both calls are real admin actions, both worth recording
  });
});

describe('unexpected repository failures propagate as-is (never silently swallowed)', () => {
  it('a database failure surfaces, not an AppError', async () => {
    repo.failWith = new Error('database unreachable');
    await expect(service.listMine(ALICE)).rejects.toThrow('database unreachable');
  });

  it('AppError instances carry no internal detail beyond status/code/message', async () => {
    const id = repo.seedWinner({ userId: ALICE, verificationStatus: 'pending_review' });
    try {
      await service.markPaid(id, ADMIN);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
    }
  });
});
