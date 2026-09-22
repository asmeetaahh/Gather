import type { PGlite, Transaction } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, attempt, createMigratedDatabase, PG, pgError } from './support/database';
import {
  TEST_CURRENCY,
  addScore,
  createCharity,
  createDrawWithEntry,
  createPayment,
  createPlan,
  createSubscription,
  createUser,
  uniq,
} from './support/fixtures';

let db: PGlite;
let user: string;
let otherUser: string;
let charity: string;

beforeAll(async () => {
  db = await createMigratedDatabase();
  user = await createUser(db);
  otherUser = await createUser(db);
  charity = await createCharity(db);
});

/** Runs one statement as the owner in a rolled-back transaction and returns its Postgres error. */
const fail = (sql: string, params: unknown[] = []) =>
  asOwner(db, (tx) => pgError(tx.query(sql, params)));

const insertScore = (userId: string, playedOn: string, value: number) =>
  fail(`insert into public.scores (user_id, played_on, stableford_score) values ($1, $2, $3)`, [
    userId,
    playedOn,
    value,
  ]);

describe('scores (PRD §05)', () => {
  it('SCR-02: accepts 1 and 45, rejects 0 and 46', async () => {
    await asOwner(db, async (tx) => {
      await addScore(tx, user, '2026-01-01', 1);
      await addScore(tx, user, '2026-01-02', 45);
    });
    for (const bad of [0, 46, -3]) {
      const err = await insertScore(user, '2026-01-03', bad);
      expect(err.code, String(bad)).toBe(PG.checkViolation);
      expect(err.constraint).toBe('scores_stableford_range');
    }
  });

  it('SCR-02: rejects fractional scores', async () => {
    const err = await fail(
      `insert into public.scores (user_id, played_on, stableford_score) values ($1, '2026-01-01', $2)`,
      [user, '30.5'],
    );
    expect(err.code).toBe('22P02');
  });

  it('SCR-03: a date is mandatory', async () => {
    const err = await fail(
      `insert into public.scores (user_id, stableford_score) values ($1, 30)`,
      [user],
    );
    expect(err.code).toBe(PG.notNullViolation);
  });

  it('SCR-04: one score per user per date; other users may share the date', async () => {
    await asOwner(db, async (tx) => {
      await addScore(tx, user, '2026-02-01');
      const dup = await pgError(addScore(tx, user, '2026-02-01'));
      expect(dup.code).toBe(PG.uniqueViolation);
    });
    await asOwner(db, async (tx) => {
      await addScore(tx, user, '2026-02-01');
      await addScore(tx, otherUser, '2026-02-01');
    });
  });

  it('SCR-05: a sixth score is rejected — and nothing is silently deleted', async () => {
    await asOwner(db, async (tx) => {
      for (let day = 1; day <= 5; day++) await addScore(tx, user, `2026-03-0${String(day)}`);
      const err = await attempt(tx, () => addScore(tx, user, '2026-03-06'));
      expect(err.code).toBe(PG.checkViolation);
      expect(err.constraint).toBe('scores_max_five_per_user');

      // The failed insert must not have evicted anything (eviction is domain logic, D-027).
      const { rows } = await tx.query<{ n: number }>(
        `select count(*)::int as n from public.scores where user_id = $1`,
        [user],
      );
      expect(rows[0]?.n).toBe(5);
    });
  });

  it('SCR-05/06: the cap is per user, and the domain can replace the oldest in one transaction', async () => {
    await asOwner(db, async (tx) => {
      for (let day = 1; day <= 5; day++) await addScore(tx, user, `2026-04-0${String(day)}`);
      // Another user is unaffected by user's full quota.
      await addScore(tx, otherUser, '2026-04-01');

      // Domain-layer eviction: delete the oldest, then insert the new score.
      await tx.query(
        `delete from public.scores
          where id = (select id from public.scores where user_id = $1 order by played_on asc limit 1)`,
        [user],
      );
      await addScore(tx, user, '2026-04-06');

      const { rows } = await tx.query<{ played_on: string }>(
        `select to_char(played_on, 'YYYY-MM-DD') as played_on
           from public.scores where user_id = $1 order by played_on desc`,
        [user],
      );
      // SCR-07: newest first.
      expect(rows.map((r) => r.played_on)).toEqual([
        '2026-04-06',
        '2026-04-05',
        '2026-04-04',
        '2026-04-03',
        '2026-04-02',
      ]);
    });
  });

  it('editing an existing score is allowed even at the cap', async () => {
    await asOwner(db, async (tx) => {
      for (let day = 1; day <= 5; day++) await addScore(tx, user, `2026-05-0${String(day)}`);
      const res = await tx.query(
        `update public.scores set stableford_score = 12, played_on = '2026-05-20'
          where user_id = $1 and played_on = '2026-05-01'`,
        [user],
      );
      expect(res.affectedRows).toBe(1);
    });
  });

  it("a score cannot be moved into another user's full quota", async () => {
    await asOwner(db, async (tx) => {
      for (let day = 1; day <= 5; day++) await addScore(tx, user, `2026-06-0${String(day)}`);
      const moving = await addScore(tx, otherUser, '2026-06-10');
      const err = await pgError(
        tx.query(`update public.scores set user_id = $1 where id = $2`, [user, moving]),
      );
      expect(err.constraint).toBe('scores_max_five_per_user');
    });
  });

  it('a score must belong to an existing profile', async () => {
    const err = await insertScore('00000000-0000-0000-0000-00000000dead', '2026-01-01', 30);
    expect(err.code).toBe(PG.foreignKeyViolation);
  });

  it('deleting the account removes its scores (personal data, not financial history)', async () => {
    await asOwner(db, async (tx) => {
      const doomed = await createUser(tx);
      await addScore(tx, doomed, '2026-01-01');
      await tx.query(`delete from auth.users where id = $1`, [doomed]);
      const { rows } = await tx.query<{ n: number }>(
        `select count(*)::int as n from public.scores where user_id = $1`,
        [doomed],
      );
      expect(rows[0]?.n).toBe(0);
    });
  });
});

