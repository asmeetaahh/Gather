import type { PGlite, Transaction } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { as, asOwner, attempt, createMigratedDatabase, PG, pgError } from './support/database';
import { addScore, createUser } from './support/fixtures';

/**
 * public.add_score(): the atomic "add a score, replacing the oldest" (PRD §05, DECISIONS D-061).
 * The API calls it with the service role; these tests call it the same way.
 */

let db: PGlite;
let user: string;
let other: string;

beforeAll(async () => {
  db = await createMigratedDatabase();
  user = await createUser(db);
  other = await createUser(db);
});

interface AddResult {
  score: { id: string; user_id: string; played_on: string; stableford_score: number };
  replaced_played_on: string | null;
}

/** Calls the function as the API does (service role). */
const add = async (tx: Transaction, userId: string, date: string, value: number) =>
  (
    await tx.query<{ result: AddResult }>(
      `select public.add_score($1::uuid, $2::date, $3::int) as result`,
      [userId, date, value],
    )
  ).rows[0]?.result as AddResult;

const datesOf = async (tx: Transaction, userId: string) =>
  (
    await tx.query<{ d: string }>(
      `select to_char(played_on, 'YYYY-MM-DD') as d from public.scores where user_id = $1 order by played_on desc`,
      [userId],
    )
  ).rows.map((r) => r.d);

/** Runs a scenario as the API's role, inside a rolled-back transaction. */
const asApi = <T>(fn: (tx: Transaction) => Promise<T>) => as(db, { role: 'service_role' }, fn);

/** Gives `userId` five scores dated 2026-03-01 … 2026-03-05, entered in the given order. */
const fillFive = async (tx: Transaction, userId: string, order = [1, 2, 3, 4, 5]) => {
  for (const day of order) await add(tx, userId, `2026-03-0${String(day)}`, 30);
};

describe('adding scores below the limit (SCR-01, SCR-05)', () => {
  it('creates the score and reports that nothing was replaced', async () => {
    await asApi(async (tx) => {
      const result = await add(tx, user, '2026-03-01', 28);
      expect(result.replaced_played_on).toBeNull();
      expect(result.score).toMatchObject({
        user_id: user,
        played_on: '2026-03-01',
        stableford_score: 28,
      });
      expect(await datesOf(tx, user)).toEqual(['2026-03-01']);
    });
  });

  it('keeps all of the first five scores', async () => {
    await asApi(async (tx) => {
      await fillFive(tx, user);
      expect(await datesOf(tx, user)).toEqual([
        '2026-03-05',
        '2026-03-04',
        '2026-03-03',
        '2026-03-02',
        '2026-03-01',
      ]);
    });
  });
});

describe('the sixth score replaces the oldest BY DATE (D-061)', () => {
  it('removes the earliest date and keeps exactly five', async () => {
    await asApi(async (tx) => {
      await fillFive(tx, user);
      const result = await add(tx, user, '2026-03-06', 41);
      expect(result.replaced_played_on).toBe('2026-03-01');
      expect(await datesOf(tx, user)).toEqual([
        '2026-03-06',
        '2026-03-05',
        '2026-03-04',
        '2026-03-03',
        '2026-03-02',
      ]);
    });
  });

  it('uses the round date, not the order of entry', async () => {
    await asApi(async (tx) => {
      // Entered newest-first: the EARLIEST date (03-01) was entered LAST.
      await fillFive(tx, user, [5, 4, 3, 2, 1]);
      const result = await add(tx, user, '2026-03-06', 20);
      expect(result.replaced_played_on).toBe('2026-03-01');
    });
  });

  it('accepts a score dated between existing ones and still drops only the oldest', async () => {
    await asApi(async (tx) => {
      for (const d of ['01', '03', '05', '07', '09']) await add(tx, user, `2026-03-${d}`, 30);
      const result = await add(tx, user, '2026-03-04', 22);
      expect(result.replaced_played_on).toBe('2026-03-01');
      expect(await datesOf(tx, user)).toEqual([
        '2026-03-09',
        '2026-03-07',
        '2026-03-05',
        '2026-03-04',
        '2026-03-03',
      ]);
    });
  });

  it('can be repeated: the limit of five holds through many additions', async () => {
    await asApi(async (tx) => {
      await fillFive(tx, user);
      for (let day = 6; day <= 20; day++)
        await add(tx, user, `2026-03-${String(day).padStart(2, '0')}`, 30);
      expect(await datesOf(tx, user)).toEqual([
        '2026-03-20',
        '2026-03-19',
        '2026-03-18',
        '2026-03-17',
        '2026-03-16',
      ]);
    });
  });
});

describe('a date older than all five scores is rejected and nothing changes (D-061)', () => {
  it('raises GS001 and leaves every score in place', async () => {
    await asApi(async (tx) => {
      await fillFive(tx, user);
      const err = await attempt(tx, () => add(tx, user, '2026-02-15', 30));
      expect(err.code).toBe('GS001');
      expect(await datesOf(tx, user)).toEqual([
        '2026-03-05',
        '2026-03-04',
        '2026-03-03',
        '2026-03-02',
        '2026-03-01',
      ]);
    });
  });

  it('is only a rejection at the limit: with fewer than five, an old date is simply added', async () => {
    await asApi(async (tx) => {
      await add(tx, user, '2026-03-10', 30);
      await add(tx, user, '2020-01-01', 30);
      expect(await datesOf(tx, user)).toEqual(['2026-03-10', '2020-01-01']);
    });
  });
});

