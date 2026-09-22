import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { as, asOwner, attempt, createMigratedDatabase, PG, pgError } from './support/database';
import { TEST_CURRENCY, createDrawWithEntry, createUser } from './support/fixtures';

let db: PGlite;
let user: string;
let admin: string;

beforeAll(async () => {
  db = await createMigratedDatabase();
  user = await createUser(db);
  admin = await createUser(db, { admin: true });
});

describe('published draws are immutable (PRD §07 "enforced automatically")', () => {
  it('a published draw cannot be updated or deleted — not even by the service role', async () => {
    await asOwner(db, async (tx) => {
      const { drawId } = await createDrawWithEntry(tx, user, {
        month: '2027-03-01',
        publish: true,
      });

      for (const change of [
        `update public.draws set winning_numbers = '{9,9,9,9,9}' where id = $1`,
        `update public.draws set mode = 'algorithmic' where id = $1`,
        `update public.draws set prize_pool_minor = 1 where id = $1`,
        `delete from public.draws where id = $1`,
      ]) {
        const err = await attempt(tx, () => tx.query(change, [drawId]));
        expect(err.code, change).toBe(PG.integrityViolation);
        expect(err.message).toMatch(/immutable/);
      }
    });

    // The service role bypasses RLS but must still hit the guard.
    await asOwner(db, async (tx) => {
      const { drawId } = await createDrawWithEntry(tx, user, {
        month: '2027-03-01',
        publish: true,
      });
      await tx.exec('set local role service_role');
      const err = await pgError(
        tx.query(`update public.draws set winning_numbers = '{9,9,9,9,9}' where id = $1`, [drawId]),
      );
      expect(err.code).toBe(PG.integrityViolation);
    });
  });

  it('entries and tier results of a published draw cannot be inserted, changed or removed', async () => {
    await asOwner(db, async (tx) => {
      const { drawId, entryId } = await createDrawWithEntry(tx, user, {
        month: '2027-03-01',
        publish: true,
      });
      const other = await createUser(tx);

      const attempts = [
        [
          `insert into public.draw_entries (draw_id, user_id, entry_numbers) values ($1, $2, '{1}')`,
          [drawId, other],
        ],
        [`update public.draw_entries set match_count = 5 where id = $1`, [entryId]],
        [`delete from public.draw_entries where id = $1`, [entryId]],
        [
          `update public.draw_tier_results set winners_count = 9 where draw_id = $1 and match_count = 3`,
          [drawId],
        ],
        [`delete from public.draw_tier_results where draw_id = $1`, [drawId]],
      ] as const;

      for (const [sql, params] of attempts) {
        const err = await attempt(tx, () => tx.query(sql, [...params]));
        expect(err.code, sql).toBe(PG.integrityViolation);
      }
    });
  });

  it('a published draw keeps the tier shares it used, even if prize_tiers later changes', async () => {
    await asOwner(db, async (tx) => {
      const { drawId } = await createDrawWithEntry(tx, user, {
        month: '2027-03-01',
        publish: true,
      });
      await tx.query(`update public.prize_tiers set share_bps = 1234 where match_count = 5`);
      const { rows } = await tx.query<{ share_bps: number }>(
        `select share_bps from public.draw_tier_results where draw_id = $1 and match_count = 5`,
        [drawId],
      );
      expect(rows[0]?.share_bps).toBe(4000);
    });
  });
});

describe('draft and simulated draws stay editable (simulation before publish, PRD §06)', () => {
  it('can be re-simulated: numbers, entries and tier results are replaceable', async () => {
    await asOwner(db, async (tx) => {
      const { drawId, entryId } = await createDrawWithEntry(tx, user, { month: '2027-04-01' });
      await tx.query(`update public.draws set winning_numbers = '{6,7,8,9,10}' where id = $1`, [
        drawId,
      ]);
      await tx.query(`update public.draw_entries set match_count = 5 where id = $1`, [entryId]);
      await tx.query(`delete from public.draw_tier_results where draw_id = $1`, [drawId]);
      await tx.query(`delete from public.draw_entries where id = $1`, [entryId]);
    });
  });

  it('deleting an unpublished draw removes its candidate rows', async () => {
    await asOwner(db, async (tx) => {
      const { drawId } = await createDrawWithEntry(tx, user, { month: '2027-04-01' });
      await tx.query(`delete from public.draws where id = $1`, [drawId]);
      const { rows } = await tx.query<{ n: number }>(
        `select (select count(*) from public.draw_entries where draw_id = $1)::int
              + (select count(*) from public.draw_tier_results where draw_id = $1)::int as n`,
        [drawId],
      );
      expect(rows[0]?.n).toBe(0);
    });
  });

  it('winners can only be created for a published draw', async () => {
    await asOwner(db, async (tx) => {
      const { drawId, entryId } = await createDrawWithEntry(tx, user, { month: '2027-04-01' });
      const err = await pgError(
        tx.query(
          `insert into public.winners (draw_id, user_id, draw_entry_id, match_count, prize_minor, currency)
           values ($1, $2, $3, 3, 1000, $4)`,
          [drawId, user, entryId, TEST_CURRENCY],
        ),
      );
      expect(err.code).toBe(PG.integrityViolation);
      expect(err.message).toMatch(/published draw/);
    });
  });
});

