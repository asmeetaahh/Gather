import type { PGlite } from '@electric-sql/pglite';

/** Anything that can run a query: the database itself or a transaction. */
export type Queryable = Pick<PGlite, 'query'>;

/**
 * ISO 4217 code reserved for testing. The PRD fixes no currency (D-024), so tests must not
 * imply one.
 */
export const TEST_CURRENCY = 'XTS';

interface IdRow {
  id: string;
}

async function insertReturningId(db: Queryable, sql: string, params: unknown[]): Promise<string> {
  const { rows } = await db.query<IdRow>(sql, params);
  const row = rows[0];
  if (!row) throw new Error(`Fixture insert returned no row: ${sql}`);
  return row.id;
}

let counter = 0;
/** Unique-per-process suffix so fixtures never collide on unique columns. */
export function uniq(): string {
  counter += 1;
  return `${String(Date.now())}${String(counter)}`;
}

/** Creates an auth user; the on_auth_user_created trigger creates the profile. */
export async function createUser(
  db: Queryable,
  options: { admin?: boolean } = {},
): Promise<string> {
  const id = await insertReturningId(
    db,
    `insert into auth.users (email) values ($1) returning id`,
    [`user-${uniq()}@example.test`],
  );
  if (options.admin) {
    await db.query(`update public.profiles set role = 'admin' where id = $1`, [id]);
  }
  return id;
}

export async function createCharity(
  db: Queryable,
  options: { name?: string; description?: string; archived?: boolean; featured?: boolean } = {},
): Promise<string> {
  const key = uniq();
  return insertReturningId(
    db,
    `insert into public.charities (slug, name, description, is_featured, archived_at)
     values ($1, $2, $3, $4, $5) returning id`,
    [
      `charity-${key}`,
      options.name ?? `Charity ${key}`,
      options.description ?? 'A test charity description.',
      options.featured ?? false,
      options.archived ? new Date().toISOString() : null,
    ],
  );
}

export async function createPlan(
  db: Queryable,
  options: { interval?: 'month' | 'year'; amountMinor?: number; active?: boolean } = {},
): Promise<string> {
  return insertReturningId(
    db,
    `insert into public.plans (name, billing_interval, amount_minor, currency, is_active)
     values ($1, $2, $3, $4, $5) returning id`,
    [
      `Test plan ${uniq()}`,
      options.interval ?? 'month',
      options.amountMinor ?? 1000,
      TEST_CURRENCY,
      options.active ?? true,
    ],
  );
}

export async function createSubscription(
  db: Queryable,
  userId: string,
  planId: string,
  status: 'pending' | 'active' | 'cancelled' | 'lapsed' = 'active',
): Promise<string> {
  const periodEnd =
    status === 'active' ? new Date(Date.now() + 30 * 86_400_000).toISOString() : null;
  return insertReturningId(
    db,
    `insert into public.subscriptions (user_id, plan_id, status, current_period_end)
     values ($1, $2, $3, $4) returning id`,
    [userId, planId, status, periodEnd],
  );
}

export async function createPayment(
  db: Queryable,
  userId: string,
  options: {
    kind?: 'subscription' | 'donation';
    subscriptionId?: string;
    amountMinor?: number;
  } = {},
): Promise<string> {
  const kind = options.kind ?? 'donation';
  return insertReturningId(
    db,
    `insert into public.payments (user_id, kind, subscription_id, amount_minor, currency, state, paid_at)
     values ($1, $2, $3, $4, $5, 'succeeded', now()) returning id`,
    [userId, kind, options.subscriptionId ?? null, options.amountMinor ?? 1000, TEST_CURRENCY],
  );
}

export async function addScore(
  db: Queryable,
  userId: string,
  playedOn: string,
  score = 30,
): Promise<string> {
  return insertReturningId(
    db,
    `insert into public.scores (user_id, played_on, stableford_score) values ($1, $2, $3) returning id`,
    [userId, playedOn, score],
  );
}

export interface DrawFixture {
  drawId: string;
  entryId: string;
  /** Winner row id; only present when `publish` is true. */
  winnerId?: string;
}

/**
 * Builds a draw for one user who matched `matchCount` numbers, with tier results for all three
 * prize tiers. When `publish` is true the draw is published and a winner row is created (the
 * only order the immutability guards allow); otherwise the draw is left as a simulated
 * candidate. `month` is the first day of the draw month.
 */
export async function createDrawWithEntry(
  db: Queryable,
  userId: string,
  options: {
    month: string;
    matchCount?: 3 | 4 | 5;
    publish?: boolean;
    status?: 'draft' | 'simulated';
  },
): Promise<DrawFixture> {
  const matchCount = options.matchCount ?? 3;
  const drawId = await insertReturningId(
    db,
    `insert into public.draws (draw_month, mode, status, winning_numbers)
     values ($1, 'random', 'simulated', '{1,2,3,4,5}') returning id`,
    [options.month],
  );
  const entryId = await insertReturningId(
    db,
    `insert into public.draw_entries (draw_id, user_id, entry_numbers, match_count)
     values ($1, $2, '{1,2,3,9,10}', $3) returning id`,
    [drawId, userId, matchCount],
  );

  // Tier results: one winner in the user's tier, none elsewhere (5-match rolls over).
  for (const [tier, share, rolls] of [
    [5, 4000, true],
    [4, 3500, false],
    [3, 2500, false],
  ] as const) {
    const winners = tier === matchCount ? 1 : 0;
    await db.query(
      `insert into public.draw_tier_results
         (draw_id, match_count, share_bps, rolls_over, base_pool_minor,
          winners_count, prize_per_winner_minor, rollover_out_minor)
       values ($1, $2, $3, $4, 1000, $5, $6, $7)`,
      [
        drawId,
        tier,
        share,
        rolls,
        winners,
        winners > 0 ? 1000 : 0,
        winners === 0 && rolls ? 1000 : 0,
      ],
    );
  }

  if (!options.publish) {
    if (options.status === 'draft') {
      await db.query(`update public.draws set status = 'draft' where id = $1`, [drawId]);
    }
    return { drawId, entryId };
  }

  await db.query(
    `update public.draws
        set status = 'published', published_at = now(), prize_pool_minor = 3000,
            active_subscriber_count = 3, currency = $2
      where id = $1`,
    [drawId, TEST_CURRENCY],
  );
  const winnerId = await insertReturningId(
    db,
    `insert into public.winners (draw_id, user_id, draw_entry_id, match_count, prize_minor, currency)
     values ($1, $2, $3, $4, 1000, $5) returning id`,
    [drawId, userId, entryId, matchCount, TEST_CURRENCY],
  );
  return { drawId, entryId, winnerId };
}
