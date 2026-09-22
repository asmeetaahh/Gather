import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { createSupabaseAdminUserRepository } from './repository.js';

/**
 * The Supabase-facing code against a recording stand-in: WHAT is sent (tables/columns, the Auth
 * Admin API, the RPC name) and how the results are merged. Business rules (which subscribers are
 * "active", score add/edit/delete) are proven elsewhere (Phase 3/6 tests) — this only proves the
 * merge is correct.
 */

interface Result {
  data: unknown;
  error: { code?: string; message: string } | null;
}
const ok = (data: unknown): Result => ({ data, error: null });
const fail = (message = 'x'): Result => ({ data: null, error: { message } });

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
  update(v: unknown) {
    return this.rec(`update(${JSON.stringify(v)})`);
  }
  maybeSingle(): Promise<Result> {
    this.calls.push('maybeSingle()');
    return Promise.resolve(this.result);
  }
  then<A = Result, B = never>(
    f?: ((v: Result) => A | PromiseLike<A>) | null,
    r?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.result).then(f, r);
  }
}

function client(options: {
  profiles?: Result;
  scores?: Result;
  rpc?: Result;
  listUsers?:
    | { data: { users: { id: string; email?: string; created_at: string }[] }; error: null }
    | { data: null; error: { message: string } };
  getUserById?: {
    data: { user: { id: string; email?: string; created_at: string } | null };
    error: null;
  };
}) {
  const queries: { table: string; q: Query }[] = [];
  const rpcCalls: { fn: string }[] = [];
  const getUserByIdCalls: string[] = [];
  const c = {
    from(table: string) {
      const result =
        table === 'profiles' ? (options.profiles ?? ok(null)) : (options.scores ?? ok([]));
      const q = new Query(result);
      queries.push({ table, q });
      return q;
    },
    rpc(fn: string) {
      rpcCalls.push({ fn });
      return Promise.resolve(options.rpc ?? ok([]));
    },
    auth: {
      admin: {
        listUsers: () => Promise.resolve(options.listUsers ?? { data: { users: [] }, error: null }),
        getUserById: (id: string) => {
          getUserByIdCalls.push(id);
          return Promise.resolve(options.getUserById ?? { data: { user: null }, error: null });
        },
      },
    },
  };
  return { client: c as unknown as SupabaseClient, queries, rpcCalls, getUserByIdCalls };
}

const PROFILE_ROW = {
  id: 'u1',
  display_name: 'Alice',
  role: 'user',
  charities: { name: 'Riverside' },
};

describe('list', () => {
  it('merges profiles, auth emails, the active-subscriber RPC and score counts', async () => {
    const {
      client: c,
      queries,
      rpcCalls,
    } = client({
      profiles: ok([PROFILE_ROW]),
      scores: ok([{ user_id: 'u1' }, { user_id: 'u1' }, { user_id: 'other' }]),
      rpc: ok([{ user_id: 'u1' }]),
      listUsers: {
        data: {
          users: [{ id: 'u1', email: 'alice@example.test', created_at: '2027-01-01T00:00:00Z' }],
        },
        error: null,
      },
    });
    const [row] = await createSupabaseAdminUserRepository(c).list();
    expect(row).toEqual({
      id: 'u1',
      email: 'alice@example.test',
      displayName: 'Alice',
      role: 'user',
      hasActiveSubscription: true,
      charityName: 'Riverside',
      scoreCount: 2,
      createdAt: '2027-01-01T00:00:00Z',
    });
    expect(queries.find((q) => q.table === 'profiles')?.q.calls[0]).toContain('select(');
    expect(rpcCalls).toEqual([{ fn: 'active_subscriber_ids' }]);
  });

  it('a user not in the active-subscriber set has hasActiveSubscription: false', async () => {
    const { client: c } = client({
      profiles: ok([PROFILE_ROW]),
      rpc: ok([]),
      listUsers: {
        data: { users: [{ id: 'u1', created_at: '2027-01-01T00:00:00Z' }] },
        error: null,
      },
    });
    const [row] = await createSupabaseAdminUserRepository(c).list();
    expect(row?.hasActiveSubscription).toBe(false);
  });

  it('a profile with no selected charity has charityName: null', async () => {
    const { client: c } = client({
      profiles: ok([{ ...PROFILE_ROW, charities: null }]),
      listUsers: {
        data: { users: [{ id: 'u1', created_at: '2027-01-01T00:00:00Z' }] },
        error: null,
      },
    });
    const [row] = await createSupabaseAdminUserRepository(c).list();
    expect(row?.charityName).toBeNull();
  });

  it('throws on a profile query error', async () => {
    await expect(
      createSupabaseAdminUserRepository(client({ profiles: fail() }).client).list(),
    ).rejects.toThrow(/User list failed/);
  });

  it('throws on a malformed profile row', async () => {
    await expect(
      createSupabaseAdminUserRepository(client({ profiles: ok([{ id: 'u1' }]) }).client).list(),
    ).rejects.toThrow(/Malformed/);
  });
});

describe('findById', () => {
  it('reads one profile and the matching auth user', async () => {
    const { client: c, getUserByIdCalls } = client({
      profiles: ok(PROFILE_ROW),
      getUserById: {
        data: {
          user: { id: 'u1', email: 'alice@example.test', created_at: '2027-01-01T00:00:00Z' },
        },
        error: null,
      },
      rpc: ok([{ user_id: 'u1' }]),
    });
    const row = await createSupabaseAdminUserRepository(c).findById('u1');
    expect(row).toMatchObject({
      id: 'u1',
      email: 'alice@example.test',
      hasActiveSubscription: true,
    });
    expect(getUserByIdCalls).toEqual(['u1']);
  });

  it('returns null when no such profile exists', async () => {
    const { client: c } = client({ profiles: ok(null) });
    expect(await createSupabaseAdminUserRepository(c).findById('x')).toBeNull();
  });

  it('a profile whose auth user is gone still returns a row (email: null)', async () => {
    const { client: c } = client({
      profiles: ok(PROFILE_ROW),
      getUserById: { data: { user: null }, error: null },
    });
    const row = await createSupabaseAdminUserRepository(c).findById('u1');
    expect(row?.email).toBeNull();
  });
});

describe('updateDisplayName', () => {
  it('sends the new name and returns the updated row', async () => {
    const { client: c, queries } = client({
      profiles: ok({ ...PROFILE_ROW, display_name: 'New Name' }),
      getUserById: {
        data: {
          user: { id: 'u1', email: 'alice@example.test', created_at: '2027-01-01T00:00:00Z' },
        },
        error: null,
      },
    });
    const row = await createSupabaseAdminUserRepository(c).updateDisplayName('u1', 'New Name');
    expect(row?.displayName).toBe('New Name');
    expect(queries[0]?.q.calls[0]).toBe('update({"display_name":"New Name"})');
  });

  it('returns null when no such profile exists', async () => {
    const { client: c } = client({ profiles: ok(null) });
    expect(await createSupabaseAdminUserRepository(c).updateDisplayName('x', 'y')).toBeNull();
  });
});