describe('scores: the cap vs. application workflows (replace oldest, edit, retry)', () => {
  const NEW_DATE = '2026-07-06';
  const NEWEST_FIVE = ['2026-07-06', '2026-07-05', '2026-07-04', '2026-07-03', '2026-07-02'];

  /** Gives `user` five scores, 2026-07-01 … 2026-07-05, inside the transaction. */
  const fillToCap = async (tx: Transaction) => {
    for (let day = 1; day <= 5; day++) await addScore(tx, user, `2026-07-0${String(day)}`);
  };
  const oldestId = () =>
    `(select id from public.scores where user_id = '${user}' order by played_on asc limit 1)`;
  const datesOf = async (tx: Transaction) =>
    (
      await tx.query<{ d: string }>(
        `select to_char(played_on, 'YYYY-MM-DD') as d from public.scores
          where user_id = $1 order by played_on desc`,
        [user],
      )
    ).rows.map((r) => r.d);

  describe('replace-oldest can be implemented atomically in any of these ways (D-049)', () => {
    it('as one explicit transaction: delete the oldest, then insert', async () => {
      await asOwner(db, async (tx) => {
        await fillToCap(tx);
        await tx.query(`delete from public.scores where id = ${oldestId()}`);
        await addScore(tx, user, NEW_DATE);
        expect(await datesOf(tx)).toEqual(NEWEST_FIVE);
      });
    });

    it('as a single statement (data-modifying CTE)', async () => {
      await asOwner(db, async (tx) => {
        await fillToCap(tx);
        await tx.query(
          `with del as (delete from public.scores where id = ${oldestId()} returning 1)
           insert into public.scores (user_id, played_on, stableford_score)
           select $1::uuid, $2::date, 33 from (select count(*) from del) x`,
          [user, NEW_DATE],
        );
        expect(await datesOf(tx)).toEqual(NEWEST_FIVE);
      });
    });

    it('inside a Postgres function (the shape a Phase 2 RPC would take)', async () => {
      await asOwner(db, async (tx) => {
        await fillToCap(tx);
        await tx.exec(`
          create function pg_temp.replace_oldest(u uuid, d date, s smallint) returns void
          language plpgsql as $$
          begin
            delete from public.scores
             where id = (select id from public.scores where user_id = u order by played_on asc limit 1);
            insert into public.scores (user_id, played_on, stableford_score) values (u, d, s);
          end $$`);
        await tx.query(`select pg_temp.replace_oldest($1::uuid, $2::date, 33::smallint)`, [
          user,
          NEW_DATE,
        ]);
        expect(await datesOf(tx)).toEqual(NEWEST_FIVE);
      });
    });

    it('by overwriting the oldest row in place', async () => {
      await asOwner(db, async (tx) => {
        await fillToCap(tx);
        await tx.query(
          `update public.scores set played_on = $1, stableford_score = 33 where id = ${oldestId()}`,
          [NEW_DATE],
        );
        expect(await datesOf(tx)).toEqual(NEWEST_FIVE);
      });
    });

    it('but NOT by inserting first: the domain must delete before it inserts', async () => {
      await asOwner(db, async (tx) => {
        await fillToCap(tx);
        const err = await attempt(tx, () => addScore(tx, user, NEW_DATE));
        expect(err.constraint).toBe('scores_max_five_per_user');
      });
    });
  });

  describe('statements that add no row are never rejected by the cap', () => {
    it('SCR-08: an upsert that edits an existing date works at the cap', async () => {
      await asOwner(db, async (tx) => {
        await fillToCap(tx);
        const res = await tx.query(
          `insert into public.scores (user_id, played_on, stableford_score) values ($1, '2026-07-03', 44)
           on conflict (user_id, played_on) do update set stableford_score = excluded.stableford_score`,
          [user],
        );
        expect(res.affectedRows).toBe(1);
        expect(await datesOf(tx)).toHaveLength(5);
        const { rows } = await tx.query<{ stableford_score: number }>(
          `select stableford_score from public.scores where user_id = $1 and played_on = '2026-07-03'`,
          [user],
        );
        expect(rows[0]?.stableford_score).toBe(44);
      });
    });

    it('SCR-04: a duplicate date at the cap is reported as a duplicate, not as a cap error', async () => {
      await asOwner(db, async (tx) => {
        await fillToCap(tx);
        const err = await attempt(tx, () => addScore(tx, user, '2026-07-03'));
        expect(err.code).toBe(PG.uniqueViolation);
        expect(err.constraint).toBe('scores_one_per_user_per_date');
      });
    });

    it('ON CONFLICT DO NOTHING at the cap is a silent no-op, so retried requests are safe', async () => {
      await asOwner(db, async (tx) => {
        await fillToCap(tx);
        const res = await tx.query(
          `insert into public.scores (user_id, played_on, stableford_score) values ($1, '2026-07-03', 44)
           on conflict do nothing`,
          [user],
        );
        expect(res.affectedRows).toBe(0);
        expect(await datesOf(tx)).toHaveLength(5);
      });
    });
  });

  describe('the cap itself is not weakened by the above', () => {
    it('a single multi-row INSERT cannot exceed 5 scores', async () => {
      const insertDays = (tx: Transaction, count: number) =>
        tx.query(
          `insert into public.scores (user_id, played_on, stableford_score)
           select $1::uuid, date '2026-08-01' + g, 30 from generate_series(0, $2::int) g`,
          [user, count - 1],
        );
      await asOwner(db, (tx) => insertDays(tx, 5));
      const err = await asOwner(db, (tx) => pgError(insertDays(tx, 6)));
      expect(err.constraint).toBe('scores_max_five_per_user');
    });

    it("an upsert cannot smuggle a score into another user's full quota", async () => {
      await asOwner(db, async (tx) => {
        await fillToCap(tx);
        for (let day = 1; day <= 5; day++) await addScore(tx, otherUser, `2026-09-0${String(day)}`);
        const err = await attempt(tx, () =>
          tx.query(
            `insert into public.scores (user_id, played_on, stableford_score) values ($1, '2026-07-03', 10)
             on conflict (user_id, played_on) do update set user_id = $2`,
            [user, otherUser],
          ),
        );
        expect(err.constraint).toBe('scores_max_five_per_user');
      });
    });
  });
});

