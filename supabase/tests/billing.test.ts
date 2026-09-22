import type { PGlite, Transaction } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { as, asOwner, attempt, createMigratedDatabase, PG } from './support/database';
import {
  createCharity,
  createPlan,
  createSubscription,
  createUser,
  TEST_CURRENCY,
  uniq,
} from './support/fixtures';

/**
 * The database side of the Stripe integration (Phase 5, DECISIONS D-068/D-069, migration …140000):
 * webhook-safe subscription upserts, atomic idempotent payment + contribution recording,
 * the explicit access-vs-eligibility rules and append-only contribution history. The API calls these with the
 * service role.
 */

let db: PGlite;
let alice: string;
let bob: string;

beforeAll(async () => {
  db = await createMigratedDatabase();
  alice = await createUser(db);
  bob = await createUser(db);
});

const T0 = '2026-09-01T10:00:00Z';
const T1 = '2026-09-01T10:00:05Z';
const T2 = '2026-09-01T10:00:10Z';
const PERIOD_START = '2026-09-01T10:00:00Z';
const PERIOD_END = '2026-10-01T10:00:00Z';

interface SubArgs {
  user: string;
  plan: string;
  stripeId: string;
  status: 'pending' | 'active' | 'cancelled' | 'lapsed';
  providerStatus: string;
  periodStart: string | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  cancelledAt: string | null;
  endedAt: string | null;
  eventAt: string;
}

async function applySub(tx: Transaction, a: SubArgs): Promise<string> {
  const { rows } = await tx.query<{ r: string }>(
    `select public.apply_provider_subscription($1::uuid, $2::uuid, $3, $4::public.subscription_status, $5,
        $6::timestamptz, $7::timestamptz, $8, $9::timestamptz, $10::timestamptz, $11::timestamptz) as r`,
    [
      a.user,
      a.plan,
      a.stripeId,
      a.status,
      a.providerStatus,
      a.periodStart,
      a.periodEnd,
      a.cancelAtPeriodEnd,
      a.cancelledAt,
      a.endedAt,
      a.eventAt,
    ],
  );
  return rows[0]?.r ?? '';
}

const activeArgs = (user: string, plan: string, over: Partial<SubArgs> = {}): SubArgs => ({
  user,
  plan,
  stripeId: `sub_${uniq()}`,
  status: 'active',
  providerStatus: 'active',
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
  cancelAtPeriodEnd: false,
  cancelledAt: null,
  endedAt: null,
  eventAt: T1,
  ...over,
});

const subRow = async (tx: Transaction, stripeId: string) =>
  (
    await tx.query<{
      user_id: string;
      plan_id: string;
      status: string;
      provider_status: string;
      cancel_at_period_end: boolean;
      current_period_end: string;
      provider_event_at: string;
      cancelled_at: string | null;
    }>(`select * from public.subscriptions where stripe_subscription_id = $1`, [stripeId])
  ).rows[0];

