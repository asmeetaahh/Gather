import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { createSupabaseSubscriptionGate } from '../auth/entitlement.js';
import { createSupabaseScoreRepository, parseScoreRow } from './repository.js';

/**
 * The Supabase-facing code, tested against a recording stand-in for supabase-js. These tests pin down WHAT
 * is sent to Supabase (table, columns, filters, RPC name and argument names) and how PostgREST error codes
 * are mapped — the parts that cannot be exercised without a real project.
 */

interface Result {
  data: unknown;
  error: { code?: string; message: string } | null;
}

/** A chainable query builder that records each call and resolves to a canned result when awaited. */
class QueryStub implements PromiseLike<Result> {
  readonly calls: string[] = [];
  constructor(private readonly result: Result) {}
  private record(call: string) {
    this.calls.push(call);
    return this;
  }
  select(columns: string) {
    return this.record(`select(${columns})`);
  }
  eq(column: string, value: unknown) {
    return this.record(`eq(${column}=${String(value)})`);
  }
  order(column: string, options: { ascending: boolean }) {
    return this.record(`order(${column},${options.ascending ? 'asc' : 'desc'})`);
  }
  update(values: unknown) {
    return this.record(`update(${JSON.stringify(values)})`);
  }
  delete() {
    return this.record('delete()');
  }
  maybeSingle() {
    this.calls.push('maybeSingle()');
    return Promise.resolve(this.result);
  }
  then<A = Result, B = never>(
    onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

function fakeClient(result: Result) {
  const seen: { table?: string; rpc?: { fn: string; args: unknown }; query?: QueryStub } = {};
  const client = {
    from(table: string) {
      seen.table = table;
      seen.query = new QueryStub(result);
      return seen.query;
    },
    rpc(fn: string, args: unknown) {
      seen.rpc = { fn, args };
      return Promise.resolve(result);
    },
  } as unknown as SupabaseClient;
  return { client, seen };
}

const ROW = {
  id: 's1',
  user_id: 'u1',
  played_on: '2026-03-05',
  stableford_score: 36,
  created_at: '2026-03-05T10:00:00+00:00',
  updated_at: '2026-03-05T10:00:00+00:00',
};
const DTO = {
  id: 's1',
  playedOn: '2026-03-05',
  stablefordScore: 36,
  createdAt: ROW.created_at,
  updatedAt: ROW.updated_at,
};

describe('parseScoreRow', () => {
  it('maps a row to the API shape and drops columns the API does not expose (user_id)', () => {
    expect(parseScoreRow(ROW)).toEqual(DTO);
  });

  it.each([
    null,
    'x',
    {},
    { ...ROW, stableford_score: '36' },
    { ...ROW, stableford_score: 36.5 },
    { ...ROW, played_on: 20260305 },
    { ...ROW, id: undefined },
  ])('rejects a malformed row %j', (row) => {
    expect(() => parseScoreRow(row)).toThrow(/Malformed score row/);
  });
});

describe('list', () => {
  it("queries only this user's rows, newest date first", async () => {
    const { client, seen } = fakeClient({ data: [ROW], error: null });
    const scores = await createSupabaseScoreRepository(client).list('u1');
    expect(scores).toEqual([DTO]);
    expect(seen.table).toBe('scores');
    expect(seen.query?.calls).toEqual([
      'select(id, played_on, stableford_score, created_at, updated_at)',
      'eq(user_id=u1)',
      'order(played_on,desc)',
    ]);
  });

  it('throws when the query fails', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'boom' } });
    await expect(createSupabaseScoreRepository(client).list('u1')).rejects.toThrow(
      /Score lookup failed/,
    );
  });
});

