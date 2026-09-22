import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { WinnerStateError, createSupabaseWinnerRepository } from './repository.js';

/**
 * The Supabase-facing code against a recording stand-in for supabase-js: WHAT is sent (tables,
 * filters, RPC names and argument names, signed-URL requests) and how database error codes map. The
 * four SQL functions themselves are proven on PostgreSQL in supabase/tests/winners-function.test.ts.
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
  order(c: string, o: { ascending: boolean }) {
    return this.rec(`order(${c},${o.ascending ? 'asc' : 'desc'})`);
  }
  insert(v: unknown) {
    return this.rec(`insert(${JSON.stringify(v)})`);
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

/** Serves canned results in order (one per `.from()`/`.rpc()` call); records every call. */
function client(...results: Result[]) {
  const queries: { table: string; q: Query }[] = [];
  const rpcs: { fn: string; args: unknown }[] = [];
  const signedUrlCalls: { bucket: string; path: string; ttl: number }[] = [];
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
    storage: {
      from(bucket: string) {
        return {
          createSignedUrl(path: string, ttl: number) {
            signedUrlCalls.push({ bucket, path, ttl });
            return Promise.resolve({
              data: { signedUrl: `https://signed.test/${path}` },
              error: null,
            });
          },
        };
      },
    },
  };
  return { client: c as unknown as SupabaseClient, queries, rpcs, signedUrlCalls };
}

const ok = (data: unknown): Result => ({ data, error: null });
const fail = (code: string | undefined, message = 'x'): Result => ({
  data: null,
  error: { ...(code && { code }), message },
});

const WINNER_ROW = {
  id: 'w1',
  draw_id: 'd1',
  user_id: 'u1',
  match_count: 5,
  prize_minor: 1000,
  currency: 'USD',
  verification_status: 'pending_review',
  payout_status: 'pending',
  created_at: '2027-01-01T00:00:00Z',
  draws: { draw_month: '2027-01-01' },
};
const WINNER_DETAIL_ROW = { ...WINNER_ROW, reviewed_at: null, review_note: null, paid_at: null };

describe('listForUser / listForAdmin', () => {
  it('lists a user’s own winners, newest first', async () => {
    const { client: c, queries } = client(ok([WINNER_ROW]));
    const result = await createSupabaseWinnerRepository(c).listForUser('u1');
    expect(result).toEqual([
      {
        id: 'w1',
        drawId: 'd1',
        userId: 'u1',
        drawMonth: '2027-01-01',
        matchCount: 5,
        prizeMinor: 1000,
        currency: 'USD',
        verificationStatus: 'pending_review',
        payoutStatus: 'pending',
        createdAt: '2027-01-01T00:00:00Z',
      },
    ]);
    expect(queries[0]?.table).toBe('winners');
    expect(queries[0]?.q.calls).toEqual([
      expect.stringContaining('select('),
      'eq(user_id=u1)',
      'order(created_at,desc)',
    ]);
  });

  it('listForAdmin has no user filter', async () => {
    const { client: c, queries } = client(ok([WINNER_ROW]));
    await createSupabaseWinnerRepository(c).listForAdmin();
    expect(queries[0]?.q.calls).toEqual([
      expect.stringContaining('select('),
      'order(created_at,desc)',
    ]);
  });
});