describe('apply_provider_subscription() — webhook-safe upsert (D-068)', () => {
  it('inserts a subscription from a Stripe event', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const a = activeArgs(alice, plan);
      expect(await applySub(tx, a)).toBe('applied');
      const row = await subRow(tx, a.stripeId);
      expect(row).toMatchObject({
        user_id: alice,
        plan_id: plan,
        status: 'active',
        provider_status: 'active',
        cancel_at_period_end: false,
      });
      expect(new Date(row?.current_period_end ?? '').toISOString()).toBe(
        new Date(PERIOD_END).toISOString(),
      );
    });
  });

  it('updates the same Stripe subscription: renewal, plan switch and cancellation at period end', async () => {
    await asOwner(db, async (tx) => {
      const monthly = await createPlan(tx, { interval: 'month' });
      const yearly = await createPlan(tx, { interval: 'year', active: false });
      const a = activeArgs(alice, monthly);
      await applySub(tx, a);
      expect(
        await applySub(tx, { ...a, plan: yearly, periodEnd: '2027-10-01T10:00:00Z', eventAt: T2 }),
      ).toBe('applied');
      expect((await subRow(tx, a.stripeId))?.plan_id).toBe(yearly);
      expect(
        await applySub(tx, {
          ...a,
          plan: yearly,
          periodEnd: '2027-10-01T10:00:00Z',
          cancelAtPeriodEnd: true,
          cancelledAt: T2,
          eventAt: '2026-09-01T10:00:20Z',
        }),
      ).toBe('applied');
      const row = await subRow(tx, a.stripeId);
      expect(row).toMatchObject({ status: 'active', cancel_at_period_end: true });
      expect(row?.cancelled_at).not.toBeNull();
    });
  });

  it('ignores an event OLDER than the state already stored (out-of-order delivery)', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const a = activeArgs(alice, plan, { eventAt: T2 });
      await applySub(tx, a);
      expect(
        await applySub(tx, { ...a, status: 'lapsed', providerStatus: 'past_due', eventAt: T0 }),
      ).toBe('stale');
      expect((await subRow(tx, a.stripeId))?.status).toBe('active');
    });
  });

  it('applies an event with the SAME timestamp again (a replay changes nothing)', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const a = activeArgs(alice, plan);
      await applySub(tx, a);
      expect(await applySub(tx, a)).toBe('applied');
      const { rows } = await tx.query<{ n: number }>(
        `select count(*)::int as n from public.subscriptions where user_id = $1`,
        [alice],
      );
      expect(rows[0]?.n).toBe(1);
    });
  });

  it('a newer event overrides an older one (active → lapsed → active)', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const a = activeArgs(alice, plan, { eventAt: T0 });
      await applySub(tx, a);
      await applySub(tx, { ...a, status: 'lapsed', providerStatus: 'past_due', eventAt: T1 });
      expect((await subRow(tx, a.stripeId))?.status).toBe('lapsed');
      await applySub(tx, { ...a, eventAt: T2 });
      expect((await subRow(tx, a.stripeId))?.status).toBe('active');
    });
  });

  it('refuses a SECOND live subscription for the same user (D-044) and reports a conflict', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const first = activeArgs(alice, plan);
      const second = activeArgs(alice, plan);
      await applySub(tx, first);
      expect(await applySub(tx, second)).toBe('conflict');
      expect(await subRow(tx, second.stripeId)).toBeUndefined();
      expect((await subRow(tx, first.stripeId))?.status).toBe('active');
    });
  });

  it('allows a new subscription once the previous one has ended (re-subscribing)', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const first = activeArgs(alice, plan);
      await applySub(tx, first);
      await applySub(tx, {
        ...first,
        status: 'cancelled',
        providerStatus: 'canceled',
        endedAt: T2,
        eventAt: T2,
      });
      expect(await applySub(tx, activeArgs(alice, plan, { eventAt: '2026-09-02T00:00:00Z' }))).toBe(
        'applied',
      );
    });
  });

  it('reports a conflict when an ended subscription is revived while another is live', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const old = activeArgs(alice, plan, {
        status: 'cancelled',
        providerStatus: 'canceled',
        periodEnd: null,
        periodStart: null,
        endedAt: T0,
      });
      await applySub(tx, old);
      await applySub(tx, activeArgs(alice, plan, { eventAt: T1 }));
      expect(
        await applySub(tx, {
          ...old,
          status: 'active',
          providerStatus: 'active',
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          endedAt: null,
          eventAt: T2,
        }),
      ).toBe('conflict');
      expect((await subRow(tx, old.stripeId))?.status).toBe('cancelled');
    });
  });

  it('two different users can each have a live subscription', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      expect(await applySub(tx, activeArgs(alice, plan))).toBe('applied');
      expect(await applySub(tx, activeArgs(bob, plan))).toBe('applied');
    });
  });

  it('pending (incomplete) subscriptions need no period; active ones still must have a renewal date (D-044)', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const p = activeArgs(alice, plan, {
        status: 'pending',
        providerStatus: 'incomplete',
        periodStart: null,
        periodEnd: null,
      });
      expect(await applySub(tx, p)).toBe('applied');
      const err = await attempt(tx, () =>
        applySub(tx, { ...p, status: 'active', providerStatus: 'active', eventAt: T2 }),
      );
      expect(err.code).toBe(PG.checkViolation);
    });
  });

  it('refuses to attach a Stripe subscription to a different user (SQLSTATE GS003)', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const a = activeArgs(alice, plan);
      await applySub(tx, a);
      const err = await attempt(tx, () => applySub(tx, { ...a, user: bob, eventAt: T2 }));
      expect(err.code).toBe('GS003');
    });
  });
});

interface PayArgs {
  user: string;
  subscription: string;
  invoice: string;
  paymentIntent: string | null;
  amount: number;
  currency: string;
  state: 'pending' | 'succeeded' | 'failed' | 'refunded';
  paidAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  charity: string | null;
  bps: number | null;
  basis: number | null;
  contribution: number | null;
}

async function pay(tx: Transaction, a: PayArgs) {
  const { rows } = await tx.query<{
    r: { payment_id: string; payment_created: boolean; contribution_created: boolean };
  }>(
    `select public.record_subscription_payment($1::uuid, $2::uuid, $3, $4, $5::bigint, $6, $7::public.payment_state,
        $8::timestamptz, $9::timestamptz, $10::timestamptz, $11::uuid, $12::int, $13::bigint, $14::bigint) as r`,
    [
      a.user,
      a.subscription,
      a.invoice,
      a.paymentIntent,
      a.amount,
      a.currency,
      a.state,
      a.paidAt,
      a.periodStart,
      a.periodEnd,
      a.charity,
      a.bps,
      a.basis,
      a.contribution,
    ],
  );
  return rows[0]?.r as {
    payment_id: string;
    payment_created: boolean;
    contribution_created: boolean;
  };
}

