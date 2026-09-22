import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  createSupabaseBillingRepository,
  parsePlanRow,
  parseSubscriptionRow,
  type RecordPaymentInput,
} from './repository.js';
import { UnprocessableEventError } from './stripe-events.js';

/**
 * The Supabase-facing billing code against a recording stand-in for supabase-js: WHAT is sent (tables, filters,
 * RPC names and argument names) and how database error codes are mapped. The SQL functions themselves are proven on
 * PostgreSQL in supabase/tests/billing.test.ts.
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
  or(filter: string) {
    return this.rec(`or(${filter})`);
  }
  order(c: string, o: { ascending: boolean }) {
    return this.rec(`order(${c},${o.ascending ? 'asc' : 'desc'})`);
  }
  limit(n: number) {
    return this.rec(`limit(${String(n)})`);
  }
  upsert(v: unknown, o: unknown) {
    return this.rec(`upsert(${JSON.stringify(v)}|${JSON.stringify(o)})`);
  }
  update(v: unknown) {
    return this.rec(`update(${JSON.stringify(v)})`);
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

/** Serves canned results in order; records every table query and rpc call. */
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

const PLAN_ROW = {
  id: 'p1',
  name: 'Monthly',
  billing_interval: 'month',
  amount_minor: 1000,
  currency: 'USD',
  stripe_price_id: 'price_1',
};
const SUB_ROW = {
  id: 's1',
  user_id: 'u1',
  status: 'active',
  current_period_end: '2026-10-01T00:00:00+00:00',
  cancel_at_period_end: false,
  ended_at: null,
  plans: { name: 'Monthly', billing_interval: 'month' },
};

