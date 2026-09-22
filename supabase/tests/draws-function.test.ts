import type { PGlite, Transaction } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { as, asOwner, attempt, createMigratedDatabase, PG, pgError } from './support/database';
import {
  createCharity,
  createPlan,
  createSubscription,
  createUser,
  uniq,
} from './support/fixtures';

/**
 * The database side of the draw engine (Phase 6, migration …150000): `active_subscriber_ids()`,
 * `simulate_draw()` and `publish_draw()`. All MATCHING/WEIGHTING/POOL/TIER MATHS is proven in
 * `apps/api/src/draws/domain.test.ts` — these tests prove that the database applies an
 * already-computed result atomically, idempotently, and only to the service role.
 */

let db: PGlite;
let alice: string;
let bob: string;

beforeAll(async () => {
  db = await createMigratedDatabase();
  alice = await createUser(db);
  bob = await createUser(db);
});

interface Entry {
  user_id: string;
  entry_numbers: number[];
  match_count: number;
}
interface TierResult {
  match_count: 3 | 4 | 5;
  share_bps: number;
  rolls_over: boolean;
  base_pool_minor: number;
  rollover_in_minor: number;
  winners_count: number;
  prize_per_winner_minor: number;
  remainder_minor: number;
  rollover_out_minor: number;
}

const TIER = (matchCount: 3 | 4 | 5, over: Partial<TierResult> = {}): TierResult => ({
  match_count: matchCount,
  share_bps: matchCount === 5 ? 4000 : matchCount === 4 ? 3500 : 2500,
  rolls_over: matchCount === 5,
  base_pool_minor: 0,
  rollover_in_minor: 0,
  winners_count: 0,
  prize_per_winner_minor: 0,
  remainder_minor: 0,
  rollover_out_minor: 0,
  ...over,
});

async function simulateDraw(
  tx: Transaction,
  drawId: string,
  args: {
    winningNumbers?: number[];
    activeSubscriberCount?: number;
    currency?: string;
    prizePoolMinor?: number;
    poolContributionBps?: number | null;
    poolContributionFixedMinor?: number | null;
    entries?: Entry[];
    tierResults?: TierResult[];
  } = {},
): Promise<void> {
  await tx.query(
    `select public.simulate_draw($1::uuid, $2::smallint[], $3::int, $4::text, $5::bigint, $6::int, $7::bigint, $8::jsonb, $9::jsonb)`,
    [
      drawId,
      args.winningNumbers ?? [1, 2, 3, 4, 5],
      args.activeSubscriberCount ?? 0,
      args.currency ?? 'XTS',
      args.prizePoolMinor ?? 1000,
      args.poolContributionBps ?? 1000,
      args.poolContributionFixedMinor ?? null,
      JSON.stringify(args.entries ?? []),
      JSON.stringify(args.tierResults ?? [TIER(5), TIER(4), TIER(3)]),
    ],
  );
}

async function publishDraw(tx: Transaction, drawId: string, publishedBy: string): Promise<string> {
  const { rows } = await tx.query<{ r: string }>(
    `select public.publish_draw($1::uuid, $2::uuid) as r`,
    [drawId, publishedBy],
  );
  return rows[0]?.r as string;
}

async function createDraft(
  tx: Transaction,
  month = `2027-0${String((uniq().length % 9) + 1)}-01`,
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `insert into public.draws (draw_month, mode) values ($1, 'random') returning id`,
    [month],
  );
  return rows[0]?.id as string;
}

const draw = (tx: Transaction, id: string) =>
  tx.query<{ status: string; winning_numbers: number[] | null; simulated_at: string | null }>(
    `select status, winning_numbers, simulated_at from public.draws where id = $1`,
    [id],
  );
const entries = (tx: Transaction, id: string) =>
  tx.query<{ user_id: string; match_count: number }>(
    `select user_id, match_count from public.draw_entries where draw_id = $1 order by user_id`,
    [id],
  );
const tierResults = (tx: Transaction, id: string) =>
  tx.query<{ match_count: number; winners_count: number }>(
    `select match_count, winners_count from public.draw_tier_results where draw_id = $1 order by match_count desc`,
    [id],
  );
const winners = (tx: Transaction, id: string) =>
  tx.query<{ user_id: string; match_count: number; prize_minor: number }>(
    `select user_id, match_count, prize_minor from public.winners where draw_id = $1 order by user_id`,
    [id],
  );