const paidArgs = (
  user: string,
  subscription: string,
  charity: string,
  over: Partial<PayArgs> = {},
): PayArgs => ({
  user,
  subscription,
  invoice: `in_${uniq()}`,
  paymentIntent: `pi_${uniq()}`,
  amount: 1000,
  currency: TEST_CURRENCY,
  state: 'succeeded',
  paidAt: T1,
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
  charity,
  bps: 1500,
  basis: 1000,
  contribution: 150,
  ...over,
});

const counts = async (tx: Transaction, userId: string) =>
  (
    await tx.query<{ payments: number; contributions: number }>(
      `select (select count(*)::int from public.payments where user_id = $1) as payments,
              (select count(*)::int from public.charity_contributions where user_id = $1) as contributions`,
      [userId],
    )
  ).rows[0];

describe('record_subscription_payment() — atomic, idempotent payment + charity snapshot (D-069)', () => {
  it('records the payment AND its contribution snapshot together', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const sub = await createSubscription(tx, alice, plan);
      const charity = await createCharity(tx);
      const a = paidArgs(alice, sub, charity);
      expect(await pay(tx, a)).toMatchObject({ payment_created: true, contribution_created: true });

      const p = (
        await tx.query<Record<string, unknown>>(
          `select * from public.payments where stripe_invoice_id = $1`,
          [a.invoice],
        )
      ).rows[0];
      expect(p).toMatchObject({
        user_id: alice,
        kind: 'subscription',
        subscription_id: sub,
        currency: TEST_CURRENCY,
        state: 'succeeded',
        stripe_payment_intent_id: a.paymentIntent,
      });
      expect(Number(p?.amount_minor)).toBe(1000);
      expect(new Date(p?.period_start as string).toISOString()).toBe(
        new Date(PERIOD_START).toISOString(),
      );
      expect(new Date(p?.period_end as string).toISOString()).toBe(
        new Date(PERIOD_END).toISOString(),
      );

      const c = (
        await tx.query<Record<string, unknown>>(
          `select * from public.charity_contributions where payment_id = $1`,
          [p?.id],
        )
      ).rows[0];
      expect(c).toMatchObject({
        user_id: alice,
        charity_id: charity,
        source: 'subscription',
        currency: TEST_CURRENCY,
        percentage_bps: 1500,
      });
      expect([Number(c?.basis_minor), Number(c?.amount_minor)]).toEqual([1000, 150]);
    });
  });

  it('is idempotent: replaying the same invoice changes nothing', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const sub = await createSubscription(tx, alice, plan);
      const charity = await createCharity(tx);
      const a = paidArgs(alice, sub, charity);
      await pay(tx, a);
      expect(await pay(tx, a)).toMatchObject({
        payment_created: false,
        contribution_created: false,
      });
      expect(await pay(tx, a)).toMatchObject({
        payment_created: false,
        contribution_created: false,
      });
      expect(await counts(tx, alice)).toEqual({ payments: 1, contributions: 1 });
    });
  });

  it('a later replay with a DIFFERENT charity or percentage never rewrites the original snapshot', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const sub = await createSubscription(tx, alice, plan);
      const first = await createCharity(tx);
      const second = await createCharity(tx);
      const a = paidArgs(alice, sub, first);
      await pay(tx, a);
      await pay(tx, { ...a, charity: second, bps: 4000, contribution: 400 });
      const c = (
        await tx.query<{ charity_id: string; percentage_bps: number; amount_minor: string }>(
          `select * from public.charity_contributions where user_id = $1`,
          [alice],
        )
      ).rows;
      expect(c).toHaveLength(1);
      expect(c[0]).toMatchObject({ charity_id: first, percentage_bps: 1500 });
      expect(Number(c[0]?.amount_minor)).toBe(150);
    });
  });

  it('a failed attempt is recorded without a contribution, then becomes succeeded when the invoice is paid', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const sub = await createSubscription(tx, alice, plan);
      const charity = await createCharity(tx);
      const a = paidArgs(alice, sub, charity);
      const failed = {
        ...a,
        state: 'failed' as const,
        paidAt: null,
        paymentIntent: null,
        charity: null,
        bps: null,
        basis: null,
        contribution: null,
      };
      expect(await pay(tx, failed)).toMatchObject({
        payment_created: true,
        contribution_created: false,
      });
      expect(await counts(tx, alice)).toEqual({ payments: 1, contributions: 0 });
      expect(await pay(tx, a)).toMatchObject({
        payment_created: false,
        contribution_created: true,
      });
      const p = (
        await tx.query<{ state: string; stripe_payment_intent_id: string }>(
          `select state, stripe_payment_intent_id from public.payments where stripe_invoice_id = $1`,
          [a.invoice],
        )
      ).rows[0];
      expect(p).toMatchObject({ state: 'succeeded', stripe_payment_intent_id: a.paymentIntent });
      expect(await counts(tx, alice)).toEqual({ payments: 1, contributions: 1 });
    });
  });

  it('never downgrades money already received: a late "failed" event leaves a succeeded payment alone', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const sub = await createSubscription(tx, alice, plan);
      const charity = await createCharity(tx);
      const a = paidArgs(alice, sub, charity);
      await pay(tx, a);
      await pay(tx, {
        ...a,
        state: 'failed',
        paidAt: null,
        charity: null,
        bps: null,
        basis: null,
        contribution: null,
      });
      const p = (
        await tx.query<{ state: string }>(
          `select state from public.payments where stripe_invoice_id = $1`,
          [a.invoice],
        )
      ).rows[0];
      expect(p?.state).toBe('succeeded');
      expect(await counts(tx, alice)).toEqual({ payments: 1, contributions: 1 });
    });
  });

  it('refuses a succeeded payment WITHOUT its contribution (GS004) and writes nothing', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const sub = await createSubscription(tx, alice, plan);
      const err = await attempt(tx, () =>
        pay(tx, paidArgs(alice, sub, '00000000-0000-4000-8000-000000000001', { charity: null })),
      );
      expect(err.code).toBe('GS004');
      expect(await counts(tx, alice)).toEqual({ payments: 0, contributions: 0 });
    });
  });

  it('is ATOMIC: a contribution the table refuses (below 10%) leaves no payment behind', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const sub = await createSubscription(tx, alice, plan);
      const charity = await createCharity(tx);
      const err = await attempt(tx, () =>
        pay(tx, paidArgs(alice, sub, charity, { bps: 999, contribution: 99 })),
      );
      expect(err.code).toBe(PG.checkViolation);
      expect(await counts(tx, alice)).toEqual({ payments: 0, contributions: 0 });
    });
  });

  it('is ATOMIC: a contribution larger than its basis leaves no payment behind', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const sub = await createSubscription(tx, alice, plan);
      const charity = await createCharity(tx);
      const err = await attempt(tx, () =>
        pay(tx, paidArgs(alice, sub, charity, { contribution: 1001 })),
      );
      expect(err.code).toBe(PG.checkViolation);
      expect(await counts(tx, alice)).toEqual({ payments: 0, contributions: 0 });
    });
  });

  it('a contribution to an ARCHIVED charity is accepted: archiving hides a charity, it does not erase it (D-043, D-069)', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const sub = await createSubscription(tx, alice, plan);
      const archived = await createCharity(tx, { archived: true });
      expect(await pay(tx, paidArgs(alice, sub, archived))).toMatchObject({
        contribution_created: true,
      });
    });
  });

  it('refuses a subscription that belongs to another user, or an invoice already recorded for another (GS003)', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const aliceSub = await createSubscription(tx, alice, plan);
      const charity = await createCharity(tx);
      const wrongOwner = await attempt(tx, () => pay(tx, paidArgs(bob, aliceSub, charity)));
      expect(wrongOwner.code).toBe('GS003');
      const bobSub = await createSubscription(tx, bob, plan);
      const a = paidArgs(alice, aliceSub, charity);
      await pay(tx, a);
      const wrongInvoice = await attempt(tx, () =>
        pay(tx, { ...a, user: bob, subscription: bobSub }),
      );
      expect(wrongInvoice.code).toBe('GS003');
      expect(await counts(tx, bob)).toEqual({ payments: 0, contributions: 0 });
    });
  });

  it('money stays integer minor units: zero and negative amounts are refused, nothing is written', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const sub = await createSubscription(tx, alice, plan);
      const charity = await createCharity(tx);
      for (const amount of [0, -100]) {
        const err = await attempt(tx, () =>
          pay(tx, paidArgs(alice, sub, charity, { amount, basis: 1000, contribution: 100 })),
        );
        expect(err.code, String(amount)).toBe(PG.checkViolation);
      }
      expect(await counts(tx, alice)).toEqual({ payments: 0, contributions: 0 });
    });
  });

  it('refuses a period that ends before it starts', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const sub = await createSubscription(tx, alice, plan);
      const charity = await createCharity(tx);
      const err = await attempt(tx, () =>
        pay(
          tx,
          paidArgs(alice, sub, charity, { periodStart: PERIOD_END, periodEnd: PERIOD_START }),
        ),
      );
      expect(err.code).toBe(PG.checkViolation);
    });
  });
});

