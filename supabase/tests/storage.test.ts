import type { PGlite, Transaction } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { STORAGE_BUCKETS } from '@gather/shared';
import {
  as,
  asOwner,
  attempt,
  createMigratedDatabase,
  impersonate,
  PG,
  pgError,
  type Actor,
} from './support/database';
import { createDrawWithEntry, createUser } from './support/fixtures';

const PROOFS = STORAGE_BUCKETS.winnerProofs;
const MEDIA = STORAGE_BUCKETS.charityMedia;

let db: PGlite;
let alice: string; // winner, still awaiting proof
let bob: string; // winner in a different draw
let mallory: string; // regular user, not a winner
let admin: string;
let aliceWinner: string;
let bobWinner: string;

const anon: Actor = { role: 'anon' };
const asUser = (userId: string): Actor => ({ role: 'authenticated', userId });

beforeAll(async () => {
  db = await createMigratedDatabase();
  [alice, bob, mallory] = [await createUser(db), await createUser(db), await createUser(db)];
  admin = await createUser(db, { admin: true });

  aliceWinner =
    (await createDrawWithEntry(db, alice, { month: '2027-01-01', publish: true })).winnerId ?? '';
  bobWinner =
    (await createDrawWithEntry(db, bob, { month: '2027-02-01', publish: true })).winnerId ?? '';

  // Objects that already exist (uploaded earlier).
  await db.query(
    `insert into storage.objects (bucket_id, name) values
       ($1, $2), ($1, $3), ($4, 'logos/a.png')`,
    [PROOFS, `${bobWinner}/proof.png`, `${aliceWinner}/existing.png`, MEDIA],
  );
});

const upload = (bucket: string, path: string) => (tx: Transaction) =>
  tx.query(`insert into storage.objects (bucket_id, name) values ($1, $2)`, [bucket, path]);

describe('winner-proofs bucket is private (PRD §09)', () => {
  it('a winner can upload proof into the folder of their own winner record', async () => {
    await as(db, asUser(alice), async (tx) => {
      const res = await upload(PROOFS, `${aliceWinner}/screenshot.png`)(tx);
      expect(res.affectedRows).toBe(1);
    });
  });

  it("cannot upload into another winner's folder, an arbitrary folder, or the bucket root", async () => {
    for (const path of [
      `${bobWinner}/x.png`,
      'random-folder/x.png',
      'x.png',
      `${aliceWinner.toUpperCase()}x/x.png`,
    ]) {
      const err = await as(db, asUser(alice), (tx) => pgError(upload(PROOFS, path)(tx)));
      expect(err.code, path).toBe(PG.insufficientPrivilege);
    }
  });

  it('a user who is not a winner cannot upload at all', async () => {
    const err = await as(db, asUser(mallory), (tx) =>
      pgError(upload(PROOFS, `${aliceWinner}/x.png`)(tx)),
    );
    expect(err.code).toBe(PG.insufficientPrivilege);
  });

  it('anonymous visitors cannot upload', async () => {
    const err = await as(db, anon, (tx) => pgError(upload(PROOFS, `${aliceWinner}/x.png`)(tx)));
    expect(err.code).toBe(PG.insufficientPrivilege);
  });

  it('uploads stop once the proof is under review or decided (D-021/D-037: only awaiting_proof may upload)', async () => {
    for (const status of ['pending_review', 'approved', 'rejected']) {
      await asOwner(db, async (tx) => {
        const extra = status === 'pending_review' ? '' : `, reviewed_at = now()`;
        await tx.query(`update public.winners set verification_status = $2${extra} where id = $1`, [
          aliceWinner,
          status,
        ]);
        await impersonate(tx, asUser(alice));
        const err = await pgError(upload(PROOFS, `${aliceWinner}/again.png`)(tx));
        expect(err.code, status).toBe(PG.insufficientPrivilege);
      });
    }
  });

  it('resubmission after rejection (Phase 7, D-021/D-037): reopen_winner_proof() is what lets the RLS upload succeed again', async () => {
    await asOwner(db, async (tx) => {
      await tx.query(
        `update public.winners set verification_status = 'rejected', reviewed_at = now() where id = $1`,
        [aliceWinner],
      );
      // Still rejected: the RLS policy alone never lets this through, on its own.
      await impersonate(tx, asUser(alice));
      const blocked = await attempt(tx, () => upload(PROOFS, `${aliceWinner}/resubmit.png`)(tx));
      expect(blocked.code).toBe(PG.insufficientPrivilege);

      // The service role explicitly reopens it (the only supported path back to awaiting_proof)...
      await impersonate(tx, { role: 'service_role' });
      await tx.query(`select public.reopen_winner_proof($1::uuid, $2::uuid)`, [aliceWinner, alice]);

      // ...and now the SAME RLS policy that blocked the upload above permits it, unchanged.
      await impersonate(tx, asUser(alice));
      const res = await upload(PROOFS, `${aliceWinner}/resubmit.png`)(tx);
      expect(res.affectedRows).toBe(1);
    });
  });

  it('only the owner and admins can read proof; other users and anon see nothing', async () => {
    const visible = (actor: Actor) =>
      as(db, actor, async (tx) =>
        (
          await tx.query<{ name: string }>(
            `select name from storage.objects where bucket_id = $1 order by name`,
            [PROOFS],
          )
        ).rows.map((r) => r.name),
      );

    expect(await visible(asUser(bob))).toEqual([`${bobWinner}/proof.png`]);
    expect(await visible(asUser(alice))).toEqual([`${aliceWinner}/existing.png`]);
    expect(await visible(asUser(mallory))).toEqual([]);
    expect(await visible(anon)).toEqual([]);
    expect(await visible(asUser(admin))).toEqual(
      [`${aliceWinner}/existing.png`, `${bobWinner}/proof.png`].sort(),
    );
  });

  it('proof is immutable to end users: no update or delete, even for the owner', async () => {
    for (const sql of [
      `update storage.objects set name = '${aliceWinner}/renamed.png' where bucket_id = '${PROOFS}'`,
      `delete from storage.objects where bucket_id = '${PROOFS}'`,
    ]) {
      await as(db, asUser(alice), async (tx) => {
        const res = await tx.query(sql);
        expect(res.affectedRows, sql).toBe(0);
      });
    }
    // ...and an admin cannot alter proof through the browser role either (API only).
    await as(db, asUser(admin), async (tx) => {
      expect(
        (await tx.query(`delete from storage.objects where bucket_id = '${PROOFS}'`)).affectedRows,
      ).toBe(0);
    });
  });

  it('the API (service role) can manage proof objects', async () => {
    await as(db, { role: 'service_role' }, async (tx) => {
      await upload(PROOFS, `${aliceWinner}/api-upload.png`)(tx);
      const res = await tx.query(`delete from storage.objects where bucket_id = $1`, [PROOFS]);
      expect(res.affectedRows).toBeGreaterThan(0);
    });
  });
});

