import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { createSupabaseAdminReportsRepository } from './repository.js';

interface Result {
  data: unknown;
  error: { message: string } | null;
  count?: number | null;
}
const ok = (data: unknown, count?: number): Result => ({
  data,
  error: null,
  ...(count !== undefined && { count }),
});
const fail = (message = 'x'): Result => ({ data: null, error: { message } });

class Query implements PromiseLike<Result> {
  readonly calls: string[] = [];
  constructor(private readonly result: Result) {}
  private rec(call: string) {
    this.calls.push(call);
    return this;
  }
  select(columns: string, options?: { count?: string; head?: boolean }) {
    return this.rec(`select(${columns}${options ? `,${JSON.stringify(options)}` : ''})`);
  }
  then<A = Result, B = never>(
    f?: ((v: Result) => A | PromiseLike<A>) | null,
    r?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.result).then(f, r);
  }
}

function client(options: { profiles?: Result; contributions?: Result; rpc?: Result }) {
  const queries: { table: string; q: Query }[] = [];
  const rpcCalls: string[] = [];
  const c = {
    from(table: string) {
      const result =
        table === 'profiles'
          ? (options.profiles ?? ok(null, 0))
          : (options.contributions ?? ok([]));
      const q = new Query(result);
      queries.push({ table, q });
      return q;
    },
    rpc(fn: string) {
      rpcCalls.push(fn);
      return Promise.resolve(options.rpc ?? ok([]));
    },
  };
  return { client: c as unknown as SupabaseClient, queries, rpcCalls };
}

describe('countUsers', () => {
  it('uses a head-only count query (no rows transferred)', async () => {
    const { client: c, queries } = client({ profiles: ok(null, 12) });
    expect(await createSupabaseAdminReportsRepository(c).countUsers()).toBe(12);
    expect(queries[0]?.table).toBe('profiles');
    expect(queries[0]?.q.calls[0]).toContain('"head":true');
  });

  it('is 0 when the count is null', async () => {
    const { client: c } = client({ profiles: ok(null, undefined) });
    expect(await createSupabaseAdminReportsRepository(c).countUsers()).toBe(0);
  });

  it('throws on a query error', async () => {
    await expect(
      createSupabaseAdminReportsRepository(client({ profiles: fail() }).client).countUsers(),
    ).rejects.toThrow(/User count failed/);
  });
});

describe('charityContributionsByCurrency', () => {
  it('sums by currency, sorted, with exact integer arithmetic', async () => {
    const { client: c } = client({
      contributions: ok([
        { currency: 'USD', amount_minor: 500 },
        { currency: 'EUR', amount_minor: 100 },
        { currency: 'USD', amount_minor: 250 },
      ]),
    });
    expect(await createSupabaseAdminReportsRepository(c).charityContributionsByCurrency()).toEqual([
      { currency: 'EUR', amountMinor: 100 },
      { currency: 'USD', amountMinor: 750 },
    ]);
  });

  it('is empty with no contributions', async () => {
    const { client: c } = client({ contributions: ok([]) });
    expect(await createSupabaseAdminReportsRepository(c).charityContributionsByCurrency()).toEqual(
      [],
    );
  });

  it('rejects a malformed row', async () => {
    await expect(
      createSupabaseAdminReportsRepository(
        client({ contributions: ok([{ currency: 'USD' }]) }).client,
      ).charityContributionsByCurrency(),
    ).rejects.toThrow(/Malformed/);
  });

  it('throws on a query error', async () => {
    await expect(
      createSupabaseAdminReportsRepository(
        client({ contributions: fail() }).client,
      ).charityContributionsByCurrency(),
    ).rejects.toThrow(/Contribution totals failed/);
  });
});

describe('countActiveSubscribers', () => {
  it('reuses the active_subscriber_ids() RPC and counts the rows', async () => {
    const { client: c, rpcCalls } = client({ rpc: ok([{ user_id: 'a' }, { user_id: 'b' }]) });
    expect(await createSupabaseAdminReportsRepository(c).countActiveSubscribers()).toBe(2);
    expect(rpcCalls).toEqual(['active_subscriber_ids']);
  });

  it('throws on an RPC error', async () => {
    await expect(
      createSupabaseAdminReportsRepository(client({ rpc: fail() }).client).countActiveSubscribers(),
    ).rejects.toThrow(/Active subscriber count failed/);
  });
});