describe('one score per date (SCR-04): a duplicate never costs the user their oldest score', () => {
  it('rejects a duplicate date below the limit', async () => {
    await asApi(async (tx) => {
      await add(tx, user, '2026-03-01', 30);
      const err = await attempt(tx, () => add(tx, user, '2026-03-01', 31));
      expect(err.code).toBe(PG.uniqueViolation);
      expect(err.constraint).toBe('scores_one_per_user_per_date');
    });
  });

  it('rejects a duplicate date AT the limit without evicting anything', async () => {
    await asApi(async (tx) => {
      await fillFive(tx, user);
      const err = await attempt(tx, () => add(tx, user, '2026-03-04', 31));
      expect(err.code).toBe(PG.uniqueViolation);
      expect(await datesOf(tx, user)).toEqual([
        '2026-03-05',
        '2026-03-04',
        '2026-03-03',
        '2026-03-02',
        '2026-03-01',
      ]);
    });
  });

  it('allows the same date for a different user', async () => {
    await asApi(async (tx) => {
      await add(tx, user, '2026-03-01', 30);
      await add(tx, other, '2026-03-01', 25);
      expect(await datesOf(tx, other)).toEqual(['2026-03-01']);
    });
  });
});

describe('value and input validation (SCR-02, SCR-03)', () => {
  it.each([1, 45])('accepts the boundary value %i', async (value) => {
    await asApi(async (tx) => {
      const result = await add(tx, user, '2026-03-01', value);
      expect(result.score.stableford_score).toBe(value);
    });
  });

  it.each([0, 46, -1, 100, 32768, 2_000_000_000])(
    'rejects %i with the range error',
    async (value) => {
      await asApi(async (tx) => {
        const err = await attempt(tx, () => add(tx, user, '2026-03-01', value));
        expect(err.code).toBe(PG.checkViolation);
        expect(err.constraint).toBe('scores_stableford_range');
        expect(await datesOf(tx, user)).toEqual([]);
      });
    },
  );

  it('rejects a null score, null date and null user', async () => {
    await asApi(async (tx) => {
      const nulls = [
        `select public.add_score('${user}', '2026-03-01', null)`,
        `select public.add_score('${user}', null, 30)`,
        `select public.add_score(null, '2026-03-01', 30)`,
      ];
      for (const sql of nulls) {
        const err = await attempt(tx, () => tx.query(sql));
        expect(err.code, sql).toBeDefined();
      }
      expect(await datesOf(tx, user)).toEqual([]);
    });
  });

  it('rejects a user that does not exist (foreign key), storing nothing', async () => {
    await asApi(async (tx) => {
      const err = await attempt(tx, () =>
        add(tx, '00000000-0000-0000-0000-00000000dead', '2026-03-01', 30),
      );
      expect(err.code).toBe(PG.foreignKeyViolation);
    });
  });
});

describe('ownership and isolation', () => {
  it("one user's additions and evictions never touch another user's scores", async () => {
    await asApi(async (tx) => {
      await fillFive(tx, other);
      await fillFive(tx, user);
      await add(tx, user, '2026-03-06', 30); // evicts 03-01 for `user` only
      expect(await datesOf(tx, other)).toEqual([
        '2026-03-05',
        '2026-03-04',
        '2026-03-03',
        '2026-03-02',
        '2026-03-01',
      ]);
    });
  });

  it('cooperates with the Phase 1 cap trigger: the trigger still refuses a raw 6th insert', async () => {
    await asOwner(db, async (tx) => {
      await fillFive(tx, user);
      const err = await attempt(tx, () => addScore(tx, user, '2026-03-06'));
      expect(err.constraint).toBe('scores_max_five_per_user');
    });
  });
});

describe('who may call it (it takes an arbitrary user id)', () => {
  it('is executable only by the service role', async () => {
    const { rows } = await db.query<{ role: string; ok: boolean }>(
      `select r as role, has_function_privilege(r, 'public.add_score(uuid, date, integer)', 'EXECUTE') as ok
         from unnest(array['anon','authenticated','service_role']) r order by r`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.role, r.ok]))).toEqual({
      anon: false,
      authenticated: false,
      service_role: true,
    });
  });

  it("a signed-in user cannot write ANOTHER user's scores through it", async () => {
    const err = await as(db, { role: 'authenticated', userId: user }, (tx) =>
      pgError(tx.query(`select public.add_score($1::uuid, '2026-03-01', 30)`, [other])),
    );
    expect(err.code).toBe(PG.insufficientPrivilege);
  });

  it('a visitor cannot call it at all', async () => {
    const err = await as(db, { role: 'anon' }, (tx) =>
      pgError(tx.query(`select public.add_score($1::uuid, '2026-03-01', 30)`, [user])),
    );
    expect(err.code).toBe(PG.insufficientPrivilege);
  });
});

describe('editing and deleting stay plain statements the API scopes by user and date', () => {
  it('SCR-08: editing an existing date updates that score in place (no duplicate, no eviction)', async () => {
    await asApi(async (tx) => {
      await fillFive(tx, user);
      const { rows } = await tx.query<{ stableford_score: number }>(
        `update public.scores set stableford_score = 44 where user_id = $1 and played_on = '2026-03-03' returning stableford_score`,
        [user],
      );
      expect(rows[0]?.stableford_score).toBe(44);
      expect(await datesOf(tx, user)).toHaveLength(5);
    });
  });

  it('SCR-08: deleting frees a slot, so the next add evicts nothing', async () => {
    await asApi(async (tx) => {
      await fillFive(tx, user);
      await tx.query(`delete from public.scores where user_id = $1 and played_on = '2026-03-05'`, [
        user,
      ]);
      const result = await add(tx, user, '2026-03-06', 30);
      expect(result.replaced_played_on).toBeNull();
      expect(await datesOf(tx, user)).toEqual([
        '2026-03-06',
        '2026-03-04',
        '2026-03-03',
        '2026-03-02',
        '2026-03-01',
      ]);
    });
  });
});