describe('findOwnById / findAdminById', () => {
  it('findOwnById scopes by id AND user_id, and issues a signed URL per proof', async () => {
    const {
      client: c,
      queries,
      signedUrlCalls,
    } = client(
      ok(WINNER_DETAIL_ROW),
      ok([{ id: 'p1', storage_path: 'w1/shot.png', uploaded_at: '2027-01-02T00:00:00Z' }]),
    );
    const result = await createSupabaseWinnerRepository(c).findOwnById('w1', 'u1');
    expect(result).toMatchObject({
      id: 'w1',
      proofs: [
        {
          id: 'p1',
          storagePath: 'w1/shot.png',
          uploadedAt: '2027-01-02T00:00:00Z',
          url: 'https://signed.test/w1/shot.png',
        },
      ],
    });
    expect(queries[0]?.table).toBe('winners');
    expect(queries[0]?.q.calls).toContain('eq(id=w1)');
    expect(queries[0]?.q.calls).toContain('eq(user_id=u1)');
    expect(queries[1]?.table).toBe('winner_proofs');
    expect(queries[1]?.q.calls).toEqual([
      'select(id, storage_path, uploaded_at)',
      'eq(winner_id=w1)',
      'order(uploaded_at,desc)',
    ]);
    expect(signedUrlCalls).toEqual([{ bucket: 'winner-proofs', path: 'w1/shot.png', ttl: 300 }]);
  });

  it('is null when not found (not owned, or does not exist — indistinguishable)', async () => {
    const { client: c } = client(ok(null));
    expect(await createSupabaseWinnerRepository(c).findOwnById('w1', 'u1')).toBeNull();
  });

  it('findAdminById has no user_id filter', async () => {
    const { client: c, queries } = client(ok(WINNER_DETAIL_ROW), ok([]));
    await createSupabaseWinnerRepository(c).findAdminById('w1');
    expect(queries[0]?.q.calls).toEqual([
      expect.stringContaining('select('),
      'eq(id=w1)',
      'maybeSingle()',
    ]);
  });

  it('a proof whose signed URL fails to issue still appears, with url: null', async () => {
    const { client: c } = client(
      ok(WINNER_DETAIL_ROW),
      ok([{ id: 'p1', storage_path: 'w1/shot.png', uploaded_at: '2027-01-02T00:00:00Z' }]),
    );
    (
      c as unknown as { storage: { from: () => { createSignedUrl: () => Promise<Result> } } }
    ).storage = { from: () => ({ createSignedUrl: () => Promise.resolve(fail('x', 'nope')) }) };
    const result = await createSupabaseWinnerRepository(c).findOwnById('w1', 'u1');
    expect(result?.proofs[0]?.url).toBeNull();
  });
});

describe('registerProof', () => {
  it('sends the exact documented RPC argument names', async () => {
    const { client: c, rpcs } = client(ok(null));
    await createSupabaseWinnerRepository(c).registerProof({
      winnerId: 'w1',
      userId: 'u1',
      storagePath: 'w1/shot.png',
    });
    expect(rpcs).toEqual([
      {
        fn: 'register_winner_proof',
        args: { p_winner_id: 'w1', p_user_id: 'u1', p_storage_path: 'w1/shot.png' },
      },
    ]);
  });

  it.each([
    ['GS007', 'not_awaiting'],
    ['GS008', 'object_missing'],
    ['GS009', 'path_invalid'],
  ] as const)('maps %s to WinnerStateError(%s)', async (code, kind) => {
    const { client: c } = client(fail(code));
    const repo = createSupabaseWinnerRepository(c);
    await expect(
      repo.registerProof({ winnerId: 'w1', userId: 'u1', storagePath: 'w1/x.png' }),
    ).rejects.toMatchObject(new WinnerStateError(kind));
  });

  it('maps 23503 to a plain "not found" failure', async () => {
    const { client: c } = client(fail('23503'));
    await expect(
      createSupabaseWinnerRepository(c).registerProof({
        winnerId: 'w1',
        userId: 'u1',
        storagePath: 'w1/x.png',
      }),
    ).rejects.toThrow('Winner not found');
  });

  it('any other error is a plain failure', async () => {
    const { client: c } = client(fail(undefined, 'boom'));
    await expect(
      createSupabaseWinnerRepository(c).registerProof({
        winnerId: 'w1',
        userId: 'u1',
        storagePath: 'w1/x.png',
      }),
    ).rejects.toThrow(/Proof registration failed/);
  });
});