describe('the service-role-only surface (Phase 5)', () => {
  const FUNCTIONS = [
    'apply_provider_subscription',
    'record_subscription_payment',
    'has_open_subscription',
  ];

  it('neither function is executable by anon, authenticated or public — only by the service role', async () => {
    for (const fn of FUNCTIONS) {
      const { rows } = await db.query<{
        anon: boolean;
        authed: boolean;
        pub: boolean;
        service: boolean;
        definer: boolean;
      }>(
        `select has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as authed,
                has_function_privilege('public', p.oid, 'execute') as pub,
                has_function_privilege('service_role', p.oid, 'execute') as service,
                p.prosecdef as definer
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`,
        [fn],
      );
      expect(rows[0], fn).toEqual({
        anon: false,
        authed: false,
        pub: false,
        service: true,
        definer: false,
      });
    }
  });

  it("a signed-in user cannot call them through the RPC surface to write someone else's billing state", async () => {
    await as(db, { role: 'authenticated', userId: alice }, async (tx) => {
      const err = await attempt(tx, () =>
        tx.query(
          `select public.apply_provider_subscription($1::uuid, $1::uuid, 'sub_x', 'active', 'active', now(), now() + interval '1 day', false, null, null, now())`,
          [bob],
        ),
      );
      expect(err.code).toBe(PG.insufficientPrivilege);
    });
  });
});