describe('add (RPC add_score)', () => {
  const input = { playedOn: '2026-03-05', stablefordScore: 36 };

  it('calls the function with the named arguments the SQL expects', async () => {
    const { client, seen } = fakeClient({
      data: { score: ROW, replaced_played_on: '2026-02-01' },
      error: null,
    });
    const result = await createSupabaseScoreRepository(client).add('u1', input);
    expect(seen.rpc).toEqual({
      fn: 'add_score',
      args: { p_user_id: 'u1', p_played_on: '2026-03-05', p_stableford_score: 36 },
    });
    expect(result).toEqual({ kind: 'created', score: DTO, replacedPlayedOn: '2026-02-01' });
  });

  it('reports nothing replaced when there was room', async () => {
    const { client } = fakeClient({ data: { score: ROW, replaced_played_on: null }, error: null });
    expect(await createSupabaseScoreRepository(client).add('u1', input)).toMatchObject({
      kind: 'created',
      replacedPlayedOn: null,
    });
  });

  it('maps unique_violation (23505) to a duplicate date', async () => {
    const { client } = fakeClient({ data: null, error: { code: '23505', message: 'duplicate' } });
    expect(await createSupabaseScoreRepository(client).add('u1', input)).toEqual({
      kind: 'duplicate_date',
    });
  });

  it('maps the custom GS001 error to "too old"', async () => {
    const { client } = fakeClient({ data: null, error: { code: 'GS001', message: 'older' } });
    expect(await createSupabaseScoreRepository(client).add('u1', input)).toEqual({
      kind: 'too_old',
    });
  });

  it.each(['23514', '23503', '42501', 'PGRST202', undefined])(
    'treats any other database error (%s) as a failure, never as a business outcome',
    async (code) => {
      const { client } = fakeClient({ data: null, error: { ...(code && { code }), message: 'x' } });
      await expect(createSupabaseScoreRepository(client).add('u1', input)).rejects.toThrow(
        /add_score failed/,
      );
    },
  );

  it.each([
    null,
    'x',
    { score: ROW },
    { score: ROW, replaced_played_on: 5 },
    { score: {}, replaced_played_on: null },
  ])('rejects a malformed function result %j', async (data) => {
    const { client } = fakeClient({ data, error: null });
    await expect(createSupabaseScoreRepository(client).add('u1', input)).rejects.toThrow();
  });
});

describe('update', () => {
  it('updates only the value, scoped by BOTH user and date', async () => {
    const { client, seen } = fakeClient({ data: ROW, error: null });
    const score = await createSupabaseScoreRepository(client).update('u1', '2026-03-05', 40);
    expect(score).toEqual(DTO);
    expect(seen.query?.calls).toEqual([
      'update({"stableford_score":40})',
      'eq(user_id=u1)',
      'eq(played_on=2026-03-05)',
      'select(id, played_on, stableford_score, created_at, updated_at)',
      'maybeSingle()',
    ]);
  });

  it('returns null when the user has no score for that date', async () => {
    const { client } = fakeClient({ data: null, error: null });
    expect(await createSupabaseScoreRepository(client).update('u1', '2026-03-05', 40)).toBeNull();
  });

  it('throws when the update fails', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'x' } });
    await expect(
      createSupabaseScoreRepository(client).update('u1', '2026-03-05', 40),
    ).rejects.toThrow(/Score update failed/);
  });
});

describe('remove', () => {
  it('deletes scoped by BOTH user and date and reports whether a row existed', async () => {
    const found = fakeClient({ data: [{ id: 's1' }], error: null });
    expect(await createSupabaseScoreRepository(found.client).remove('u1', '2026-03-05')).toBe(true);
    expect(found.seen.query?.calls).toEqual([
      'delete()',
      'eq(user_id=u1)',
      'eq(played_on=2026-03-05)',
      'select(id)',
    ]);

    const missing = fakeClient({ data: [], error: null });
    expect(await createSupabaseScoreRepository(missing.client).remove('u1', '2026-03-05')).toBe(
      false,
    );
  });

  it('throws when the delete fails', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'x' } });
    await expect(createSupabaseScoreRepository(client).remove('u1', '2026-03-05')).rejects.toThrow(
      /Score delete failed/,
    );
  });
});

describe('createSupabaseSubscriptionGate (RPC is_active_subscriber)', () => {
  it('asks the single SQL definition, with the named argument', async () => {
    const { client, seen } = fakeClient({ data: true, error: null });
    expect(await createSupabaseSubscriptionGate(client).isActiveSubscriber('u1')).toBe(true);
    expect(seen.rpc).toEqual({ fn: 'is_active_subscriber', args: { p_user_id: 'u1' } });
  });

  it.each([false, null, 'true', 1, undefined])(
    'treats %j as NOT subscribed (only an explicit true counts)',
    async (data) => {
      const { client } = fakeClient({ data, error: null });
      expect(await createSupabaseSubscriptionGate(client).isActiveSubscriber('u1')).toBe(false);
    },
  );

  it('throws — rather than answering "not subscribed" — when the lookup fails', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'x' } });
    await expect(createSupabaseSubscriptionGate(client).isActiveSubscriber('u1')).rejects.toThrow(
      /Subscription lookup failed/,
    );
  });
});
