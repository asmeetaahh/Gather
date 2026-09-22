import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  DrawStateConflictError,
  createSupabaseDrawRepository,
  parseDrawRow,
  type SimulateInput,
} from './repository.js';

/**
 * The Supabase-facing code against a recording stand-in for supabase-js: WHAT is sent (tables, filters,
 * RPC names and argument names) and how database error codes map. The two SQL functions themselves are
 * proven on PostgreSQL in supabase/tests/draws-function.test.ts.
 */

interface Result {
  data: unknown;
  error: { code?: string; message: string } | null;
}

class Query implements PromiseLike<Result> {
  readonly calls: string[] = [];
  constructor(private readonly result: Result) {}
  private rec(call: string) {
    this.calls.push(call);
    return this;
  }
  select(columns: string) {
    return this.rec(`select(${columns})`);
  }
  eq(c: string, v: unknown) {
    return this.rec(`eq(${c}=${String(v)})`);
  }
  in(c: string, v: unknown[]) {
    return this.rec(`in(${c}=${JSON.stringify(v)})`);
  }
  gte(c: string, v: unknown) {
    return this.rec(`gte(${c}>=${String(v)})`);
  }
  lte(c: string, v: unknown) {
    return this.rec(`lte(${c}<=${String(v)})`);
  }
  lt(c: string, v: unknown) {
    return this.rec(`lt(${c}<${String(v)})`);
  }
  order(c: string, o: { ascending: boolean }) {
    return this.rec(`order(${c},${o.ascending ? 'asc' : 'desc'})`);
  }
  limit(n: number) {
    return this.rec(`limit(${String(n)})`);
  }
  insert(v: unknown) {
    return this.rec(`insert(${JSON.stringify(v)})`);
  }
  maybeSingle(): Promise<Result> {
    this.calls.push('maybeSingle()');
    return Promise.resolve(this.result);
  }
  single(): Promise<Result> {
    this.calls.push('single()');
    return Promise.resolve(this.result);
  }
  then<A = Result, B = never>(
    f?: ((v: Result) => A | PromiseLike<A>) | null,
    r?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.result).then(f, r);
  }
}

/** Serves canned results in order (one per `.from()`/`.rpc()` call); records every call. */
function client(...results: Result[]) {
  const queries: { table: string; q: Query }[] = [];
  const rpcs: { fn: string; args: unknown }[] = [];
  let i = 0;
  const next = (): Result =>
    results[Math.min(i++, results.length - 1)] ?? { data: null, error: null };
  const c = {
    from(table: string) {
      const q = new Query(next());
      queries.push({ table, q });
      return q;
    },
    rpc(fn: string, args: unknown) {
      rpcs.push({ fn, args });
      return Promise.resolve(next());
    },
  };
  return { client: c as unknown as SupabaseClient, queries, rpcs };
}
const ok = (data: unknown): Result => ({ data, error: null });
const fail = (code: string | undefined, message = 'x'): Result => ({
  data: null,
  error: { ...(code && { code }), message },
});

const DRAW_ROW = {
  id: 'd1',
  draw_month: '2026-11-01',
  mode: 'random',
  status: 'draft',
  scheduled_at: null,
  simulated_at: null,
  published_at: null,
  currency: null,
  prize_pool_minor: null,
  active_subscriber_count: null,
};

describe('parseDrawRow', () => {
  it('maps a row', () => {
    expect(parseDrawRow(DRAW_ROW)).toEqual({
      id: 'd1',
      drawMonth: '2026-11-01',
      mode: 'random',
      status: 'draft',
      scheduledAt: null,
      simulatedAt: null,
      publishedAt: null,
      currency: null,
      prizePoolMinor: null,
      activeSubscriberCount: null,
    });
  });
  it.each([
    null,
    {},
    { ...DRAW_ROW, mode: 'x' },
    { ...DRAW_ROW, status: 'x' },
    { ...DRAW_ROW, prize_pool_minor: '1' },
  ])('rejects a malformed row %j', (row) => {
    expect(() => parseDrawRow(row)).toThrow(/Malformed/);
  });
});