describe('profiles and account creation', () => {
  it('a new auth user gets a least-privilege profile with the 10% default share', async () => {
    const { rows } = await db.query<{
      role: string;
      charity_bps: number;
      selected_charity_id: null;
    }>(`select role, charity_bps, selected_charity_id from public.profiles where id = $1`, [user]);
    expect(rows[0]).toEqual({ role: 'user', charity_bps: 1000, selected_charity_id: null });
  });

  it('signup metadata can never grant admin', async () => {
    await asOwner(db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into auth.users (email, raw_user_meta_data, raw_app_meta_data)
         values ($1, '{"role":"admin"}', '{"role":"admin"}') returning id`,
        [`meta-${uniq()}@example.test`],
      );
      const id = rows[0]?.id;
      const profile = await tx.query<{ role: string }>(
        `select role from public.profiles where id = $1`,
        [id],
      );
      expect(profile.rows[0]?.role).toBe('user');
    });
  });

  it('CHR-02: the charity percentage cannot be below 10% or above 100%', async () => {
    const low = await fail(`update public.profiles set charity_bps = 999 where id = $1`, [user]);
    expect(low.constraint).toBe('profiles_charity_bps_minimum');
    const high = await fail(`update public.profiles set charity_bps = 10001 where id = $1`, [user]);
    expect(high.constraint).toBe('basis_points_range');
  });

  it('CHR-03: the percentage may be raised, up to 100%', async () => {
    await asOwner(db, async (tx) => {
      for (const bps of [1000, 1500, 10000]) {
        const res = await tx.query(`update public.profiles set charity_bps = $1 where id = $2`, [
          bps,
          user,
        ]);
        expect(res.affectedRows).toBe(1);
      }
    });
  });

  it('CHR-01: the selected charity must exist, and deleting a charity clears the selection', async () => {
    const missing = await fail(
      `update public.profiles set selected_charity_id = gen_random_uuid() where id = $1`,
      [user],
    );
    expect(missing.code).toBe(PG.foreignKeyViolation);

    await asOwner(db, async (tx) => {
      const temp = await createCharity(tx);
      await tx.query(`update public.profiles set selected_charity_id = $1 where id = $2`, [
        temp,
        user,
      ]);
      await tx.query(`delete from public.charities where id = $1`, [temp]);
      const { rows } = await tx.query<{ selected_charity_id: string | null }>(
        `select selected_charity_id from public.profiles where id = $1`,
        [user],
      );
      expect(rows[0]?.selected_charity_id).toBeNull();
    });
  });
});

describe('charity directory (PRD §08)', () => {
  it('slug must be lowercase url-safe; description is required', async () => {
    const badSlug = await fail(
      `insert into public.charities (slug, name, description) values ('Bad Slug', 'n', 'd')`,
    );
    expect(badSlug.constraint).toBe('charities_slug_format');
    const blank = await fail(
      `insert into public.charities (slug, name, description) values ('ok-slug', 'n', '   ')`,
    );
    expect(blank.constraint).toBe('charities_description_present');
  });

  it('DIR-01: directory search finds a charity by name or description', async () => {
    await asOwner(db, async (tx) => {
      await createCharity(tx, {
        name: 'Riverside Youth Fund',
        description: 'Coaching for young people.',
      });
      const byName = await tx.query(
        `select 1 from public.charities where search @@ to_tsquery('english', 'riverside')`,
      );
      const byDescription = await tx.query(
        `select 1 from public.charities where search @@ to_tsquery('english', 'coaching')`,
      );
      const nothing = await tx.query(
        `select 1 from public.charities where search @@ to_tsquery('english', 'zzzzqqq')`,
      );
      expect([byName.rows.length, byDescription.rows.length, nothing.rows.length]).toEqual([
        1, 1, 0,
      ]);
    });
  });

  it('DIR-02: an event cannot end before it starts', async () => {
    const err = await fail(
      `insert into public.charity_events (charity_id, title, starts_at, ends_at)
       values ($1, 'Golf day', '2026-10-02T10:00Z', '2026-10-02T09:00Z')`,
      [charity],
    );
    expect(err.constraint).toBe('charity_events_end_after_start');
  });

  it('a charity with contribution history cannot be hard-deleted (archive it instead)', async () => {
    await asOwner(db, async (tx) => {
      const c = await createCharity(tx);
      const payment = await createPayment(tx, user, { kind: 'donation', amountMinor: 500 });
      await tx.query(
        `insert into public.charity_contributions (user_id, charity_id, payment_id, source, currency, amount_minor)
         values ($1, $2, $3, 'donation', $4, 500)`,
        [user, c, payment, TEST_CURRENCY],
      );
      const err = await pgError(tx.query(`delete from public.charities where id = $1`, [c]));
      expect(err.code).toBe(PG.restrictViolation);
    });
  });
});

describe('plans and subscriptions (PRD §04)', () => {
  it('SUB-01: exactly one active plan per billing interval; retired plans may repeat', async () => {
    await asOwner(db, async (tx) => {
      await createPlan(tx, { interval: 'month' });
      await createPlan(tx, { interval: 'year' });
      const second = await pgError(createPlan(tx, { interval: 'month' }));
      expect(second.constraint).toBe('plans_one_active_per_interval');
    });
    await asOwner(db, async (tx) => {
      await createPlan(tx, { interval: 'month' });
      await createPlan(tx, { interval: 'month', active: false });
      await createPlan(tx, { interval: 'month', active: false });
    });
  });

  it('plan amounts must be positive integers with a well-formed currency', async () => {
    const zero = await fail(
      `insert into public.plans (name, billing_interval, amount_minor, currency) values ('p', 'month', 0, 'XTS')`,
    );
    expect(zero.constraint).toBe('plans_amount_positive');
    const lower = await fail(
      `insert into public.plans (name, billing_interval, amount_minor, currency) values ('p', 'month', 100, 'xts')`,
    );
    expect(lower.constraint).toBe('currency_code_format');
  });

  it('a user has at most one pending/active subscription, but history does not block a new one', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      await createSubscription(tx, user, plan, 'active');
      const second = await pgError(createSubscription(tx, user, plan, 'pending'));
      expect(second.constraint).toBe('subscriptions_one_current_per_user');
    });
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      await createSubscription(tx, user, plan, 'cancelled');
      await createSubscription(tx, user, plan, 'lapsed');
      await createSubscription(tx, user, plan, 'active');
    });
  });

  it('PRD §10: an active subscription must have a renewal (period end) date', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const err = await pgError(
        tx.query(
          `insert into public.subscriptions (user_id, plan_id, status) values ($1, $2, 'active')`,
          [user, plan],
        ),
      );
      expect(err.constraint).toBe('subscriptions_active_has_period_end');
    });
  });

  it('the period must end after it starts', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const err = await pgError(
        tx.query(
          `insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end)
           values ($1, $2, 'pending', '2026-02-01', '2026-01-01')`,
          [user, plan],
        ),
      );
      expect(err.constraint).toBe('subscriptions_period_order');
    });
  });

  it('is_active_subscriber reflects real subscription state on every call (SUB-05)', async () => {
    await asOwner(db, async (tx) => {
      const check = async () =>
        (await tx.query<{ ok: boolean }>(`select public.is_active_subscriber($1) as ok`, [user]))
          .rows[0]?.ok;
      expect(await check()).toBe(false);
      const plan = await createPlan(tx);
      const sub = await createSubscription(tx, user, plan, 'active');
      expect(await check()).toBe(true);
      await tx.query(`update public.subscriptions set status = 'lapsed' where id = $1`, [sub]);
      expect(await check()).toBe(false);
    });
  });
});

describe('payments and charity contributions (PRD §04, §08)', () => {
  it('a subscription payment needs a subscription; a donation must not have one', async () => {
    await asOwner(db, async (tx) => {
      const plan = await createPlan(tx);
      const sub = await createSubscription(tx, user, plan);
      const missing = await attempt(tx, () => createPayment(tx, user, { kind: 'subscription' }));
      expect(missing.constraint).toBe('payments_kind_matches_subscription');
      const extra = await attempt(tx, () =>
        createPayment(tx, user, { kind: 'donation', subscriptionId: sub }),
      );
      expect(extra.constraint).toBe('payments_kind_matches_subscription');
    });
  });

  it('payment amounts are positive and succeeded payments carry a paid_at', async () => {
    const zero = await fail(
      `insert into public.payments (user_id, kind, amount_minor, currency) values ($1, 'donation', 0, 'XTS')`,
      [user],
    );
    expect(zero.constraint).toBe('payments_amount_positive');
    const noTimestamp = await fail(
      `insert into public.payments (user_id, kind, amount_minor, currency, state)
       values ($1, 'donation', 100, 'XTS', 'succeeded')`,
      [user],
    );
    expect(noTimestamp.constraint).toBe('payments_paid_has_timestamp');
  });

  it('a Stripe payment intent id can only be recorded once', async () => {
    await asOwner(db, async (tx) => {
      const insert = () =>
        tx.query(
          `insert into public.payments (user_id, kind, amount_minor, currency, stripe_payment_intent_id)
           values ($1, 'donation', 100, 'XTS', 'pi_test_duplicate')`,
          [user],
        );
      await insert();
      expect((await pgError(insert())).code).toBe(PG.uniqueViolation);
    });
  });

  it('an account with payment history cannot be hard-deleted', async () => {
    await asOwner(db, async (tx) => {
      const payer = await createUser(tx);
      await createPayment(tx, payer);
      const err = await pgError(tx.query(`delete from auth.users where id = $1`, [payer]));
      expect(err.code).toBe(PG.restrictViolation);
    });
  });

  describe('contributions', () => {
    /** Creates a subscription payment of 1000 minor units and returns its id. */
    async function subscriptionPayment(tx: Parameters<typeof createPayment>[0]): Promise<string> {
      const plan = await createPlan(tx);
      const sub = await createSubscription(tx, user, plan);
      return createPayment(tx, user, {
        kind: 'subscription',
        subscriptionId: sub,
        amountMinor: 1000,
      });
    }

    const insertContribution = (
      tx: Parameters<typeof createPayment>[0],
      p: {
        payment: string;
        userId?: string;
        source?: string;
        currency?: string;
        amount?: number;
        basis?: number | null;
        bps?: number | null;
      },
    ) =>
      tx.query(
        `insert into public.charity_contributions
           (user_id, charity_id, payment_id, source, currency, amount_minor, basis_minor, percentage_bps)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          p.userId ?? user,
          charity,
          p.payment,
          p.source ?? 'subscription',
          p.currency ?? TEST_CURRENCY,
          p.amount ?? 100,
          p.basis === undefined ? 1000 : p.basis,
          p.bps === undefined ? 1000 : p.bps,
        ],
      );

    it('CHR-02: accepts a subscription contribution at exactly 10%', async () => {
      await asOwner(db, async (tx) => {
        await insertContribution(tx, { payment: await subscriptionPayment(tx) });
      });
    });

    it('CHR-02: rejects a recorded percentage below 10%', async () => {
      await asOwner(db, async (tx) => {
        const err = await pgError(
          insertContribution(tx, { payment: await subscriptionPayment(tx), bps: 999 }),
        );
        expect(err.constraint).toBe('charity_contributions_subscription_shape');
      });
    });

    it('rejects a contribution larger than the fee it was taken from, or without a basis', async () => {
      await asOwner(db, async (tx) => {
        const payment = await subscriptionPayment(tx);
        const tooBig = await pgError(
          insertContribution(tx, { payment, amount: 1001, basis: 1000 }),
        );
        expect(tooBig.constraint).toBe('charity_contributions_subscription_shape');
      });
      await asOwner(db, async (tx) => {
        const noBasis = await pgError(
          insertContribution(tx, { payment: await subscriptionPayment(tx), basis: null }),
        );
        expect(noBasis.constraint).toBe('charity_contributions_subscription_shape');
      });
    });

    it('CHR-04: a donation is a contribution with no percentage/basis', async () => {
      await asOwner(db, async (tx) => {
        const donation = await createPayment(tx, user, { kind: 'donation', amountMinor: 500 });
        await insertContribution(tx, {
          payment: donation,
          source: 'donation',
          amount: 500,
          basis: null,
          bps: null,
        });
      });
      await asOwner(db, async (tx) => {
        const donation = await createPayment(tx, user, { kind: 'donation', amountMinor: 500 });
        const err = await pgError(
          insertContribution(tx, {
            payment: donation,
            source: 'donation',
            amount: 500,
            basis: 500,
            bps: 1000,
          }),
        );
        expect(err.constraint).toBe('charity_contributions_donation_shape');
      });
    });

    it('must agree with its payment on owner, currency and kind', async () => {
      await asOwner(db, async (tx) => {
        const payment = await subscriptionPayment(tx);
        const wrongUser = await pgError(insertContribution(tx, { payment, userId: otherUser }));
        expect(wrongUser.constraint).toBe('charity_contributions_payment_fk');
      });
      await asOwner(db, async (tx) => {
        const payment = await subscriptionPayment(tx);
        const wrongCurrency = await pgError(insertContribution(tx, { payment, currency: 'EUR' }));
        expect(wrongCurrency.constraint).toBe('charity_contributions_payment_fk');
      });
      await asOwner(db, async (tx) => {
        const payment = await subscriptionPayment(tx);
        const wrongKind = await pgError(
          insertContribution(tx, { payment, source: 'donation', basis: null, bps: null }),
        );
        expect(wrongKind.constraint).toBe('charity_contributions_payment_fk');
      });
    });

    it('a payment yields at most one contribution', async () => {
      await asOwner(db, async (tx) => {
        const payment = await subscriptionPayment(tx);
        await insertContribution(tx, { payment });
        const again = await pgError(insertContribution(tx, { payment }));
        expect(again.code).toBe(PG.uniqueViolation);
      });
    });
  });
});