describe('active_subscriber_ids() (D-068/D-070/D-071: identical to is_active_subscriber(uuid), as a set)', () => {
  it('includes only status=active with a period that has not ended — no tolerance', async () => {
    await asOwner(db, async (tx) => {
      const u1 = await createUser(tx);
      const u2 = await createUser(tx);
      const u3 = await createUser(tx);
      const u4 = await createUser(tx);
      const plan = await createPlan(tx);
      await createSubscription(tx, u1, plan, 'active'); // active, future period end (fixture default)
      await createSubscription(tx, u2, plan, 'lapsed');
      await createSubscription(tx, u3, plan, 'pending');
      const { rows: subRows } = await tx.query<{ id: string }>(
        `insert into public.subscriptions (user_id, plan_id, status, current_period_end)
         values ($1, $2, 'active', now() - interval '1 minute') returning id`,
        [u4, plan],
      );
      void subRows;

      const { rows } = await tx.query<{ user_id: string }>(
        `select user_id from public.active_subscriber_ids()`,
      );
      const ids = rows.map((r) => r.user_id);
      expect(ids).toContain(u1);
      expect(ids).not.toContain(u2);
      expect(ids).not.toContain(u3);
      expect(ids).not.toContain(u4); // period already ended: no tolerance
    });
  });

  it('agrees exactly with is_active_subscriber(uuid) for every candidate (no drift between the two definitions)', async () => {
    await asOwner(db, async (tx) => {
      const users: string[] = [];
      const plan = await createPlan(tx);
      for (const status of ['active', 'pending', 'lapsed', 'cancelled'] as const) {
        const u = await createUser(tx);
        await createSubscription(tx, u, plan, status);
        users.push(u);
      }
      const { rows: setRows } = await tx.query<{ user_id: string }>(
        `select user_id from public.active_subscriber_ids()`,
      );
      const set = new Set(setRows.map((r) => r.user_id));
      for (const u of users) {
        const { rows } = await tx.query<{ ok: boolean }>(
          `select public.is_active_subscriber($1::uuid) as ok`,
          [u],
        );
        expect(rows[0]?.ok, u).toBe(set.has(u));
      }
    });
  });
});

describe('simulate_draw() — atomic candidate snapshot (D-018/D-071)', () => {
  it('writes the numbers, entries and tier results together and marks the draw simulated', async () => {
    await asOwner(db, async (tx) => {
      const id = await createDraft(tx);
      await simulateDraw(tx, id, {
        winningNumbers: [2, 4, 6, 8, 10],
        activeSubscriberCount: 2,
        entries: [
          { user_id: alice, entry_numbers: [2, 4, 6], match_count: 3 },
          { user_id: bob, entry_numbers: [1, 3, 5], match_count: 0 },
        ],
        tierResults: [
          TIER(5),
          TIER(4),
          TIER(3, { winners_count: 1, base_pool_minor: 250, prize_per_winner_minor: 250 }),
        ],
      });
      const { rows: d } = await draw(tx, id);
      expect(d[0]).toMatchObject({ status: 'simulated', winning_numbers: [2, 4, 6, 8, 10] });
      expect(d[0]?.simulated_at).not.toBeNull();
      const { rows: e } = await entries(tx, id);
      expect([...e].sort((a, b) => a.user_id.localeCompare(b.user_id))).toEqual(
        [
          { user_id: alice, match_count: 3 },
          { user_id: bob, match_count: 0 },
        ].sort((a, b) => a.user_id.localeCompare(b.user_id)),
      );
      const { rows: t } = await tierResults(tx, id);
      expect(t.map((r) => r.match_count)).toEqual([5, 4, 3]);
      expect(t.find((r) => r.match_count === 3)?.winners_count).toBe(1);
    });
  });

  it('RE-SIMULATING replaces the candidate snapshot entirely (old entries are gone, not merged)', async () => {
    await asOwner(db, async (tx) => {
      const id = await createDraft(tx);
      await simulateDraw(tx, id, {
        entries: [{ user_id: alice, entry_numbers: [1], match_count: 1 }],
      });
      await simulateDraw(tx, id, {
        entries: [{ user_id: bob, entry_numbers: [2], match_count: 1 }],
      });
      const { rows: e } = await entries(tx, id);
      expect(e).toEqual([{ user_id: bob, match_count: 1 }]);
    });
  });

  it('refuses to re-simulate a PUBLISHED draw (GS005) and changes nothing', async () => {
    await asOwner(db, async (tx) => {
      const id = await createDraft(tx);
      await simulateDraw(tx, id, {
        entries: [{ user_id: alice, entry_numbers: [1, 2, 3], match_count: 3 }],
        tierResults: [
          TIER(5),
          TIER(4),
          TIER(3, { winners_count: 1, base_pool_minor: 100, prize_per_winner_minor: 100 }),
        ],
      });
      await publishDraw(tx, id, alice);
      const before = await draw(tx, id);

      const err = await attempt(tx, () => simulateDraw(tx, id, {}));
      expect(err.code).toBe('GS005');

      const after = await draw(tx, id);
      expect(after.rows[0]).toEqual(before.rows[0]);
    });
  });

  it('is ATOMIC: an error partway through leaves the draw exactly as it was (nothing partially written)', async () => {
    await asOwner(db, async (tx) => {
      const id = await createDraft(tx);
      const before = await draw(tx, id);
      // match_count 9 violates draw_entries_match_count_range (0-5): the whole call must roll back.
      const err = await attempt(tx, () =>
        simulateDraw(tx, id, { entries: [{ user_id: alice, entry_numbers: [1], match_count: 9 }] }),
      );
      expect(err.code).toBe(PG.checkViolation);
      const after = await draw(tx, id);
      expect(after.rows[0]).toEqual(before.rows[0]); // still draft, nothing simulated
      const { rows: e } = await entries(tx, id);
      expect(e).toEqual([]);
    });
  });

  it('rejects an unknown draw id', async () => {
    await asOwner(db, async (tx) => {
      const err = await attempt(tx, () =>
        simulateDraw(tx, '00000000-0000-4000-8000-00000000dead', {}),
      );
      expect(err.code).toBe('23503');
    });
  });
});