describe('getSettings', () => {
  it('reads bps mode', async () => {
    const { client: c, queries } = client(
      ok({
        draw_number_min: 1,
        draw_number_max: 45,
        prize_pool_bps: 1000,
        prize_pool_per_subscription_minor: null,
      }),
    );
    expect(await createSupabaseDrawRepository(c).getSettings()).toEqual({
      numberRange: { min: 1, max: 45 },
      pool: { kind: 'bps', bps: 1000 },
    });
    expect(queries[0]?.table).toBe('platform_settings');
    expect(queries[0]?.q.calls).toEqual([
      'select(draw_number_min, draw_number_max, prize_pool_bps, prize_pool_per_subscription_minor)',
      'eq(id=true)',
      'maybeSingle()',
    ]);
  });
  it('reads fixed mode', async () => {
    const { client: c } = client(
      ok({
        draw_number_min: 1,
        draw_number_max: 45,
        prize_pool_bps: null,
        prize_pool_per_subscription_minor: 500,
      }),
    );
    expect((await createSupabaseDrawRepository(c).getSettings()).pool).toEqual({
      kind: 'fixed',
      fixedMinor: 500,
    });
  });
  it('is null/null when unconfigured or the row is missing', async () => {
    expect(
      await createSupabaseDrawRepository(
        client(
          ok({
            draw_number_min: null,
            draw_number_max: null,
            prize_pool_bps: null,
            prize_pool_per_subscription_minor: null,
          }),
        ).client,
      ).getSettings(),
    ).toEqual({ numberRange: null, pool: null });
    expect(await createSupabaseDrawRepository(client(ok(null)).client).getSettings()).toEqual({
      numberRange: null,
      pool: null,
    });
  });
  it('throws on a query error', async () => {
    await expect(
      createSupabaseDrawRepository(client(fail(undefined)).client).getSettings(),
    ).rejects.toThrow(/Settings lookup failed/);
  });
});

describe('findByMonth / findById / list', () => {
  it('findByMonth filters by draw_month', async () => {
    const { client: c, queries } = client(ok(DRAW_ROW));
    expect((await createSupabaseDrawRepository(c).findByMonth('2026-11-01'))?.id).toBe('d1');
    expect(queries[0]?.q.calls).toContain('eq(draw_month=2026-11-01)');
  });
  it('findByMonth is null when absent', async () => {
    expect(
      await createSupabaseDrawRepository(client(ok(null)).client).findByMonth('2026-11-01'),
    ).toBeNull();
  });
  it('findById embeds tier results and parses them, highest tier first', async () => {
    const { client: c, queries } = client(
      ok({
        ...DRAW_ROW,
        winning_numbers: [1, 2, 3, 4, 5],
        draw_tier_results: [
          {
            match_count: 3,
            share_bps: 2500,
            rolls_over: false,
            base_pool_minor: 1,
            rollover_in_minor: 0,
            winners_count: 0,
            prize_per_winner_minor: 0,
            remainder_minor: 0,
            rollover_out_minor: 0,
          },
          {
            match_count: 5,
            share_bps: 4000,
            rolls_over: true,
            base_pool_minor: 2,
            rollover_in_minor: 0,
            winners_count: 0,
            prize_per_winner_minor: 0,
            remainder_minor: 0,
            rollover_out_minor: 2,
          },
        ],
      }),
    );
    const draw = await createSupabaseDrawRepository(c).findById('d1');
    expect(draw?.tierResults.map((t) => t.matchCount)).toEqual([5, 3]);
    expect(draw?.winningNumbers).toEqual([1, 2, 3, 4, 5]);
    expect(queries[0]?.q.calls[0]).toContain('draw_tier_results(*)');
  });
  it('list orders by draw_month descending', async () => {
    const { client: c, queries } = client(ok([DRAW_ROW]));
    const draws = await createSupabaseDrawRepository(c).list();
    expect(draws).toHaveLength(1);
    expect(queries[0]?.q.calls).toContain('order(draw_month,desc)');
  });
});

describe('create', () => {
  it('inserts and returns the created draw', async () => {
    const { client: c, queries } = client(ok(DRAW_ROW));
    const result = await createSupabaseDrawRepository(c).create({
      drawMonth: '2026-11-01',
      mode: 'random',
      createdBy: 'admin-1',
    });
    expect(result).toEqual({
      kind: 'created',
      draw: expect.objectContaining({ id: 'd1' }) as unknown,
    });
    expect(queries[0]?.q.calls[0]).toBe(
      'insert({"draw_month":"2026-11-01","mode":"random","created_by":"admin-1"})',
    );
  });
  it('maps a unique-violation to duplicate_month', async () => {
    const result = await createSupabaseDrawRepository(client(fail('23505')).client).create({
      drawMonth: '2026-11-01',
      mode: 'random',
      createdBy: 'a',
    });
    expect(result).toEqual({ kind: 'duplicate_month' });
  });
  it('any other error is a plain failure', async () => {
    await expect(
      createSupabaseDrawRepository(client(fail('08006')).client).create({
        drawMonth: '2026-11-01',
        mode: 'random',
        createdBy: 'a',
      }),
    ).rejects.toThrow(/Draw creation failed/);
  });
});