interface SubRow {
  status: 'pending' | 'active' | 'cancelled' | 'lapsed';
  providerStatus: string | null;
  /** Offset from now, as a PostgreSQL interval; null = no period. */
  periodEnd: string | null;
}

/** Inserts the subscription directly and asks BOTH questions of it, in one rolled-back transaction. */
async function ask(row: SubRow): Promise<{ access: boolean; open: boolean }> {
  return asOwner(db, async (tx) => {
    const user = await createUser(tx);
    const plan = await createPlan(tx);
    await tx.query(
      `insert into public.subscriptions (user_id, plan_id, status, provider_status, current_period_end)
       values ($1, $2, $3, $4, case when $5::text is null then null else now() + $5::interval end)`,
      [user, plan, row.status, row.providerStatus, row.periodEnd],
    );
    const { rows } = await tx.query<{ access: boolean; open: boolean }>(
      `select public.is_active_subscriber($1::uuid) as access, public.has_open_subscription($1::uuid) as open`,
      [user],
    );
    return rows[0] as { access: boolean; open: boolean };
  });
}

describe('ACCESS — is_active_subscriber(): the paid period as recorded, with NO tolerance (D-068, provisional D-026)', () => {
  const access = async (status: SubRow['status'], periodEnd: string | null) =>
    (await ask({ status, providerStatus: status === 'active' ? 'active' : null, periodEnd }))
      .access;

  it('an active subscription inside its paid period has access', async () => {
    expect(await access('active', '10 days')).toBe(true);
    expect(await access('active', '1 minute')).toBe(true);
  });

  it('access ends when the recorded period ends — even by a minute (PRD SUB-05: no extra entitlement for a late webhook)', async () => {
    expect(await access('active', '-1 minute')).toBe(false);
    expect(await access('active', '-1 second')).toBe(false);
  });

  it('there is no grace of days either', async () => {
    for (const late of ['-1 hour', '-1 day', '-2 days', '-4 days']) {
      expect(await access('active', late), late).toBe(false);
    }
  });

  it('the period end is exclusive: a period that ends exactly now has no access', async () => {
    expect(await access('active', '0 seconds')).toBe(false);
  });

  it('pending, lapsed and cancelled subscriptions never have access, whatever their period says', async () => {
    for (const status of ['pending', 'lapsed', 'cancelled'] as const) {
      expect(await access(status, '10 days'), status).toBe(false);
    }
  });

  it('a user with no subscription has no access', async () => {
    expect(
      (await db.query<{ ok: boolean }>(`select public.is_active_subscriber($1::uuid) as ok`, [bob]))
        .rows[0]?.ok,
    ).toBe(false);
  });

  it('cancelling at period end keeps access until the period ends, and not after', async () => {
    const check = async (periodEnd: string) =>
      asOwner(db, async (tx) => {
        const user = await createUser(tx);
        const plan = await createPlan(tx);
        await tx.query(
          `insert into public.subscriptions (user_id, plan_id, status, provider_status, current_period_end, cancel_at_period_end, cancelled_at)
           values ($1, $2, 'active', 'active', now() + $3::interval, true, now())`,
          [user, plan, periodEnd],
        );
        return (
          await tx.query<{ ok: boolean }>(`select public.is_active_subscriber($1::uuid) as ok`, [
            user,
          ])
        ).rows[0]?.ok;
      });
    expect(await check('3 days')).toBe(true);
    expect(await check('-1 minute')).toBe(false);
  });
});

