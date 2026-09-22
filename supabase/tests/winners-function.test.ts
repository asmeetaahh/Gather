import type { PGlite, Transaction } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { as, asOwner, attempt, createMigratedDatabase, PG, pgError } from './support/database';
import { createDrawWithEntry, createUser } from './support/fixtures';

/**
 * The database side of winner verification and payout tracking (Phase 7, migration …160000):
 * `register_winner_proof()`, `reopen_winner_proof()`, `review_winner()`, `mark_winner_paid()`.
 * Winner creation itself (one per user per draw, only for a published draw) is Phase 6's
 * `publish_draw()`, re-verified only in passing here; `immutability.test.ts` and `storage.test.ts`
 * already cover the guard triggers and storage RLS these functions rely on.
 */

let db: PGlite;
let alice: string;
let bob: string;
let admin: string;

beforeAll(async () => {
  db = await createMigratedDatabase();
  alice = await createUser(db);
  bob = await createUser(db);
  admin = await createUser(db, { admin: true });
});

async function registerProof(
  tx: Transaction,
  winnerId: string,
  userId: string,
  storagePath: string,
): Promise<void> {
  await tx.query(`select public.register_winner_proof($1::uuid, $2::uuid, $3::text)`, [
    winnerId,
    userId,
    storagePath,
  ]);
}
async function reopenProof(tx: Transaction, winnerId: string, userId: string): Promise<void> {
  await tx.query(`select public.reopen_winner_proof($1::uuid, $2::uuid)`, [winnerId, userId]);
}
async function review(
  tx: Transaction,
  winnerId: string,
  adminId: string,
  decision: 'approved' | 'rejected',
  note: string | null = null,
): Promise<void> {
  await tx.query(
    `select public.review_winner($1::uuid, $2::uuid, $3::public.verification_status, $4::text)`,
    [winnerId, adminId, decision, note],
  );
}
async function markPaid(tx: Transaction, winnerId: string, adminId: string): Promise<void> {
  await tx.query(`select public.mark_winner_paid($1::uuid, $2::uuid)`, [winnerId, adminId]);
}

const winnerRow = (tx: Transaction, id: string) =>
  tx.query<{
    verification_status: string;
    payout_status: string;
    reviewed_by: string | null;
    reviewed_at: string | null;
    review_note: string | null;
    paid_at: string | null;
    paid_by: string | null;
  }>(
    `select verification_status, payout_status, reviewed_by, reviewed_at, review_note, paid_at, paid_by
       from public.winners where id = $1`,
    [id],
  );
const proofRows = (tx: Transaction, winnerId: string) =>
  tx.query<{ storage_path: string }>(
    `select storage_path from public.winner_proofs where winner_id = $1 order by uploaded_at`,
    [winnerId],
  );

/** Inserts a `storage.objects` row the way an RLS-permitted direct upload would leave one. */
async function putObject(tx: Transaction, path: string): Promise<void> {
  await tx.query(`insert into storage.objects (bucket_id, name) values ('winner-proofs', $1)`, [
    path,
  ]);
}