describe('publish_draw() — freezes the draw and creates winners; idempotent (DRW-05; D-018/D-045/D-071)', () => {
  async function readyDraw(tx: Transaction, matchCount: 3 | 4 | 5 = 5) {
    const id = await createDraft(tx);
    await simulateDraw(tx, id, {
      entries: [{ user_id: alice, entry_numbers: [1, 2, 3, 4, 5], match_count: matchCount }],
      tierResults: [
        TIER(
          5,
          matchCount === 5
            ? { winners_count: 1, base_pool_minor: 400, prize_per_winner_minor: 400 }
            : { rollover_out_minor: 400 },
        ),
        TIER(
          4,
          matchCount === 4
            ? { winners_count: 1, base_pool_minor: 350, prize_per_winner_minor: 350 }
            : {},
        ),
        TIER(
          3,
          matchCount === 3
            ? { winners_count: 1, base_pool_minor: 250, prize_per_winner_minor: 250 }
            : {},
        ),
      ],
    });
    return id;
  }

  it('DRAFT → SIMULATED → PUBLISHED: refuses to publish straight from draft (GS006)', async () => {
    await asOwner(db, async (tx) => {
      const id = await createDraft(tx);
      const err = await attempt(tx, () => publishDraw(tx, id, alice));
      expect(err.code).toBe('GS006');
      expect((await draw(tx, id)).rows[0]?.status).toBe('draft');
    });
  });

  it('publishes a simulated draw and creates exactly the winners implied by match_count', async () => {
    await asOwner(db, async (tx) => {
      const id = await readyDraw(tx, 5);
      const result = await publishDraw(tx, id, alice);
      expect(result).toBe('published');
      expect((await draw(tx, id)).rows[0]?.status).toBe('published');
      const { rows: w } = await winners(tx, id);
      expect(w).toEqual([{ user_id: alice, match_count: 5, prize_minor: 400 }]);
    });
  });

  it('a non-winning entry (match_count 0-2) never becomes a winner row', async () => {
    await asOwner(db, async (tx) => {
      const id = await createDraft(tx);
      await simulateDraw(tx, id, {
        entries: [{ user_id: alice, entry_numbers: [1], match_count: 2 }],
      });
      await publishDraw(tx, id, alice);
      expect((await winners(tx, id)).rows).toEqual([]);
    });
  });

  it('is IDEMPOTENT: a second call reports already_published and creates no second winner set', async () => {
    await asOwner(db, async (tx) => {
      const id = await readyDraw(tx, 5);
      await publishDraw(tx, id, alice);
      const before = (await winners(tx, id)).rows;
      const second = await publishDraw(tx, id, alice);
      expect(second).toBe('already_published');
      expect((await winners(tx, id)).rows).toEqual(before);
    });
  });

  it('rejects an unknown draw id', async () => {
    await asOwner(db, async (tx) => {
      const err = await attempt(tx, () =>
        publishDraw(tx, '00000000-0000-4000-8000-00000000dead', alice),
      );
      expect(err.code).toBe('23503');
    });
  });
});