describe('ACCESS vs ELIGIBILITY — two different questions, answered side by side (D-068)', () => {
  // access = may they use subscriber features now?   open = must a NEW checkout be refused (could double-charge)?
  const CASES: [string, SubRow, { access: boolean; open: boolean }][] = [
    [
      'active, period current',
      { status: 'active', providerStatus: 'active', periodEnd: '10 days' },
      { access: true, open: true },
    ],
    [
      'active (trialing), period current',
      { status: 'active', providerStatus: 'trialing', periodEnd: '10 days' },
      { access: true, open: true },
    ],
    [
      'active, period ended with no renewal recorded',
      { status: 'active', providerStatus: 'active', periodEnd: '-1 day' },
      { access: false, open: true },
    ],
    [
      'pending (incomplete first payment)',
      { status: 'pending', providerStatus: 'incomplete', periodEnd: null },
      { access: false, open: true },
    ],
    [
      'lapsed, past_due (Stripe is retrying it)',
      { status: 'lapsed', providerStatus: 'past_due', periodEnd: '10 days' },
      { access: false, open: true },
    ],
    [
      'lapsed, unpaid (can be reactivated)',
      { status: 'lapsed', providerStatus: 'unpaid', periodEnd: '10 days' },
      { access: false, open: true },
    ],
    [
      'lapsed, paused (can be resumed)',
      { status: 'lapsed', providerStatus: 'paused', periodEnd: '10 days' },
      { access: false, open: true },
    ],
    [
      'lapsed, incomplete_expired (never became active)',
      { status: 'lapsed', providerStatus: 'incomplete_expired', periodEnd: null },
      { access: false, open: false },
    ],
    [
      'cancelled (Stripe: canceled)',
      { status: 'cancelled', providerStatus: 'canceled', periodEnd: '-1 day' },
      { access: false, open: false },
    ],
    [
      'a status Stripe adds later (fails safe: open)',
      { status: 'lapsed', providerStatus: 'some_new_state', periodEnd: null },
      { access: false, open: true },
    ],
    [
      'active with no provider status (pre-Stripe row)',
      { status: 'active', providerStatus: null, periodEnd: '10 days' },
      { access: true, open: true },
    ],
    [
      'lapsed with no provider status (pre-Stripe row)',
      { status: 'lapsed', providerStatus: null, periodEnd: null },
      { access: false, open: false },
    ],
    [
      'cancelled with no provider status (pre-Stripe row)',
      { status: 'cancelled', providerStatus: null, periodEnd: null },
      { access: false, open: false },
    ],
  ];

  it.each(CASES)('%s', async (_name, row, expected) => {
    expect(await ask(row)).toEqual(expected);
  });

  it('a retrying (past_due) subscription has NO access but DOES block a second checkout — no double charge, and the behaviour is explicit', async () => {
    const r = await ask({ status: 'lapsed', providerStatus: 'past_due', periodEnd: '10 days' });
    expect(r.access).toBe(false);
    expect(r.open).toBe(true);
  });

  it('a user with no subscription at all has nothing open', async () => {
    const { rows } = await db.query<{ open: boolean }>(
      `select public.has_open_subscription($1::uuid) as open`,
      [bob],
    );
    expect(rows[0]?.open).toBe(false);
  });

  it('only the user asked about counts: another user\u2019s open subscription is not mine', async () => {
    await asOwner(db, async (tx) => {
      const other = await createUser(tx);
      const me = await createUser(tx);
      const plan = await createPlan(tx);
      await createSubscription(tx, other, plan);
      const { rows } = await tx.query<{ open: boolean }>(
        `select public.has_open_subscription($1::uuid) as open`,
        [me],
      );
      expect(rows[0]?.open).toBe(false);
    });
  });

  it('after the webhooks END a subscription, the user may subscribe again (and a new one is applied)', async () => {
    await asOwner(db, async (tx) => {
      const user = await createUser(tx);
      const plan = await createPlan(tx);
      const a = activeArgs(user, plan);
      await applySub(tx, a);
      const open = async () =>
        (
          await tx.query<{ o: boolean }>(`select public.has_open_subscription($1::uuid) as o`, [
            user,
          ])
        ).rows[0]?.o;
      expect(await open()).toBe(true);
      await applySub(tx, { ...a, status: 'lapsed', providerStatus: 'past_due', eventAt: T2 });
      expect(await open()).toBe(true); // overdue: Stripe still retrying
      await applySub(tx, {
        ...a,
        status: 'cancelled',
        providerStatus: 'canceled',
        endedAt: T2,
        eventAt: '2026-09-01T10:00:20Z',
      });
      expect(await open()).toBe(false); // really over
    });
  });
});