describe('register_winner_proof() — records an already-uploaded screenshot (PRD §09, D-021/D-037)', () => {
  it('registers the metadata and moves verification to pending_review', async () => {
    await asOwner(db, async (tx) => {
      const { winnerId } = await createDrawWithEntry(tx, alice, {
        month: '2027-06-01',
        publish: true,
      });
      const winner = winnerId as string;
      await putObject(tx, `${winner}/screenshot.png`);

      await registerProof(tx, winner, alice, `${winner}/screenshot.png`);

      const { rows } = await winnerRow(tx, winner);
      expect(rows[0]?.verification_status).toBe('pending_review');
      const { rows: proofs } = await proofRows(tx, winner);
      expect(proofs).toEqual([{ storage_path: `${winner}/screenshot.png` }]);
    });
  });

  it('refuses when the winner is not awaiting proof (GS007)', async () => {
    await asOwner(db, async (tx) => {
      const { winnerId } = await createDrawWithEntry(tx, alice, {
        month: '2027-06-01',
        publish: true,
      });
      const winner = winnerId as string;
      await putObject(tx, `${winner}/a.png`);
      await registerProof(tx, winner, alice, `${winner}/a.png`); // -> pending_review

      await putObject(tx, `${winner}/b.png`);
      const err = await attempt(tx, () => registerProof(tx, winner, alice, `${winner}/b.png`));
      expect(err.code).toBe('GS007');
      const { rows: proofs } = await proofRows(tx, winner);
      expect(proofs).toEqual([{ storage_path: `${winner}/a.png` }]); // unchanged
    });
  });

  it('refuses when the storage object does not exist yet (GS008)', async () => {
    await asOwner(db, async (tx) => {
      const { winnerId } = await createDrawWithEntry(tx, alice, {
        month: '2027-06-01',
        publish: true,
      });
      const winner = winnerId as string;
      const err = await attempt(tx, () =>
        registerProof(tx, winner, alice, `${winner}/never-uploaded.png`),
      );
      expect(err.code).toBe('GS008');
    });
  });

  it("refuses a storage path outside the winner's own folder, even if that object exists (GS009)", async () => {
    await asOwner(db, async (tx) => {
      const { winnerId: aWinnerId } = await createDrawWithEntry(tx, alice, {
        month: '2027-06-01',
        publish: true,
      });
      const { winnerId: bWinnerId } = await createDrawWithEntry(tx, bob, {
        month: '2027-11-01', // a different month from alice's draw above (same transaction)
        publish: true,
      });
      const aliceWinner = aWinnerId as string;
      const bobWinner = bWinnerId as string;
      // Bob's real, already-uploaded object.
      await putObject(tx, `${bobWinner}/his-screenshot.png`);

      // Alice tries to register HER OWN winner using BOB's object path.
      const err = await attempt(tx, () =>
        registerProof(tx, aliceWinner, alice, `${bobWinner}/his-screenshot.png`),
      );
      expect(err.code).toBe('GS009');
      const { rows: proofs } = await proofRows(tx, aliceWinner);
      expect(proofs).toEqual([]);
    });
  });

  it('is idempotent for an exact repeat of an already-registered path (client retry)', async () => {
    await asOwner(db, async (tx) => {
      const { winnerId } = await createDrawWithEntry(tx, alice, {
        month: '2027-06-01',
        publish: true,
      });
      const winner = winnerId as string;
      await putObject(tx, `${winner}/x.png`);
      await registerProof(tx, winner, alice, `${winner}/x.png`);
      await registerProof(tx, winner, alice, `${winner}/x.png`); // repeat: no error, no second row

      const { rows: proofs } = await proofRows(tx, winner);
      expect(proofs).toEqual([{ storage_path: `${winner}/x.png` }]);
    });
  });

  it('refuses to register proof for a winner that belongs to someone else', async () => {
    await asOwner(db, async (tx) => {
      const { winnerId } = await createDrawWithEntry(tx, alice, {
        month: '2027-06-01',
        publish: true,
      });
      const winner = winnerId as string;
      await putObject(tx, `${winner}/x.png`);
      const err = await attempt(tx, () => registerProof(tx, winner, bob, `${winner}/x.png`));
      expect(err.code).toBe('23503');
    });
  });

  it('rejects an unknown winner id', async () => {
    await asOwner(db, async (tx) => {
      const err = await attempt(tx, () =>
        registerProof(tx, '00000000-0000-4000-8000-00000000dead', alice, 'x/y.png'),
      );
      expect(err.code).toBe('23503');
    });
  });
});