describe('draws (PRD §06, §07)', () => {
  const insertDraw = (columns: string, values: string) =>
    fail(`insert into public.draws (${columns}) values (${values})`);

  it('DRW-01: a draw belongs to one calendar month (first-of-month date), one draw per month', async () => {
    const mid = await insertDraw('draw_month, mode', `'2026-10-15', 'random'`);
    expect(mid.constraint).toBe('draws_month_is_first_of_month');
    await asOwner(db, async (tx) => {
      await tx.query(`insert into public.draws (draw_month, mode) values ('2026-10-01', 'random')`);
      const dup = await pgError(
        tx.query(
          `insert into public.draws (draw_month, mode) values ('2026-10-01', 'algorithmic')`,
        ),
      );
      expect(dup.constraint).toBe('draws_draw_month_key');
    });
  });

  it('DRW-04: mode is random or algorithmic only', async () => {
    const err = await insertDraw('draw_month, mode', `'2026-10-01', 'astrology'`);
    expect(err.code).toBe('22P02');
  });

  it('DRW-02 (derived): a stored draw has exactly 5 numbers, none null', async () => {
    for (const numbers of ['{1,2,3,4}', '{1,2,3,4,5,6}', '{1,2,3,4,NULL}']) {
      const err = await insertDraw(
        'draw_month, mode, winning_numbers',
        `'2026-10-01', 'random', '${numbers}'`,
      );
      expect(err.constraint, numbers).toBe('draws_numbers_shape');
    }
  });

  it('does NOT constrain what the PRD leaves open: number range and repeats (D-012)', async () => {
    await asOwner(db, async (tx) => {
      await tx.query(
        `insert into public.draws (draw_month, mode, winning_numbers) values ('2026-10-01', 'random', '{0,999,-5,7,7}')`,
      );
    });
  });

  it('a simulated draw has numbers; a published draw is complete', async () => {
    const noNumbers = await insertDraw(
      'draw_month, mode, status',
      `'2026-10-01', 'random', 'simulated'`,
    );
    expect(noNumbers.constraint).toBe('draws_numbers_present_once_simulated');

    const incomplete = await insertDraw(
      'draw_month, mode, status, winning_numbers, published_at',
      `'2026-10-01', 'random', 'published', '{1,2,3,4,5}', now()`,
    );
    expect(incomplete.constraint).toBe('draws_published_is_complete');

    const earlyStamp = await insertDraw(
      'draw_month, mode, published_at',
      `'2026-10-01', 'random', now()`,
    );
    expect(earlyStamp.constraint).toBe('draws_published_at_only_when_published');
  });

  it('a pool amount needs a currency', async () => {
    const err = await insertDraw(
      'draw_month, mode, prize_pool_minor',
      `'2026-10-01', 'random', 500`,
    );
    expect(err.constraint).toBe('draws_pool_has_currency');
  });

  describe('entries', () => {
    it('match count is 0-5; at most 5 numbers; one entry per user per draw', async () => {
      await asOwner(db, async (tx) => {
        const { drawId } = await createDrawWithEntry(tx, user, { month: '2026-11-01' });
        const bad = await attempt(tx, () =>
          tx.query(
            `insert into public.draw_entries (draw_id, user_id, entry_numbers, match_count) values ($1, $2, '{1}', 6)`,
            [drawId, otherUser],
          ),
        );
        expect(bad.constraint).toBe('draw_entries_match_count_range');

        const many = await attempt(tx, () =>
          tx.query(
            `insert into public.draw_entries (draw_id, user_id, entry_numbers) values ($1, $2, '{1,2,3,4,5,6}')`,
            [drawId, otherUser],
          ),
        );
        expect(many.constraint).toBe('draw_entries_numbers_shape');

        const dup = await attempt(tx, () =>
          tx.query(
            `insert into public.draw_entries (draw_id, user_id, entry_numbers) values ($1, $2, '{1}')`,
            [drawId, user],
          ),
        );
        expect(dup.constraint).toBe('draw_entries_one_per_user_per_draw');
      });
    });

    it('represents users with fewer than five numbers without deciding their eligibility (D-016)', async () => {
      await asOwner(db, async (tx) => {
        const { drawId } = await createDrawWithEntry(tx, user, { month: '2026-11-01' });
        for (const numbers of ['{}', '{7}', '{1,2,3,4}']) {
          const who = await createUser(tx);
          await tx.query(
            `insert into public.draw_entries (draw_id, user_id, entry_numbers) values ($1, $2, $3)`,
            [drawId, who, numbers],
          );
        }
      });
    });
  });

  describe('tier results', () => {
    const insertTier = (
      tx: Parameters<typeof createPayment>[0],
      drawId: string,
      p: {
        tier: number;
        share?: number;
        rolls?: boolean;
        pool?: number;
        rollIn?: number;
        winners?: number;
        prize?: number;
        remainder?: number;
        rollOut?: number;
      },
    ) =>
      tx.query(
        `insert into public.draw_tier_results
           (draw_id, match_count, share_bps, rolls_over, base_pool_minor, rollover_in_minor,
            winners_count, prize_per_winner_minor, remainder_minor, rollover_out_minor)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          drawId,
          p.tier,
          p.share ?? 1000,
          p.rolls ?? false,
          p.pool ?? 1000,
          p.rollIn ?? 0,
          p.winners ?? 0,
          p.prize ?? 0,
          p.remainder ?? 0,
          p.rollOut ?? 0,
        ],
      );

    async function emptyDraw(tx: Parameters<typeof createPayment>[0]): Promise<string> {
      const { rows } = await tx.query<{ id: string }>(
        `insert into public.draws (draw_month, mode, winning_numbers) values ('2026-12-01', 'random', '{1,2,3,4,5}') returning id`,
      );
      return rows[0]?.id ?? '';
    }

    it('DRW-06: only a rolling tier may carry money in or out', async () => {
      await asOwner(db, async (tx) => {
        const drawId = await emptyDraw(tx);
        const err = await pgError(insertTier(tx, drawId, { tier: 4, rolls: false, rollOut: 500 }));
        expect(err.constraint).toBe('draw_tier_results_rollover_only_if_tier_rolls');
      });
      await asOwner(db, async (tx) => {
        const drawId = await emptyDraw(tx);
        await insertTier(tx, drawId, { tier: 5, rolls: true, rollIn: 250, rollOut: 1250 });
      });
    });

    it('DRW-08: allocations (equal shares + remainder + rollover) can never exceed the pool', async () => {
      await asOwner(db, async (tx) => {
        const drawId = await emptyDraw(tx);
        const err = await pgError(
          insertTier(tx, drawId, { tier: 3, pool: 1000, winners: 3, prize: 334 }), // 1002 > 1000
        );
        expect(err.constraint).toBe('draw_tier_results_allocation_within_pool');
      });
      await asOwner(db, async (tx) => {
        const drawId = await emptyDraw(tx);
        // 3 winners x 333 + remainder 1 = 1000: fits exactly.
        await insertTier(tx, drawId, { tier: 3, pool: 1000, winners: 3, prize: 333, remainder: 1 });
      });
    });

    it('a tier with no winners has no per-winner prize', async () => {
      await asOwner(db, async (tx) => {
        const drawId = await emptyDraw(tx);
        const err = await pgError(insertTier(tx, drawId, { tier: 3, winners: 0, prize: 100 }));
        expect(err.constraint).toBe('draw_tier_results_no_winners_no_prize');
      });
    });

    it('DRW-03: only the 3, 4 and 5 match tiers exist', async () => {
      await asOwner(db, async (tx) => {
        const drawId = await emptyDraw(tx);
        const err = await pgError(insertTier(tx, drawId, { tier: 2 }));
        expect(err.code).toBe(PG.foreignKeyViolation);
      });
    });
  });
});

describe('winners, verification and payout (PRD §09)', () => {
  it('a user wins at most once per draw and only in the tier they matched', async () => {
    await asOwner(db, async (tx) => {
      const { drawId, entryId } = await createDrawWithEntry(tx, user, {
        month: '2027-01-01',
        publish: true,
      });
      const dup = await pgError(
        tx.query(
          `insert into public.winners (draw_id, user_id, draw_entry_id, match_count, prize_minor, currency)
           values ($1, $2, $3, 3, 1000, $4)`,
          [drawId, user, entryId, TEST_CURRENCY],
        ),
      );
      expect(dup.code).toBe(PG.uniqueViolation);
    });
    await asOwner(db, async (tx) => {
      // Entry matched 3 numbers; claiming the 4-match tier must be impossible.
      const { drawId, entryId } = await createDrawWithEntry(tx, user, { month: '2027-01-01' });
      await tx.query(
        `update public.draws set status='published', published_at=now(), prize_pool_minor=3000, active_subscriber_count=3, currency=$2 where id=$1`,
        [drawId, TEST_CURRENCY],
      );
      const err = await pgError(
        tx.query(
          `insert into public.winners (draw_id, user_id, draw_entry_id, match_count, prize_minor, currency)
           values ($1, $2, $3, 4, 1000, $4)`,
          [drawId, user, entryId, TEST_CURRENCY],
        ),
      );
      expect(err.constraint).toBe('winners_entry_fk');
    });
  });

  it("a winner's currency must match the draw's currency", async () => {
    await asOwner(db, async (tx) => {
      const { drawId, entryId } = await createDrawWithEntry(tx, user, { month: '2027-01-01' });
      await tx.query(
        `update public.draws set status='published', published_at=now(), prize_pool_minor=3000, active_subscriber_count=3, currency=$2 where id=$1`,
        [drawId, TEST_CURRENCY],
      );
      const err = await pgError(
        tx.query(
          `insert into public.winners (draw_id, user_id, draw_entry_id, match_count, prize_minor, currency)
           values ($1, $2, $3, 3, 1000, 'EUR')`,
          [drawId, user, entryId],
        ),
      );
      expect(err.constraint).toBe('winners_draw_currency_fk');
    });
  });

  it('DRW-12: paid requires a paid_at, and approval/rejection requires a review time', async () => {
    await asOwner(db, async (tx) => {
      const { winnerId } = await createDrawWithEntry(tx, user, {
        month: '2027-01-01',
        publish: true,
      });
      const paid = await pgError(
        tx.query(`update public.winners set payout_status = 'paid' where id = $1`, [winnerId]),
      );
      expect(paid.constraint).toBe('winners_paid_timestamp');
    });
    await asOwner(db, async (tx) => {
      const { winnerId } = await createDrawWithEntry(tx, user, {
        month: '2027-01-01',
        publish: true,
      });
      const approved = await pgError(
        tx.query(`update public.winners set verification_status = 'approved' where id = $1`, [
          winnerId,
        ]),
      );
      expect(approved.constraint).toBe('winners_review_timestamp');
    });
  });

  it('a new winner starts as awaiting proof and payout pending', async () => {
    await asOwner(db, async (tx) => {
      const { winnerId } = await createDrawWithEntry(tx, user, {
        month: '2027-01-01',
        publish: true,
      });
      const { rows } = await tx.query<{ verification_status: string; payout_status: string }>(
        `select verification_status, payout_status from public.winners where id = $1`,
        [winnerId],
      );
      expect(rows[0]).toEqual({ verification_status: 'awaiting_proof', payout_status: 'pending' });
    });
  });

  it("proof files must live under their winner's folder", async () => {
    await asOwner(db, async (tx) => {
      const { winnerId } = await createDrawWithEntry(tx, user, {
        month: '2027-01-01',
        publish: true,
      });
      const wrong = await attempt(tx, () =>
        tx.query(
          `insert into public.winner_proofs (winner_id, storage_path) values ($1, 'someone-else/proof.png')`,
          [winnerId],
        ),
      );
      expect(wrong.constraint).toBe('winner_proofs_path_under_winner');
      await tx.query(`insert into public.winner_proofs (winner_id, storage_path) values ($1, $2)`, [
        winnerId,
        `${winnerId}/proof.png`,
      ]);
      const dup = await pgError(
        tx.query(`insert into public.winner_proofs (winner_id, storage_path) values ($1, $2)`, [
          winnerId,
          `${winnerId}/proof.png`,
        ]),
      );
      expect(dup.code).toBe(PG.uniqueViolation);
    });
  });
});

describe('Stripe webhook ledger (idempotency)', () => {
  it('an event id can be recorded once; a replay is detected via ON CONFLICT DO NOTHING', async () => {
    await asOwner(db, async (tx) => {
      const insert = () =>
        tx.query(
          `insert into public.stripe_events (id, type, livemode, payload)
           values ('evt_test_1', 'invoice.paid', false, '{}') on conflict (id) do nothing`,
        );
      expect((await insert()).affectedRows).toBe(1);
      expect((await insert()).affectedRows).toBe(0);
    });
  });

  it('a processed event must carry a processed_at, and vice versa', async () => {
    const err = await fail(
      `insert into public.stripe_events (id, type, livemode, payload, status) values ('evt_x', 't', false, '{}', 'processed')`,
    );
    expect(err.constraint).toBe('stripe_events_processed_matches_status');
  });
});

describe('platform settings (open decisions stay configurable)', () => {
  it('the prize pool portion is a percentage OR a fixed amount, never both', async () => {
    const err = await fail(
      `update public.platform_settings set prize_pool_bps = 2000, prize_pool_per_subscription_minor = 100`,
    );
    expect(err.constraint).toBe('platform_settings_pool_shape');
  });

  it('the draw number range needs both ends, in order', async () => {
    // D-012/D-071 (owner decision, 2026-09-22): the range is now decided and seeded (1-45, migration
    // …150000), so the CHECK is exercised from that baseline rather than from both ends unset.
    const half = await fail(`update public.platform_settings set draw_number_max = null`);
    expect(half.constraint).toBe('platform_settings_number_range');
    const reversed = await fail(
      `update public.platform_settings set draw_number_min = 45, draw_number_max = 1`,
    );
    expect(reversed.constraint).toBe('platform_settings_number_range');
  });

  it('a charity percentage cap cannot be below the PRD minimum of 10%', async () => {
    const err = await fail(`update public.platform_settings set charity_max_bps = 500`);
    expect(err.constraint).toBe('platform_settings_charity_max');
  });
});