describe('charity-media bucket is public-read, admin-write', () => {
  it('anyone, including anonymous visitors, can read charity media', async () => {
    for (const actor of [anon, asUser(mallory), asUser(admin)]) {
      await as(db, actor, async (tx) => {
        const { rows } = await tx.query(`select name from storage.objects where bucket_id = $1`, [
          MEDIA,
        ]);
        expect(rows).toHaveLength(1);
      });
    }
  });

  it('only an admin can upload, replace or delete', async () => {
    await as(db, asUser(admin), async (tx) => {
      expect((await upload(MEDIA, 'logos/b.png')(tx)).affectedRows).toBe(1);
      expect(
        (
          await tx.query(
            `update storage.objects set name = 'logos/c.png' where name = 'logos/a.png'`,
          )
        ).affectedRows,
      ).toBe(1);
      expect(
        (await tx.query(`delete from storage.objects where name = 'logos/c.png'`)).affectedRows,
      ).toBe(1);
    });
  });

  it('regular users and visitors cannot write to charity media', async () => {
    for (const actor of [anon, asUser(mallory), asUser(alice)]) {
      const err = await as(db, actor, (tx) => pgError(upload(MEDIA, 'logos/evil.png')(tx)));
      expect(err.code).toBe(PG.insufficientPrivilege);
      await as(db, actor, async (tx) => {
        expect(
          (await tx.query(`delete from storage.objects where bucket_id = $1`, [MEDIA]))
            .affectedRows,
        ).toBe(0);
        expect(
          (await tx.query(`update storage.objects set name = 'x' where bucket_id = $1`, [MEDIA]))
            .affectedRows,
        ).toBe(0);
      });
    }
  });

  it('an admin uploading to the proof bucket is not a loophole: charity policies are bucket-scoped', async () => {
    const err = await as(db, asUser(admin), (tx) =>
      pgError(upload(PROOFS, `${aliceWinner}/admin-upload.png`)(tx)),
    );
    expect(err.code).toBe(PG.insufficientPrivilege);
  });
});