describe('reopen_winner_proof() — resubmission after rejection (D-021/D-037)', () => {
  async function rejectedWinner(tx: Transaction, month: string): Promise<string> {
    const { winnerId } = await createDrawWithEntry(tx, alice, { month, publish: true });
    const winner = winnerId as string;
    await putObject(tx, `${winner}/first.png`);
    await registerProof(tx, winner, alice, `${winner}/first.png`);
    await review(tx, winner, admin, 'rejected', 'Screenshot unreadable');
    return winner;
  }

  it('moves a rejected winner back to awaiting_proof, so the storage policy permits a new upload', async () => {
    await asOwner(db, async (tx) => {
      const winner = await rejectedWinner(tx, '2027-07-01');
      await reopenProof(tx, winner, alice);
      const { rows } = await winnerRow(tx, winner);
      expect(rows[0]?.verification_status).toBe('awaiting_proof');
      // The winners row describes the CURRENT decision only (winners_review_timestamp CHECK), so
      // it is cleared back to "nothing decided yet"; the permanent record of the rejection lives
      // in admin_audit_log (written by the API alongside review_winner()), not here.
      expect(rows[0]).toMatchObject({ reviewed_by: null, reviewed_at: null, review_note: null });

      // A full resubmission round-trip now works and accumulates a SECOND proof row.
      await putObject(tx, `${winner}/second.png`);
      await registerProof(tx, winner, alice, `${winner}/second.png`);
      const { rows: proofs } = await proofRows(tx, winner);
      expect(proofs.map((p) => p.storage_path)).toEqual([
        `${winner}/first.png`,
        `${winner}/second.png`,
      ]);
      expect((await winnerRow(tx, winner)).rows[0]?.verification_status).toBe('pending_review');
    });
  });

  it('refuses to reopen a winner that is not rejected (GS010)', async () => {
    await asOwner(db, async (tx) => {
      const { winnerId } = await createDrawWithEntry(tx, alice, {
        month: '2027-07-01',
        publish: true,
      });
      const winner = winnerId as string;
      const err = await attempt(tx, () => reopenProof(tx, winner, alice));
      expect(err.code).toBe('GS010'); // still awaiting_proof, nothing to reopen
    });
  });

  it('approved proof cannot be reopened — it is not improperly overwritable', async () => {
    await asOwner(db, async (tx) => {
      const { winnerId } = await createDrawWithEntry(tx, alice, {
        month: '2027-07-01',
        publish: true,
      });
      const winner = winnerId as string;
      await putObject(tx, `${winner}/a.png`);
      await registerProof(tx, winner, alice, `${winner}/a.png`);
      await review(tx, winner, admin, 'approved');

      const err = await attempt(tx, () => reopenProof(tx, winner, alice));
      expect(err.code).toBe('GS010');
      expect((await winnerRow(tx, winner)).rows[0]?.verification_status).toBe('approved');
    });
  });

  it('refuses to reopen a winner that belongs to someone else', async () => {
    await asOwner(db, async (tx) => {
      const winner = await rejectedWinner(tx, '2027-07-01');
      const err = await attempt(tx, () => reopenProof(tx, winner, bob));
      expect(err.code).toBe('23503');
    });
  });
});