describe('listEligibleTickets', () => {
  it('reads active subscriber ids, then their scores, capping five newest-first per user', async () => {
    const {
      client: c,
      rpcs,
      queries,
    } = client(
      ok([{ user_id: 'u1' }, { user_id: 'u2' }]),
      ok([
        { user_id: 'u1', stableford_score: 30 },
        { user_id: 'u1', stableford_score: 28 },
        { user_id: 'u1', stableford_score: 26 },
        { user_id: 'u1', stableford_score: 24 },
        { user_id: 'u1', stableford_score: 22 },
        { user_id: 'u1', stableford_score: 20 }, // a 6th row must never appear per SCR-05, but defend anyway
        { user_id: 'u2', stableford_score: 15 },
      ]),
    );
    const tickets = await createSupabaseDrawRepository(c).listEligibleTickets();
    expect(tickets.get('u1')).toEqual([30, 28, 26, 24, 22]);
    expect(tickets.get('u2')).toEqual([15]);
    expect(rpcs).toEqual([{ fn: 'active_subscriber_ids', args: undefined }]);
    expect(queries[0]?.q.calls).toEqual([
      'select(user_id, stableford_score)',
      'in(user_id=["u1","u2"])',
      'order(user_id,asc)',
      'order(played_on,desc)',
    ]);
  });
  it('an active subscriber with no scores at all still gets an (empty) entry', async () => {
    const { client: c } = client(ok([{ user_id: 'u1' }]), ok([]));
    expect((await createSupabaseDrawRepository(c).listEligibleTickets()).get('u1')).toEqual([]);
  });
  it('no active subscribers: no scores query at all', async () => {
    const { client: c, queries } = client(ok([]));
    expect(await createSupabaseDrawRepository(c).listEligibleTickets()).toEqual(new Map());
    expect(queries).toHaveLength(0);
  });
  it('throws on an rpc or query error', async () => {
    await expect(
      createSupabaseDrawRepository(client(fail(undefined)).client).listEligibleTickets(),
    ).rejects.toThrow(/Eligibility lookup failed/);
    await expect(
      createSupabaseDrawRepository(
        client(ok([{ user_id: 'u1' }]), fail(undefined)).client,
      ).listEligibleTickets(),
    ).rejects.toThrow(/Score lookup failed/);
  });
});

describe('listPaymentBasesFunding', () => {
  const PAYMENT_ROW = {
    currency: 'USD',
    period_start: '2026-09-01T00:00:00Z',
    subscriptions: { plans: { billing_interval: 'month' } },
    charity_contributions: [{ basis_minor: 900 }],
  };
  it('sends the expected filters and an 11-month lookback window', async () => {
    const { client: c, queries } = client(ok([PAYMENT_ROW]));
    const rows = await createSupabaseDrawRepository(c).listPaymentBasesFunding('2026-11-01');
    expect(rows).toEqual([
      { basisMinor: 900, currency: 'USD', intervalMonths: 1, periodStartMonth: '2026-09-01' },
    ]);
    expect(queries[0]?.table).toBe('payments');
    expect(queries[0]?.q.calls).toEqual([
      'select(currency, period_start, subscriptions(plans(billing_interval)), charity_contributions(basis_minor))',
      'eq(kind=subscription)',
      'eq(state=succeeded)',
      'gte(period_start>=2025-12-01T00:00:00.000Z)',
      'lte(period_start<=2026-11-01T00:00:00.000Z)',
    ]);
  });
  it('reads a yearly interval as 12 months', async () => {
    const row = { ...PAYMENT_ROW, subscriptions: { plans: { billing_interval: 'year' } } };
    const [parsed] = await createSupabaseDrawRepository(
      client(ok([row])).client,
    ).listPaymentBasesFunding('2026-11-01');
    expect(parsed?.intervalMonths).toBe(12);
  });
  it('throws when a succeeded subscription payment has no charity contribution (should never happen, GS004)', async () => {
    const row = { ...PAYMENT_ROW, charity_contributions: [] };
    await expect(
      createSupabaseDrawRepository(client(ok([row])).client).listPaymentBasesFunding('2026-11-01'),
    ).rejects.toThrow(/Malformed/);
  });
  it('throws on a query error', async () => {
    await expect(
      createSupabaseDrawRepository(client(fail(undefined)).client).listPaymentBasesFunding(
        '2026-11-01',
      ),
    ).rejects.toThrow(/Payment lookup failed/);
  });
});

describe('getActiveMonthlyPlanCurrency', () => {
  it('reads the active monthly plan', async () => {
    const { client: c, queries } = client(ok({ currency: 'USD' }));
    expect(await createSupabaseDrawRepository(c).getActiveMonthlyPlanCurrency()).toBe('USD');
    expect(queries[0]?.q.calls).toEqual([
      'select(currency)',
      'eq(billing_interval=month)',
      'eq(is_active=true)',
      'maybeSingle()',
    ]);
  });
  it('is null when there is none', async () => {
    expect(
      await createSupabaseDrawRepository(client(ok(null)).client).getActiveMonthlyPlanCurrency(),
    ).toBeNull();
  });
});