describe('reopenForResubmission', () => {
  it('sends the exact documented RPC argument names', async () => {
    const { client: c, rpcs } = client(ok(null));
    await createSupabaseWinnerRepository(c).reopenForResubmission('w1', 'u1');
    expect(rpcs).toEqual([
      { fn: 'reopen_winner_proof', args: { p_winner_id: 'w1', p_user_id: 'u1' } },
    ]);
  });

  it('maps GS010 to WinnerStateError(not_rejected)', async () => {
    const { client: c } = client(fail('GS010'));
    await expect(
      createSupabaseWinnerRepository(c).reopenForResubmission('w1', 'u1'),
    ).rejects.toMatchObject(new WinnerStateError('not_rejected'));
  });

  it('maps 23503 to a plain "not found" failure', async () => {
    const { client: c } = client(fail('23503'));
    await expect(
      createSupabaseWinnerRepository(c).reopenForResubmission('w1', 'u1'),
    ).rejects.toThrow('Winner not found');
  });
});

describe('review', () => {
  it('sends the exact documented RPC argument names', async () => {
    const { client: c, rpcs } = client(ok(null));
    await createSupabaseWinnerRepository(c).review('w1', 'admin1', 'approved', 'looks good');
    expect(rpcs).toEqual([
      {
        fn: 'review_winner',
        args: {
          p_winner_id: 'w1',
          p_admin_id: 'admin1',
          p_decision: 'approved',
          p_note: 'looks good',
        },
      },
    ]);
  });

  it('maps GS011 to WinnerStateError(not_pending_review)', async () => {
    const { client: c } = client(fail('GS011'));
    await expect(
      createSupabaseWinnerRepository(c).review('w1', 'admin1', 'rejected', null),
    ).rejects.toMatchObject(new WinnerStateError('not_pending_review'));
  });
});

describe('markPaid', () => {
  it('sends the exact documented RPC argument names', async () => {
    const { client: c, rpcs } = client(ok(null));
    await createSupabaseWinnerRepository(c).markPaid('w1', 'admin1');
    expect(rpcs).toEqual([
      { fn: 'mark_winner_paid', args: { p_winner_id: 'w1', p_admin_id: 'admin1' } },
    ]);
  });

  it('maps GS012 to WinnerStateError(not_approved)', async () => {
    const { client: c } = client(fail('GS012'));
    await expect(createSupabaseWinnerRepository(c).markPaid('w1', 'admin1')).rejects.toMatchObject(
      new WinnerStateError('not_approved'),
    );
  });

  it('maps 23503 to a plain "not found" failure', async () => {
    const { client: c } = client(fail('23503'));
    await expect(createSupabaseWinnerRepository(c).markPaid('w1', 'admin1')).rejects.toThrow(
      'Winner not found',
    );
  });
});

describe('insertAuditLog', () => {
  it('sends the exact documented column names (D-052)', async () => {
    const { client: c, queries } = client(ok(null));
    await createSupabaseWinnerRepository(c).insertAuditLog({
      actorId: 'admin1',
      action: 'winner.approved',
      entityType: 'winner',
      entityId: 'w1',
      details: { note: 'x' },
    });
    expect(queries[0]?.table).toBe('admin_audit_log');
    expect(queries[0]?.q.calls).toEqual([
      `insert(${JSON.stringify({
        actor_id: 'admin1',
        action: 'winner.approved',
        entity_type: 'winner',
        entity_id: 'w1',
        details: { note: 'x' },
      })})`,
    ]);
  });

  it('defaults details to {}', async () => {
    const { client: c, queries } = client(ok(null));
    await createSupabaseWinnerRepository(c).insertAuditLog({
      actorId: 'admin1',
      action: 'winner.paid',
      entityType: 'winner',
      entityId: 'w1',
    });
    expect(queries[0]?.q.calls[0]).toContain('"details":{}');
  });

  it('a write failure is a plain failure', async () => {
    const { client: c } = client(fail(undefined, 'boom'));
    await expect(
      createSupabaseWinnerRepository(c).insertAuditLog({
        actorId: 'admin1',
        action: 'x',
        entityType: 'winner',
        entityId: 'w1',
      }),
    ).rejects.toThrow(/Audit log write failed/);
  });
});