describe('winners: verification and payout progress, but the win itself is frozen', () => {
  it('PRD §09: an admin can approve/reject proof and mark the payout paid', async () => {
    await asOwner(db, async (tx) => {
      const { winnerId } = await createDrawWithEntry(tx, user, {
        month: '2027-05-01',
        publish: true,
      });
      await tx.query(
        `update public.winners set verification_status = 'pending_review' where id = $1`,
        [winnerId],
      );
      await tx.query(
        `update public.winners set verification_status = 'rejected', reviewed_at = now(), reviewed_by = $2,
                review_note = 'Screenshot unreadable' where id = $1`,
        [winnerId, admin],
      );
      await tx.query(
        `update public.winners set verification_status = 'approved', reviewed_at = now(), reviewed_by = $2 where id = $1`,
        [winnerId, admin],
      );
      await tx.query(
        `update public.winners set payout_status = 'paid', paid_at = now(), paid_by = $2 where id = $1`,
        [winnerId, admin],
      );
      const { rows } = await tx.query<{ payout_status: string; verification_status: string }>(
        `select payout_status, verification_status from public.winners where id = $1`,
        [winnerId],
      );
      expect(rows[0]).toEqual({ payout_status: 'paid', verification_status: 'approved' });
    });
  });

  it('the prize, tier, user and draw of a win can never change', async () => {
    await asOwner(db, async (tx) => {
      const { winnerId } = await createDrawWithEntry(tx, user, {
        month: '2027-05-01',
        publish: true,
      });
      const other = await createUser(tx);
      for (const change of [
        `update public.winners set prize_minor = 999999 where id = $1`,
        `update public.winners set currency = 'EUR' where id = $1`,
        `update public.winners set match_count = 5 where id = $1`,
        `update public.winners set user_id = '${other}' where id = $1`,
      ]) {
        const err = await attempt(tx, () => tx.query(change, [winnerId]));
        expect(err.code, change).toBe(PG.integrityViolation);
      }
    });
  });

  it('PRD §09 "Pending -> Paid": a paid winner can never go back to pending', async () => {
    await asOwner(db, async (tx) => {
      const { winnerId } = await createDrawWithEntry(tx, user, {
        month: '2027-05-01',
        publish: true,
      });
      await tx.query(
        `update public.winners set payout_status = 'paid', paid_at = now() where id = $1`,
        [winnerId],
      );
      const err = await pgError(
        tx.query(
          `update public.winners set payout_status = 'pending', paid_at = null where id = $1`,
          [winnerId],
        ),
      );
      expect(err.code).toBe(PG.integrityViolation);
      expect(err.message).toMatch(/cannot return to pending/);
    });
  });

  it('winner records can never be deleted', async () => {
    await asOwner(db, async (tx) => {
      const { winnerId } = await createDrawWithEntry(tx, user, {
        month: '2027-05-01',
        publish: true,
      });
      const err = await pgError(tx.query(`delete from public.winners where id = $1`, [winnerId]));
      expect(err.code).toBe(PG.integrityViolation);
    });
  });
});

describe('admin audit log is append-only', () => {
  it('the service role can append and read, but never change or delete', async () => {
    await as(db, { role: 'service_role' }, async (tx) => {
      await tx.query(
        `insert into public.admin_audit_log (actor_id, action, entity_type, entity_id, details)
         values ($1, 'draw.publish', 'draw', 'abc', '{"mode":"random"}')`,
        [admin],
      );
      const { rows } = await tx.query<{ action: string }>(
        `select action from public.admin_audit_log`,
      );
      expect(rows.map((r) => r.action)).toContain('draw.publish');

      for (const sql of [
        `update public.admin_audit_log set action = 'tampered'`,
        `delete from public.admin_audit_log`,
      ]) {
        const err = await attempt(tx, () => tx.query(sql));
        expect(err.code, sql).toBe(PG.integrityViolation);
        expect(err.message).toMatch(/append-only/);
      }
    });
  });

  it('survives deletion of the acting user (no foreign key on actor_id)', async () => {
    await asOwner(db, async (tx) => {
      const temp = await createUser(tx);
      await tx.query(
        `insert into public.admin_audit_log (actor_id, action, entity_type) values ($1, 'x', 'y')`,
        [temp],
      );
      await tx.query(`delete from auth.users where id = $1`, [temp]);
      const { rows } = await tx.query<{ n: number }>(
        `select count(*)::int as n from public.admin_audit_log where actor_id = $1`,
        [temp],
      );
      expect(rows[0]?.n).toBe(1);
    });
  });
});