describe('charity contribution history is APPEND-ONLY (D-069): a payment\u2019s snapshot is never rewritten', () => {
  async function paid(tx: Transaction, over: Partial<PayArgs> = {}) {
    const user = await createUser(tx);
    const plan = await createPlan(tx);
    const sub = await createSubscription(tx, user, plan);
    const charity = await createCharity(tx);
    const a = paidArgs(user, sub, charity, over);
    await pay(tx, a);
    return { user, charity, a };
  }
  const contribution = async (tx: Transaction, user: string) =>
    (
      await tx.query<{
        charity_id: string;
        percentage_bps: number;
        basis_minor: string;
        amount_minor: string;
      }>(
        `select charity_id, percentage_bps, basis_minor, amount_minor from public.charity_contributions where user_id = $1`,
        [user],
      )
    ).rows[0];

  it('a contribution row cannot be UPDATED — not its charity, percentage, basis or amount', async () => {
    await asOwner(db, async (tx) => {
      const { user } = await paid(tx);
      const other = await createCharity(tx);
      for (const set of [
        `charity_id = '${other}'`,
        'percentage_bps = 4000',
        'amount_minor = 1',
        'basis_minor = 9999',
      ]) {
        const err = await attempt(tx, () =>
          tx.query(`update public.charity_contributions set ${set} where user_id = $1`, [user]),
        );
        expect(err.code, set).toBe(PG.integrityViolation);
        expect(err.message).toMatch(/append-only/);
      }
      expect(await contribution(tx, user)).toMatchObject({ percentage_bps: 1500 });
    });
  });

  it('a contribution row cannot be DELETED', async () => {
    await asOwner(db, async (tx) => {
      const { user } = await paid(tx);
      const err = await attempt(tx, () =>
        tx.query(`delete from public.charity_contributions where user_id = $1`, [user]),
      );
      expect(err.code).toBe(PG.integrityViolation);
      expect(await counts(tx, user)).toEqual({ payments: 1, contributions: 1 });
    });
  });

  it('ARCHIVING the charity does not change the recorded contribution', async () => {
    await asOwner(db, async (tx) => {
      const { user, charity } = await paid(tx);
      const before = await contribution(tx, user);
      await tx.query(`update public.charities set archived_at = now() where id = $1`, [charity]);
      expect(await contribution(tx, user)).toEqual(before);
    });
  });

  it('the user CHANGING their charity or percentage afterwards does not change it either', async () => {
    await asOwner(db, async (tx) => {
      const { user, charity } = await paid(tx);
      const before = await contribution(tx, user);
      const other = await createCharity(tx);
      await tx.query(
        `update public.profiles set selected_charity_id = $2, charity_bps = 4000 where id = $1`,
        [user, other],
      );
      expect(await contribution(tx, user)).toEqual(before);
      expect(before?.charity_id).toBe(charity);
      expect(before?.percentage_bps).toBe(1500);
    });
  });

  it('a later payment by the same user gets its OWN snapshot; the earlier one is untouched', async () => {
    await asOwner(db, async (tx) => {
      const user = await createUser(tx);
      const plan = await createPlan(tx);
      const sub = await createSubscription(tx, user, plan);
      const first = await createCharity(tx);
      const second = await createCharity(tx);
      await pay(tx, paidArgs(user, sub, first));
      await pay(tx, paidArgs(user, sub, second, { bps: 4000, contribution: 400 }));
      const { rows } = await tx.query<{ charity_id: string; percentage_bps: number }>(
        `select charity_id, percentage_bps from public.charity_contributions where user_id = $1 order by created_at, percentage_bps`,
        [user],
      );
      expect(rows.map((r) => [r.charity_id, r.percentage_bps]).sort()).toEqual(
        [
          [first, 1500],
          [second, 4000],
        ].sort(),
      );
    });
  });

  it('replaying a payment does not touch the stored snapshot (the recording function never updates it)', async () => {
    await asOwner(db, async (tx) => {
      const { user, a } = await paid(tx);
      await pay(tx, { ...a, bps: 9000, contribution: 900, charity: a.charity });
      expect(await contribution(tx, user)).toMatchObject({ percentage_bps: 1500 });
    });
  });
});