describe('row parsing (an untyped boundary)', () => {
  it('maps a plan row', () => {
    expect(parsePlanRow(PLAN_ROW)).toEqual({
      id: 'p1',
      name: 'Monthly',
      interval: 'month',
      amountMinor: 1000,
      currency: 'USD',
      stripePriceId: 'price_1',
    });
    expect(parsePlanRow({ ...PLAN_ROW, stripe_price_id: null }).stripePriceId).toBeNull();
  });
  it.each([
    null,
    'x',
    {},
    { ...PLAN_ROW, billing_interval: 'week' },
    { ...PLAN_ROW, amount_minor: '1000' },
    { ...PLAN_ROW, amount_minor: 10.5 },
    { ...PLAN_ROW, name: 5 },
  ])('rejects a malformed plan %j', (row) => {
    expect(() => parsePlanRow(row)).toThrow(/Malformed/);
  });
  it('maps a subscription row with its embedded plan', () => {
    expect(parseSubscriptionRow(SUB_ROW)).toMatchObject({
      id: 's1',
      userId: 'u1',
      status: 'active',
      planName: 'Monthly',
      interval: 'month',
      cancelAtPeriodEnd: false,
      endedAt: null,
    });
    expect(parseSubscriptionRow(SUB_ROW).currentPeriodEnd?.toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });
  it.each([
    null,
    {},
    { ...SUB_ROW, plans: null },
    { ...SUB_ROW, status: 'paused' },
    { ...SUB_ROW, current_period_end: 'not a date' },
  ])('rejects a malformed subscription %j', (row) => {
    expect(() => parseSubscriptionRow(row)).toThrow(/Malformed/);
  });
});

describe('plans', () => {
  it('reads ACTIVE plans only', async () => {
    const { client: c, queries } = client(ok([PLAN_ROW]));
    expect(await createSupabaseBillingRepository(c).listActivePlans()).toHaveLength(1);
    expect(queries[0]?.table).toBe('plans');
    expect(queries[0]?.q.calls).toEqual([
      'select(id, name, billing_interval, amount_minor, currency, stripe_price_id)',
      'eq(is_active=true)',
      'order(billing_interval,asc)',
    ]);
  });
  it('finds a plan by Stripe price INCLUDING retired ones (a subscription may still be on an old price)', async () => {
    const { client: c, queries } = client(ok(PLAN_ROW));
    expect((await createSupabaseBillingRepository(c).findPlanByStripePriceId('price_1'))?.id).toBe(
      'p1',
    );
    expect(queries[0]?.q.calls).toEqual([
      'select(id, name, billing_interval, amount_minor, currency, stripe_price_id)',
      'eq(stripe_price_id=price_1)',
      'maybeSingle()',
    ]);
    expect(queries[0]?.q.calls.join()).not.toContain('is_active');
  });
  it('returns null for an unknown price, throws on an error', async () => {
    expect(
      await createSupabaseBillingRepository(client(ok(null)).client).findPlanByStripePriceId('x'),
    ).toBeNull();
    await expect(
      createSupabaseBillingRepository(client(fail(undefined)).client).listActivePlans(),
    ).rejects.toThrow(/Plan lookup failed/);
  });
});

describe('subscriptions', () => {
  it("reads only THIS user's rows, newest first, and prefers a live one", async () => {
    const ended = { ...SUB_ROW, id: 's0', status: 'cancelled' };
    const { client: c, queries } = client(ok([ended, SUB_ROW]));
    const current = await createSupabaseBillingRepository(c).findCurrentSubscription('u1');
    expect(current?.id).toBe('s1');
    expect(queries[0]?.table).toBe('subscriptions');
    expect(queries[0]?.q.calls).toEqual([
      expect.stringContaining('plans(name, billing_interval)'),
      'eq(user_id=u1)',
      'order(created_at,desc)',
      'limit(20)',
    ]);
  });
  it('falls back to the most recent ended subscription, else null', async () => {
    expect(
      (
        await createSupabaseBillingRepository(
          client(ok([{ ...SUB_ROW, status: 'lapsed' }])).client,
        ).findCurrentSubscription('u1')
      )?.status,
    ).toBe('lapsed');
    expect(
      await createSupabaseBillingRepository(client(ok([])).client).findCurrentSubscription('u1'),
    ).toBeNull();
  });
  it('finds a subscription by its Stripe id', async () => {
    const { client: c, queries } = client(ok({ id: 's1', user_id: 'u1' }));
    expect(await createSupabaseBillingRepository(c).findSubscriptionByStripeId('sub_1')).toEqual({
      id: 's1',
      userId: 'u1',
    });
    expect(queries[0]?.q.calls).toEqual([
      'select(id, user_id)',
      'eq(stripe_subscription_id=sub_1)',
      'maybeSingle()',
    ]);
  });
});

describe('customers (service-role-only table)', () => {
  it('reads and reverse-reads the mapping', async () => {
    expect(
      await createSupabaseBillingRepository(
        client(ok({ stripe_customer_id: 'cus_1' })).client,
      ).getStripeCustomerId('u1'),
    ).toBe('cus_1');
    expect(
      await createSupabaseBillingRepository(client(ok(null)).client).getStripeCustomerId('u1'),
    ).toBeNull();
    expect(
      await createSupabaseBillingRepository(
        client(ok({ user_id: 'u1' })).client,
      ).findUserIdByStripeCustomer('cus_1'),
    ).toBe('u1');
  });
  it('saves with "existing wins" semantics and returns what is stored', async () => {
    const { client: c, queries } = client(ok(null), ok({ stripe_customer_id: 'cus_existing' }));
    expect(await createSupabaseBillingRepository(c).saveStripeCustomer('u1', 'cus_new')).toBe(
      'cus_existing',
    );
    expect(queries[0]?.q.calls[0]).toBe(
      'upsert({"user_id":"u1","stripe_customer_id":"cus_new"}|{"onConflict":"user_id","ignoreDuplicates":true})',
    );
    expect(queries[1]?.q.calls).toEqual([
      'select(stripe_customer_id)',
      'eq(user_id=u1)',
      'single()',
    ]);
  });
  it('a customer that already belongs to a DIFFERENT user (unique violation) is unprocessable, never reassigned', async () => {
    await expect(
      createSupabaseBillingRepository(client(fail('23505')).client).saveStripeCustomer(
        'u1',
        'cus_1',
      ),
    ).rejects.toBeInstanceOf(UnprocessableEventError);
  });
  it('any other database error is a plain failure (transient)', async () => {
    const err = await createSupabaseBillingRepository(client(fail('08006')).client)
      .saveStripeCustomer('u1', 'cus_1')
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UnprocessableEventError);
    expect((err as Error).message).toMatch(/Customer save failed/);
  });
});