describe('review_winner() — admin approve/reject (PRD §09 DRW-11)', () => {
  async function pendingWinner(tx: Transaction, month: string): Promise<string> {
    const { winnerId } = await createDrawWithEntry(tx, alice, { month, publish: true });
    const winner = winnerId as string;
    await putObject(tx, `${winner}/x.png`);
    await registerProof(tx, winner, alice, `${winner}/x.png`);
    return winner;
  }

  it('approves a pending submission, recording who and when', async () => {
    await asOwner(db, async (tx) => {
      const winner = await pendingWinner(tx, '2027-08-01');
      await review(tx, winner, admin, 'approved');
      const { rows } = await winnerRow(tx, winner);
      expect(rows[0]?.verification_status).toBe('approved');
      expect(rows[0]?.reviewed_by).toBe(admin);
      expect(rows[0]?.reviewed_at).not.toBeNull();
    });
  });

  it('rejects a pending submission with a note', async () => {
    await asOwner(db, async (tx) => {
      const winner = await pendingWinner(tx, '2027-08-01');
      await review(tx, winner, admin, 'rejected', 'Wrong screenshot');
      const { rows } = await winnerRow(tx, winner);
      expect(rows[0]).toMatchObject({
        verification_status: 'rejected',
        review_note: 'Wrong screenshot',
      });
    });
  });

  it('refuses to decide a winner with nothing submitted yet (GS011)', async () => {
    await asOwner(db, async (tx) => {
      const { winnerId } = await createDrawWithEntry(tx, alice, {
        month: '2027-08-01',
        publish: true,
      });
      const err = await attempt(tx, () => review(tx, winnerId as string, admin, 'approved'));
      expect(err.code).toBe('GS011');
    });
  });

  it('an already-decided winner cannot be decided again — approved proof is not improperly overwritten (GS011)', async () => {
    await asOwner(db, async (tx) => {
      const winner = await pendingWinner(tx, '2027-08-01');
      await review(tx, winner, admin, 'approved');
      const err = await attempt(tx, () => review(tx, winner, admin, 'rejected', 'changed my mind'));
      expect(err.code).toBe('GS011');
      const { rows } = await winnerRow(tx, winner);
      expect(rows[0]?.verification_status).toBe('approved'); // unchanged
      expect(rows[0]?.review_note).toBeNull();
    });
  });

  it('rejects an unknown winner id', async () => {
    await asOwner(db, async (tx) => {
      const err = await attempt(tx, () =>
        review(tx, '00000000-0000-4000-8000-00000000dead', admin, 'approved'),
      );
      expect(err.code).toBe('23503');
    });
  });
});

describe('mark_winner_paid() — Pending -> Paid (PRD §09 DRW-12, §11 ADM-06)', () => {
  async function approvedWinner(tx: Transaction, month: string): Promise<string> {
    const { winnerId } = await createDrawWithEntry(tx, alice, { month, publish: true });
    const winner = winnerId as string;
    await putObject(tx, `${winner}/x.png`);
    await registerProof(tx, winner, alice, `${winner}/x.png`);
    await review(tx, winner, admin, 'approved');
    return winner;
  }

  it('marks an approved winner paid, recording who and when', async () => {
    await asOwner(db, async (tx) => {
      const winner = await approvedWinner(tx, '2027-09-01');
      await markPaid(tx, winner, admin);
      const { rows } = await winnerRow(tx, winner);
      expect(rows[0]?.payout_status).toBe('paid');
      expect(rows[0]?.paid_by).toBe(admin);
      expect(rows[0]?.paid_at).not.toBeNull();
    });
  });

  it('refuses to pay a winner that is not approved yet (GS012) — implementation decision extending D-022', async () => {
    await asOwner(db, async (tx) => {
      const { winnerId } = await createDrawWithEntry(tx, alice, {
        month: '2027-09-01',
        publish: true,
      });
      const winner = winnerId as string;
      let err = await attempt(tx, () => markPaid(tx, winner, admin));
      expect(err.code).toBe('GS012'); // awaiting_proof

      await putObject(tx, `${winner}/x.png`);
      await registerProof(tx, winner, alice, `${winner}/x.png`);
      err = await attempt(tx, () => markPaid(tx, winner, admin));
      expect(err.code).toBe('GS012'); // pending_review

      await review(tx, winner, admin, 'rejected', 'no');
      err = await attempt(tx, () => markPaid(tx, winner, admin));
      expect(err.code).toBe('GS012'); // rejected

      expect((await winnerRow(tx, winner)).rows[0]?.payout_status).toBe('pending');
    });
  });

  it('is IDEMPOTENT: marking an already-paid winner paid again changes nothing (paid_at/paid_by preserved)', async () => {
    await asOwner(db, async (tx) => {
      const winner = await approvedWinner(tx, '2027-09-01');
      await markPaid(tx, winner, admin);
      const before = (await winnerRow(tx, winner)).rows[0];

      const other = await createUser(tx, { admin: true });
      await markPaid(tx, winner, other); // a second admin, retried call
      const after = (await winnerRow(tx, winner)).rows[0];
      expect(after).toEqual(before); // still the FIRST admin's paid_at/paid_by
    });
  });

  it('a paid winner can never be marked paid by a different admin after being reset — the guard trigger still holds', async () => {
    await asOwner(db, async (tx) => {
      const winner = await approvedWinner(tx, '2027-09-01');
      await markPaid(tx, winner, admin);
      const err = await pgError(
        tx.query(`update public.winners set payout_status = 'pending' where id = $1`, [winner]),
      );
      expect(err.code).toBe(PG.integrityViolation); // guard_winner(): paid cannot revert
    });
  });

  it('rejects an unknown winner id', async () => {
    await asOwner(db, async (tx) => {
      const err = await attempt(tx, () =>
        markPaid(tx, '00000000-0000-4000-8000-00000000dead', admin),
      );
      expect(err.code).toBe('23503');
    });
  });
});