describe('payment history is APPEND-ONLY once money is collected (OWNER decision D-070)', () => {
  const failedArgs = (a: PayArgs): PayArgs => ({
    ...a,
    state: 'failed',
    paidAt: null,
    paymentIntent: null,
    charity: null,
    bps: null,
    basis: null,
    contribution: null,
  });
  async function payment(tx: Transaction, state: 'succeeded' | 'failed') {
    const user = await createUser(tx);
    const plan = await createPlan(tx, { active: false });
    const sub = await createSubscription(tx, user, plan);
    const charity = await createCharity(tx);
    const base = paidArgs(user, sub, charity);
    const a = state === 'succeeded' ? base : failedArgs(base);
    const { payment_id: id } = await pay(tx, a);
    return { id, user, sub, a, charity };
  }
  const row = async (tx: Transaction, id: string) =>
    (await tx.query<Record<string, unknown>>(`select * from public.payments where id = $1`, [id]))
      .rows[0];

  it('a SUCCEEDED payment\u2019s amount, date, intent and period can never change', async () => {
    await asOwner(db, async (tx) => {
      const { id } = await payment(tx, 'succeeded');
      const before = await row(tx, id);
      for (const set of [
        'amount_minor = 1',
        "paid_at = now() - interval '1 day'",
        "stripe_payment_intent_id = 'pi_other'",
        "period_end = period_end + interval '1 day'",
        "period_start = period_start - interval '1 day'",
      ]) {
        const err = await attempt(tx, () =>
          tx.query(`update public.payments set ${set} where id = $1`, [id]),
        );
        expect(err.code, set).toBe(PG.integrityViolation);
      }
      const after = await row(tx, id);
      expect([
        after?.amount_minor,
        after?.paid_at,
        after?.stripe_payment_intent_id,
        after?.period_start,
        after?.period_end,
      ]).toEqual([
        before?.amount_minor,
        before?.paid_at,
        before?.stripe_payment_intent_id,
        before?.period_start,
        before?.period_end,
      ]);
    });
  });

  it('who paid, the kind, the subscription, the currency and the invoice never change — in ANY state', async () => {
    await asOwner(db, async (tx) => {
      for (const state of ['succeeded', 'failed'] as const) {
        const { id, sub } = await payment(tx, state);
        const other = await createUser(tx);
        const otherSub = await createSubscription(
          tx,
          other,
          await createPlan(tx, { active: false }),
        );
        for (const set of [
          `user_id = '${other}'`,
          "kind = 'donation', subscription_id = null",
          `subscription_id = '${otherSub}'`,
          "currency = 'EUR'",
          "stripe_invoice_id = 'in_changed'",
        ]) {
          const err = await attempt(tx, () =>
            tx.query(`update public.payments set ${set} where id = $1`, [id]),
          );
          expect(err.code, `${state}: ${set}`).toBe(PG.integrityViolation);
        }
        void sub;
      }
    });
  });

  it('a succeeded payment cannot go back to pending or failed', async () => {
    await asOwner(db, async (tx) => {
      const { id } = await payment(tx, 'succeeded');
      for (const state of ['pending', 'failed']) {
        const err = await attempt(tx, () =>
          tx.query(`update public.payments set state = $2, paid_at = null where id = $1`, [
            id,
            state,
          ]),
        );
        expect(err.code, state).toBe(PG.integrityViolation);
      }
      expect((await row(tx, id))?.state).toBe('succeeded');
    });
  });

  it('a succeeded payment CAN become refunded (state only) — and the charity snapshot it produced is untouched', async () => {
    await asOwner(db, async (tx) => {
      const { id, user } = await payment(tx, 'succeeded');
      const contributionBefore = (
        await tx.query(`select * from public.charity_contributions where user_id = $1`, [user])
      ).rows;
      await tx.query(`update public.payments set state = 'refunded' where id = $1`, [id]);
      expect((await row(tx, id))?.state).toBe('refunded');
      expect(Number((await row(tx, id))?.amount_minor)).toBe(1000);
      expect(
        (await tx.query(`select * from public.charity_contributions where user_id = $1`, [user]))
          .rows,
      ).toEqual(contributionBefore);
    });
  });

  it('a refund still cannot rewrite the amount; a refunded payment is frozen', async () => {
    await asOwner(db, async (tx) => {
      const { id } = await payment(tx, 'succeeded');
      const err = await attempt(tx, () =>
        tx.query(`update public.payments set state = 'refunded', amount_minor = 1 where id = $1`, [
          id,
        ]),
      );
      expect(err.code).toBe(PG.integrityViolation);
      await tx.query(`update public.payments set state = 'refunded' where id = $1`, [id]);
      for (const set of [
        "state = 'succeeded'",
        "state = 'failed', paid_at = null",
        'amount_minor = 5',
      ]) {
        const frozen = await attempt(tx, () =>
          tx.query(`update public.payments set ${set} where id = $1`, [id]),
        );
        expect(frozen.code, set).toBe(PG.integrityViolation);
      }
    });
  });

  it('an attempt that has NOT succeeded may still evolve: a failed payment becomes the success when the invoice is paid', async () => {
    await asOwner(db, async (tx) => {
      const { id, a } = await payment(tx, 'failed');
      await pay(
        tx,
        paidArgs(a.user, a.subscription, a.charity ?? (await createCharity(tx)), {
          invoice: a.invoice,
        }),
      );
      expect((await row(tx, id))?.state).toBe('succeeded');
      expect(await counts(tx, a.user)).toEqual({ payments: 1, contributions: 1 });
    });
  });

  it('no payment can ever be deleted — succeeded or not', async () => {
    await asOwner(db, async (tx) => {
      for (const state of ['succeeded', 'failed'] as const) {
        const { id } = await payment(tx, state);
        const err = await attempt(tx, () =>
          tx.query(`delete from public.payments where id = $1`, [id]),
        );
        expect(err.code, state).toBe(PG.integrityViolation);
        expect(err.message).toMatch(/append-only/);
        expect(await row(tx, id)).toBeDefined();
      }
    });
  });

  it('the recording function never trips the guard (a replay of a succeeded payment is a no-op)', async () => {
    await asOwner(db, async (tx) => {
      const { a } = await payment(tx, 'succeeded');
      await expect(
        pay(tx, { ...a, amount: 9999, basis: 9999, contribution: 999 }),
      ).resolves.toMatchObject({ payment_created: false });
      expect(await counts(tx, a.user)).toEqual({ payments: 1, contributions: 1 });
    });
  });
});