describe('getPriorJackpotRollover', () => {
  it('reads the most recent published draw before the month, then its tier-5 rollover', async () => {
    const { client: c, queries } = client(ok({ id: 'prior-1' }), ok({ rollover_out_minor: 400 }));
    expect(await createSupabaseDrawRepository(c).getPriorJackpotRollover('2026-12-01')).toBe(400);
    expect(queries[0]?.q.calls).toEqual([
      'select(id)',
      'eq(status=published)',
      'lt(draw_month<2026-12-01)',
      'order(draw_month,desc)',
      'limit(1)',
      'maybeSingle()',
    ]);
    expect(queries[1]?.table).toBe('draw_tier_results');
    expect(queries[1]?.q.calls).toEqual([
      'select(rollover_out_minor)',
      'eq(draw_id=prior-1)',
      'eq(match_count=5)',
      'maybeSingle()',
    ]);
  });
  it('is 0 when there is no prior published draw', async () => {
    expect(
      await createSupabaseDrawRepository(client(ok(null)).client).getPriorJackpotRollover(
        '2026-12-01',
      ),
    ).toBe(0);
  });
});

describe('simulate', () => {
  const input: SimulateInput = {
    drawId: 'd1',
    winningNumbers: [1, 2, 3, 4, 5],
    activeSubscriberCount: 2,
    currency: 'USD',
    prizePoolMinor: 1000,
    poolContributionBps: 1000,
    poolContributionFixedMinor: null,
    entries: [{ userId: 'u1', entryNumbers: [1, 2, 3], matchCount: 3 }],
    tierResults: [
      {
        matchCount: 5,
        shareBps: 4000,
        rollsOver: true,
        basePoolMinor: 400,
        rolloverInMinor: 0,
        winnersCount: 0,
        prizePerWinnerMinor: 0,
        remainderMinor: 0,
        rolloverOutMinor: 400,
      },
    ],
  };
  it('sends the exact documented RPC argument names', async () => {
    const { client: c, rpcs } = client(ok(null));
    await createSupabaseDrawRepository(c).simulate(input);
    expect(rpcs).toEqual([
      {
        fn: 'simulate_draw',
        args: {
          p_draw_id: 'd1',
          p_winning_numbers: [1, 2, 3, 4, 5],
          p_active_subscriber_count: 2,
          p_currency: 'USD',
          p_prize_pool_minor: 1000,
          p_pool_contribution_bps: 1000,
          p_pool_contribution_fixed_minor: null,
          p_entries: [{ user_id: 'u1', entry_numbers: [1, 2, 3], match_count: 3 }],
          p_tier_results: [
            {
              match_count: 5,
              share_bps: 4000,
              rolls_over: true,
              base_pool_minor: 400,
              rollover_in_minor: 0,
              winners_count: 0,
              prize_per_winner_minor: 0,
              remainder_minor: 0,
              rollover_out_minor: 400,
            },
          ],
        },
      },
    ]);
  });
  it('maps GS005 to DrawStateConflictError(already_published)', async () => {
    const error = await createSupabaseDrawRepository(client(fail('GS005')).client)
      .simulate(input)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DrawStateConflictError);
    expect((error as DrawStateConflictError).kind).toBe('already_published');
  });
  it('any other error is a plain failure', async () => {
    await expect(
      createSupabaseDrawRepository(client(fail('57014')).client).simulate(input),
    ).rejects.toThrow(/Simulation failed/);
  });
});

describe('publish', () => {
  it('sends the draw id and the publisher', async () => {
    const { client: c, rpcs } = client(ok('published'));
    expect(await createSupabaseDrawRepository(c).publish('d1', 'admin-1')).toBe('published');
    expect(rpcs).toEqual([
      { fn: 'publish_draw', args: { p_draw_id: 'd1', p_published_by: 'admin-1' } },
    ]);
  });
  it('passes through "already_published"', async () => {
    expect(
      await createSupabaseDrawRepository(client(ok('already_published')).client).publish('d1', 'a'),
    ).toBe('already_published');
  });
  it('maps GS006 to DrawStateConflictError(not_simulated)', async () => {
    const error = await createSupabaseDrawRepository(client(fail('GS006')).client)
      .publish('d1', 'a')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DrawStateConflictError);
    expect((error as DrawStateConflictError).kind).toBe('not_simulated');
  });
  it('rejects an unexpected result', async () => {
    await expect(
      createSupabaseDrawRepository(client(ok('maybe')).client).publish('d1', 'a'),
    ).rejects.toThrow(/unexpected result/);
  });
  it('any other error is a plain failure', async () => {
    await expect(
      createSupabaseDrawRepository(client(fail('57014')).client).publish('d1', 'a'),
    ).rejects.toThrow(/Publish failed/);
  });
});