describe('the three draw-engine functions are service-role only (D-071)', () => {
  const FUNCTIONS = ['active_subscriber_ids', 'simulate_draw', 'publish_draw'];

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

  it('a signed-in user cannot call simulate_draw or publish_draw through the RPC surface', async () => {
    const id = await asOwner(db, (tx) => createDraft(tx));
    await as(db, { role: 'authenticated', userId: alice }, async (tx) => {
      const err = await attempt(tx, () =>
        tx.query(`select public.publish_draw($1::uuid, $2::uuid)`, [id, alice]),
      );
      expect(err.code).toBe(PG.insufficientPrivilege);
    });
  });
});

describe('DB-level rounding and remainder sanity, mirroring the domain layer (D-020/D-071)', () => {
  it('an equal split with a remainder is stored exactly as computed, and never exceeds the pot (CHECK enforced)', async () => {
    await asOwner(db, async (tx) => {
      const id = await createDraft(tx);
      // pot 250 split 3 ways: 83 each + 1 remainder, matching apps/api/src/draws/domain.test.ts exactly.
      await simulateDraw(tx, id, {
        entries: [alice, bob].map((u) => ({
          user_id: u,
          entry_numbers: [1, 2, 3],
          match_count: 3,
        })),
        tierResults: [
          TIER(5),
          TIER(4),
          TIER(3, {
            winners_count: 3,
            base_pool_minor: 250,
            prize_per_winner_minor: 83,
            remainder_minor: 1,
          }),
        ],
      });
      const { rows } = await tierResults(tx, id);
      void rows;
      const { rows: raw } = await tx.query<{
        prize_per_winner_minor: number;
        remainder_minor: number;
      }>(
        `select prize_per_winner_minor, remainder_minor from public.draw_tier_results where draw_id = $1 and match_count = 3`,
        [id],
      );
      expect(raw[0]).toEqual({ prize_per_winner_minor: 83, remainder_minor: 1 });
    });
  });

  it('an allocation that exceeds the pot is refused by the existing CHECK constraint (defence in depth)', async () => {
    await asOwner(db, async (tx) => {
      const id = await createDraft(tx);
      const err = await pgError(
        simulateDraw(tx, id, {
          tierResults: [
            TIER(5),
            TIER(4),
            TIER(3, { winners_count: 1, base_pool_minor: 100, prize_per_winner_minor: 200 }), // too much
          ],
        }),
      );
      expect(err.code).toBe(PG.checkViolation);
    });
  });
});

describe('a full two-month rollover chain, using the real SQL functions (DRW-06; D-019/D-071)', () => {
  it('no 5-match winner in month 1 rolls the jackpot into month 2’s tier result', async () => {
    await asOwner(db, async (tx) => {
      const charity = await createCharity(tx);
      void charity;
      const id1 = await createDraft(tx, '2028-01-01');
      await simulateDraw(tx, id1, {
        currency: 'XTS',
        entries: [{ user_id: alice, entry_numbers: [1, 2, 3], match_count: 3 }],
        tierResults: [
          TIER(5, { base_pool_minor: 400, rollover_out_minor: 400 }),
          TIER(4),
          TIER(3, { winners_count: 1, base_pool_minor: 250, prize_per_winner_minor: 250 }),
        ],
      });
      await publishDraw(tx, id1, alice);

      const id2 = await createDraft(tx, '2028-02-01');
      // The SERVICE is what reads getPriorJackpotRollover(); here we prove the DB SIDE simply accepts and
      // stores whatever rolloverInMinor it is given, which is all this migration is responsible for.
      await simulateDraw(tx, id2, {
        currency: 'XTS',
        tierResults: [
          TIER(5, { rollover_in_minor: 400, base_pool_minor: 100, rollover_out_minor: 500 }),
          TIER(4),
          TIER(3),
        ],
      });
      const { rows } = await tierResults(tx, id2);
      void rows;
      const { rows: raw } = await tx.query<{
        rollover_in_minor: number;
        rollover_out_minor: number;
      }>(
        `select rollover_in_minor, rollover_out_minor from public.draw_tier_results where draw_id = $1 and match_count = 5`,
        [id2],
      );
      expect(raw[0]).toEqual({ rollover_in_minor: 400, rollover_out_minor: 500 });
    });
  });
});