describe('apply_provider_subscription RPC', () => {
  const input = {
    userId: 'u1',
    planId: 'p1',
    stripeSubscriptionId: 'sub_1',
    status: 'active' as const,
    providerStatus: 'active',
    periodStart: new Date('2026-09-01T00:00:00Z'),
    periodEnd: new Date('2026-10-01T00:00:00Z'),
    cancelAtPeriodEnd: true,
    cancelledAt: new Date('2026-09-10T00:00:00Z'),
    endedAt: null,
    eventAt: new Date('2026-09-01T00:00:05Z'),
  };
  it('sends exactly the documented argument names, dates as ISO strings and absent dates as null', async () => {
    const { client: c, rpcs } = client(ok('applied'));
    expect(await createSupabaseBillingRepository(c).applySubscription(input)).toBe('applied');
    expect(rpcs[0]).toEqual({
      fn: 'apply_provider_subscription',
      args: {
        p_user_id: 'u1',
        p_plan_id: 'p1',
        p_stripe_subscription_id: 'sub_1',
        p_status: 'active',
        p_provider_status: 'active',
        p_period_start: '2026-09-01T00:00:00.000Z',
        p_period_end: '2026-10-01T00:00:00.000Z',
        p_cancel_at_period_end: true,
        p_cancelled_at: '2026-09-10T00:00:00.000Z',
        p_ended_at: null,
        p_event_at: '2026-09-01T00:00:05.000Z',
      },
    });
  });
  it.each(['applied', 'stale', 'conflict'])('returns "%s"', async (result) => {
    expect(
      await createSupabaseBillingRepository(client(ok(result)).client).applySubscription(input),
    ).toBe(result);
  });
  it('rejects any other result rather than guessing', async () => {
    await expect(
      createSupabaseBillingRepository(client(ok('maybe')).client).applySubscription(input),
    ).rejects.toThrow(/unexpected result/);
    await expect(
      createSupabaseBillingRepository(client(ok(null)).client).applySubscription(input),
    ).rejects.toThrow(/unexpected result/);
  });
  it.each(['GS003', '23503', '23514'])(
    'SQLSTATE %s is data that can never be applied (unprocessable)',
    async (code) => {
      await expect(
        createSupabaseBillingRepository(client(fail(code)).client).applySubscription(input),
      ).rejects.toBeInstanceOf(UnprocessableEventError);
    },
  );
  it.each(['57014', '40001', undefined])(
    'SQLSTATE %s is a transient failure (retry)',
    async (code) => {
      const err = await createSupabaseBillingRepository(client(fail(code)).client)
        .applySubscription(input)
        .catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(UnprocessableEventError);
      expect((err as Error).message).toMatch(/Subscription update failed/);
    },
  );
});

describe('record_subscription_payment RPC', () => {
  const input: RecordPaymentInput = {
    userId: 'u1',
    subscriptionId: 's1',
    stripeInvoiceId: 'in_1',
    stripePaymentIntentId: 'pi_1',
    amountMinor: 1000,
    currency: 'USD',
    state: 'succeeded',
    paidAt: new Date('2026-09-01T00:00:05Z'),
    periodStart: new Date('2026-09-01T00:00:00Z'),
    periodEnd: new Date('2026-10-01T00:00:00Z'),
    contribution: { charityId: 'c1', percentageBps: 1500, basisMinor: 1000, amountMinor: 150 },
  };
  it('sends the payment and its contribution snapshot as integers in one call', async () => {
    const { client: c, rpcs } = client(
      ok({ payment_id: 'pay1', payment_created: true, contribution_created: true }),
    );
    expect(await createSupabaseBillingRepository(c).recordPayment(input)).toEqual({
      paymentCreated: true,
      contributionCreated: true,
    });
    expect(rpcs[0]).toEqual({
      fn: 'record_subscription_payment',
      args: {
        p_user_id: 'u1',
        p_subscription_id: 's1',
        p_stripe_invoice_id: 'in_1',
        p_stripe_payment_intent_id: 'pi_1',
        p_amount_minor: 1000,
        p_currency: 'USD',
        p_state: 'succeeded',
        p_paid_at: '2026-09-01T00:00:05.000Z',
        p_period_start: '2026-09-01T00:00:00.000Z',
        p_period_end: '2026-10-01T00:00:00.000Z',
        p_charity_id: 'c1',
        p_percentage_bps: 1500,
        p_basis_minor: 1000,
        p_contribution_minor: 150,
      },
    });
    for (const v of [rpcs[0]?.args as Record<string, unknown>].flatMap((a) => [
      a.p_amount_minor,
      a.p_percentage_bps,
      a.p_basis_minor,
      a.p_contribution_minor,
    ])) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });
  it('a failed attempt sends null contribution fields', async () => {
    const { client: c, rpcs } = client(
      ok({ payment_id: 'p', payment_created: true, contribution_created: false }),
    );
    await createSupabaseBillingRepository(c).recordPayment({
      ...input,
      state: 'failed',
      paidAt: null,
      contribution: null,
    });
    expect(rpcs[0]?.args).toMatchObject({
      p_state: 'failed',
      p_paid_at: null,
      p_charity_id: null,
      p_percentage_bps: null,
      p_basis_minor: null,
      p_contribution_minor: null,
    });
  });
  it.each(['GS003', 'GS004', '23514', '23503'])('SQLSTATE %s is unprocessable', async (code) => {
    await expect(
      createSupabaseBillingRepository(client(fail(code)).client).recordPayment(input),
    ).rejects.toBeInstanceOf(UnprocessableEventError);
  });
  it('another database error is transient', async () => {
    const err = await createSupabaseBillingRepository(client(fail('57014')).client)
      .recordPayment(input)
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UnprocessableEventError);
  });
  it.each([null, 'x', {}, { payment_created: 'yes', contribution_created: true }])(
    'rejects a malformed result %j',
    async (data) => {
      await expect(
        createSupabaseBillingRepository(client(ok(data)).client).recordPayment(input),
      ).rejects.toThrow(/unexpected result/);
    },
  );
});