describe('the four winner-verification functions are service-role only', () => {
  const FUNCTIONS = [
    'register_winner_proof',
    'reopen_winner_proof',
    'review_winner',
    'mark_winner_paid',
  ];

  it('are executable by service_role only — never anon, authenticated or public', async () => {
    for (const fn of FUNCTIONS) {
      const { rows } = await db.query<{
        anon: boolean;
        authed: boolean;
        pub: boolean;
        service: boolean;
      }>(
        `select has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as authed,
                has_function_privilege('public', p.oid, 'execute') as pub,
                has_function_privilege('service_role', p.oid, 'execute') as service
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`,
        [fn],
      );
      expect(rows[0], fn).toEqual({ anon: false, authed: false, pub: false, service: true });
    }
  });

  it('a signed-in user cannot call review_winner or mark_winner_paid through the RPC surface', async () => {
    const { winnerId } = await asOwner(db, (tx) =>
      createDrawWithEntry(tx, alice, { month: '2027-09-01', publish: true }),
    );
    const winner = winnerId as string;
    await as(db, { role: 'authenticated', userId: alice }, async (tx) => {
      const err = await attempt(tx, () =>
        tx.query(
          `select public.review_winner($1::uuid, $2::uuid, 'approved'::public.verification_status, null)`,
          [winner, alice],
        ),
      );
      expect(err.code).toBe(PG.insufficientPrivilege);
    });
    await as(db, { role: 'authenticated', userId: alice }, async (tx) => {
      const err = await attempt(tx, () =>
        tx.query(`select public.mark_winner_paid($1::uuid, $2::uuid)`, [winner, alice]),
      );
      expect(err.code).toBe(PG.insufficientPrivilege);
    });
  });
});

describe('winner creation stays tied to a published draw, without duplicates (Phase 6, re-affirmed here)', () => {
  it('one winner per user per draw (unique constraint) — publish_draw() never creates a duplicate', async () => {
    await asOwner(db, async (tx) => {
      const { winnerId } = await createDrawWithEntry(tx, alice, {
        month: '2027-10-01',
        publish: true,
      });
      const { rows } = await tx.query<{ n: number }>(
        `select count(*) as n from public.winners where id = $1`,
        [winnerId],
      );
      expect(rows[0]?.n).toBe(1);
    });
  });

  it('an unpublished (draft/simulated) draw can never have a payable winner: no winner row exists at all', async () => {
    await asOwner(db, async (tx) => {
      const { drawId } = await createDrawWithEntry(tx, alice, {
        month: '2027-10-01',
        status: 'draft',
      });
      const { rows } = await tx.query<{ n: number }>(
        `select count(*) as n from public.winners where draw_id = $1`,
        [drawId],
      );
      expect(rows[0]?.n).toBe(0);
    });
  });
});