describe('the webhook ledger (stripe_events)', () => {
  const event = {
    id: 'evt_1',
    type: 'invoice.paid',
    livemode: false,
    summary: { id: 'evt_1', type: 'invoice.paid', created: 'x' },
  };
  it('the first delivery inserts (keyed by the event id) and is "new"', async () => {
    const { client: c, queries } = client(ok([{ id: 'evt_1' }]));
    expect(await createSupabaseBillingRepository(c).claimEvent(event)).toBe('new');
    expect(queries[0]?.table).toBe('stripe_events');
    expect(queries[0]?.q.calls).toEqual([
      'upsert({"id":"evt_1","type":"invoice.paid","livemode":false,"payload":{"id":"evt_1","type":"invoice.paid","created":"x"}}|{"onConflict":"id","ignoreDuplicates":true})',
      'select(id)',
    ]);
  });
  it('a redelivery of a PROCESSED event is a duplicate', async () => {
    expect(
      await createSupabaseBillingRepository(
        client(ok([]), ok({ status: 'processed' })).client,
      ).claimEvent(event),
    ).toBe('duplicate');
  });
  it.each(['received', 'failed'])('a redelivery of a %s event is retried', async (status) => {
    expect(
      await createSupabaseBillingRepository(client(ok([]), ok({ status })).client).claimEvent(
        event,
      ),
    ).toBe('retry');
  });
  it('a ledger failure is an error (fail closed: never process an event we could not record)', async () => {
    await expect(
      createSupabaseBillingRepository(client(fail(undefined)).client).claimEvent(event),
    ).rejects.toThrow(/Event ledger failed/);
  });
  it('marks processed with a timestamp, or failed with a bounded error', async () => {
    const a = client(ok(null));
    await createSupabaseBillingRepository(a.client).markEvent('evt_1', { status: 'processed' });
    expect(a.queries[0]?.q.calls[0]).toMatch(
      /^update\({"status":"processed","processed_at":"\d{4}-.+Z","error":null}\)$/,
    );
    expect(a.queries[0]?.q.calls[1]).toBe('eq(id=evt_1)');
    const b = client(ok(null));
    await createSupabaseBillingRepository(b.client).markEvent('evt_1', {
      status: 'failed',
      error: 'x'.repeat(2000),
    });
    const sent = JSON.parse((b.queries[0]?.q.calls[0] ?? '').replace(/^update\(|\)$/g, '')) as {
      status: string;
      processed_at: null;
      error: string;
    };
    expect(sent).toMatchObject({ status: 'failed', processed_at: null });
    expect(sent.error).toHaveLength(500);
  });
});

describe('hasOpenSubscription — checkout ELIGIBILITY, a different question from access (D-068)', () => {
  it('asks the has_open_subscription SQL function for THIS user', async () => {
    const { client: c, rpcs, queries } = client(ok(true));
    expect(await createSupabaseBillingRepository(c).hasOpenSubscription('u1')).toBe(true);
    expect(rpcs).toEqual([{ fn: 'has_open_subscription', args: { p_user_id: 'u1' } }]);
    expect(queries).toHaveLength(0); // the rule lives in SQL, not in a client-side filter
  });
  it('is false only when the database says nothing is open', async () => {
    expect(
      await createSupabaseBillingRepository(client(ok(false)).client).hasOpenSubscription('u1'),
    ).toBe(false);
  });
  it('a lookup failure throws (fails closed) instead of reading as "nothing open"', async () => {
    await expect(
      createSupabaseBillingRepository(client(fail(undefined)).client).hasOpenSubscription('u1'),
    ).rejects.toThrow(/Subscription lookup failed/);
  });
  it.each([null, undefined, 'false', 0, 1, {}])(
    'an unexpected answer %j is an error, never "nothing open"',
    async (data) => {
      await expect(
        createSupabaseBillingRepository(client(ok(data)).client).hasOpenSubscription('u1'),
      ).rejects.toThrow(/unexpected result/);
    },
  );
});
