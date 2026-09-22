import type { PGlite, Transaction } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  asOwner,
  attempt,
  createMigratedDatabase,
  impersonate,
  PG,
  pgError,
  type Actor,
} from './support/database';
import {
  TEST_CURRENCY,
  addScore,
  createCharity,
  createDrawWithEntry,
  createPayment,
  createPlan,
  createSubscription,
  createUser,
} from './support/fixtures';

let db: PGlite;

// People
let alice: string; // active subscriber, entered a published draw and a simulated one
let bob: string; // registered, never subscribed, no draw entries
let carol: string; // lapsed subscriber who won a published draw and uploaded proof
let admin: string;

// Data
let publicCharity: string;
let archivedCharity: string;
let publishedDraw: string;
let simulatedDraw: string;
let carolWinner: string;
let alicePlan: string;

const anon: Actor = { role: 'anon' };
const asAlice = (): Actor => ({ role: 'authenticated', userId: alice });
const asBob = (): Actor => ({ role: 'authenticated', userId: bob });
const asCarol = (): Actor => ({ role: 'authenticated', userId: carol });
const asAdmin = (): Actor => ({ role: 'authenticated', userId: admin });
const asService: Actor = { role: 'service_role' };

async function count(actor: Actor, sql: string, params: unknown[] = []): Promise<number> {
  return as(
    db,
    actor,
    async (tx) =>
      (await tx.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params)).rows[0]
        ?.n ?? -1,
  );
}

beforeAll(async () => {
  db = await createMigratedDatabase();
  [alice, bob, carol] = [await createUser(db), await createUser(db), await createUser(db)];
  admin = await createUser(db, { admin: true });

  publicCharity = await createCharity(db, { name: 'Public Charity' });
  archivedCharity = await createCharity(db, { name: 'Archived Charity', archived: true });
  for (const c of [publicCharity, archivedCharity]) {
    await db.query(
      `insert into public.charity_images (charity_id, storage_path) values ($1, 'img.png')`,
      [c],
    );
    await db.query(
      `insert into public.charity_events (charity_id, title, starts_at) values ($1, 'Golf day', '2027-06-01T09:00Z')`,
      [c],
    );
  }

  alicePlan = await createPlan(db, { interval: 'month' });
  await createPlan(db, { interval: 'year', active: false });
  const aliceSub = await createSubscription(db, alice, alicePlan, 'active');
  await createSubscription(db, carol, alicePlan, 'lapsed');

  await addScore(db, alice, '2027-01-01', 30);
  await addScore(db, alice, '2027-01-02', 31);
  await addScore(db, bob, '2027-01-01', 20);

  const payment = await createPayment(db, alice, {
    kind: 'subscription',
    subscriptionId: aliceSub,
    amountMinor: 1000,
  });
  await db.query(
    `insert into public.charity_contributions (user_id, charity_id, payment_id, source, currency, amount_minor, basis_minor, percentage_bps)
     values ($1, $2, $3, 'subscription', $4, 100, 1000, 1000)`,
    [alice, publicCharity, payment, TEST_CURRENCY],
  );
  await createPayment(db, bob, { kind: 'donation', amountMinor: 700 });
  await db.query(
    `insert into public.billing_customers (user_id, stripe_customer_id) values ($1, 'cus_test_alice')`,
    [alice],
  );
  await db.query(
    `insert into public.stripe_events (id, type, livemode, payload) values ('evt_rls_1', 'invoice.paid', false, '{}')`,
  );
  await db.query(
    `insert into public.admin_audit_log (actor_id, action, entity_type) values ($1, 'test', 'test')`,
    [admin],
  );

  // Published draw: carol won (3 matches), alice took part with no matches.
  const published = await createDrawWithEntry(db, carol, { month: '2027-01-01' });
  await db.query(
    `insert into public.draw_entries (draw_id, user_id, entry_numbers, match_count) values ($1, $2, '{30,31}', 0)`,
    [published.drawId, alice],
  );
  await db.query(
    `update public.draws set status = 'published', published_at = now(), prize_pool_minor = 3000,
            active_subscriber_count = 3, currency = $2 where id = $1`,
    [published.drawId, TEST_CURRENCY],
  );
  const { rows } = await db.query<{ id: string }>(
    `insert into public.winners (draw_id, user_id, draw_entry_id, match_count, prize_minor, currency)
     values ($1, $2, $3, 3, 1000, $4) returning id`,
    [published.drawId, carol, published.entryId, TEST_CURRENCY],
  );
  publishedDraw = published.drawId;
  carolWinner = rows[0]?.id ?? '';
  await db.query(`insert into public.winner_proofs (winner_id, storage_path) values ($1, $2)`, [
    carolWinner,
    `${carolWinner}/proof.png`,
  ]);

  // Simulated (candidate) draw where alice's candidate result is a 5-match jackpot.
  const simulated = await createDrawWithEntry(db, alice, { month: '2027-02-01', matchCount: 5 });
  simulatedDraw = simulated.drawId;
});

describe('public visitor (anon)', () => {
  it('DIR-01/02, ROL-01: sees visible charities with their images and events — never archived ones', async () => {
    expect(await count(anon, `select id from public.charities`)).toBe(1);
    expect(
      await count(anon, `select id from public.charities where id = $1`, [archivedCharity]),
    ).toBe(0);
    expect(await count(anon, `select id from public.charity_images`)).toBe(1);
    expect(await count(anon, `select id from public.charity_events`)).toBe(1);
  });

  it('sees only the active plan and the public prize split', async () => {
    expect(await count(anon, `select id from public.plans`)).toBe(1);
    expect(await count(anon, `select match_count from public.prize_tiers`)).toBe(3);
  });

  it.each([
    'profiles',
    'scores',
    'subscriptions',
    'payments',
    'charity_contributions',
    'draws',
    'draw_entries',
    'draw_tier_results',
    'winners',
    'winner_proofs',
    'platform_settings',
    'admin_audit_log',
    'billing_customers',
    'stripe_events',
  ])('cannot read %s at all', async (table) => {
    const err = await as(db, anon, (tx) => pgError(tx.query(`select * from public.${table}`)));
    expect(err.code).toBe(PG.insufficientPrivilege);
  });

  it('cannot write anything, including public reference tables', async () => {
    for (const sql of [
      `insert into public.charities (slug, name, description) values ('x', 'x', 'x')`,
      `update public.charities set name = 'hacked'`,
      `delete from public.plans`,
      `insert into public.scores (user_id, played_on, stableford_score) values (gen_random_uuid(), '2027-01-01', 30)`,
    ]) {
      const err = await as(db, anon, (tx) => pgError(tx.query(sql)));
      expect(err.code, sql).toBe(PG.insufficientPrivilege);
    }
  });

  it('cannot call the admin/subscription helper functions', async () => {
    const err = await as(db, anon, (tx) => pgError(tx.query(`select public.is_admin()`)));
    expect(err.code).toBe(PG.insufficientPrivilege);
  });
});

describe('a signed-in user sees only their own private data (user isolation)', () => {
  it('profile: own row only', async () => {
    expect(await count(asAlice(), `select id from public.profiles`)).toBe(1);
    expect(await count(asAlice(), `select id from public.profiles where id = $1`, [bob])).toBe(0);
  });

  it("DSH-02, SCR-07: own scores, newest first; never another user's", async () => {
    const rows = await as(
      db,
      asAlice(),
      async (tx) =>
        (
          await tx.query<{ user_id: string }>(
            `select user_id from public.scores order by played_on desc`,
          )
        ).rows,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.user_id === alice)).toBe(true);
    expect(await count(asBob(), `select id from public.scores`)).toBe(1);
  });

  it('subscriptions, payments and contributions are private', async () => {
    expect(await count(asAlice(), `select id from public.subscriptions`)).toBe(1);
    expect(await count(asAlice(), `select id from public.payments`)).toBe(1);
    expect(await count(asAlice(), `select id from public.charity_contributions`)).toBe(1);
    // Bob has a donation payment but no subscription/contribution; he must not see Alice's.
    expect(await count(asBob(), `select id from public.subscriptions`)).toBe(0);
    expect(await count(asBob(), `select id from public.payments`)).toBe(1);
    expect(await count(asBob(), `select id from public.charity_contributions`)).toBe(0);
  });

  it('winnings and proof metadata belong to the winner alone', async () => {
    expect(await count(asCarol(), `select id from public.winners`)).toBe(1);
    expect(await count(asCarol(), `select id from public.winner_proofs`)).toBe(1);
    for (const other of [asAlice(), asBob()]) {
      expect(await count(other, `select id from public.winners`)).toBe(0);
      expect(await count(other, `select id from public.winner_proofs`)).toBe(0);
    }
  });

  it('service-only and admin-only tables return nothing / are denied to a normal user', async () => {
    expect(await count(asAlice(), `select 1 from public.platform_settings`)).toBe(0);
    expect(await count(asAlice(), `select 1 from public.admin_audit_log`)).toBe(0);
    for (const table of ['billing_customers', 'stripe_events']) {
      const err = await as(db, asAlice(), (tx) =>
        pgError(tx.query(`select * from public.${table}`)),
      );
      expect(err.code, table).toBe(PG.insufficientPrivilege);
    }
  });

  it('archived charities stay hidden from signed-in users too', async () => {
    expect(await count(asAlice(), `select id from public.charities`)).toBe(1);
    expect(await count(asAlice(), `select id from public.charity_events`)).toBe(1);
  });
});

describe('a signed-in user cannot write directly (writes go through the API)', () => {
  it('SCR-*: no direct insert, update or delete on scores', async () => {
    for (const sql of [
      `insert into public.scores (user_id, played_on, stableford_score) values ('${alice}', '2027-03-01', 30)`,
      `update public.scores set stableford_score = 45`,
      `delete from public.scores`,
    ]) {
      const err = await as(db, asAlice(), (tx) => pgError(tx.query(sql)));
      expect(err.code, sql).toBe(PG.insufficientPrivilege);
    }
  });

  it('cannot fabricate or alter subscriptions, payments, contributions, winners, draws or charities', async () => {
    for (const sql of [
      `insert into public.subscriptions (user_id, plan_id, status, current_period_end) values ('${alice}', '${alicePlan}', 'active', now() + interval '30 days')`,
      `update public.subscriptions set status = 'active'`,
      `insert into public.payments (user_id, kind, amount_minor, currency) values ('${alice}', 'donation', 100, 'XTS')`,
      `update public.charity_contributions set amount_minor = 1`,
      `update public.winners set payout_status = 'paid', paid_at = now()`,
      `update public.winners set prize_minor = 999999`,
      `update public.draws set winning_numbers = '{1,2,3,4,5}'`,
      `insert into public.draw_entries (draw_id, user_id, entry_numbers) values ('${publishedDraw}', '${alice}', '{1}')`,
      `update public.charities set name = 'hacked'`,
      `insert into public.winner_proofs (winner_id, storage_path) values ('${carolWinner}', '${carolWinner}/x.png')`,
      `update public.platform_settings set prize_pool_bps = 9999`,
      `insert into public.admin_audit_log (action, entity_type) values ('forged', 'x')`,
    ]) {
      const err = await as(db, asAlice(), (tx) => pgError(tx.query(sql)));
      expect(err.code, sql).toBe(PG.insufficientPrivilege);
    }
  });

  it('CHR-01/03: may edit their own display name, charity and percentage', async () => {
    await as(db, asAlice(), async (tx) => {
      const res = await tx.query(
        `update public.profiles set display_name = 'Alice', selected_charity_id = $1, charity_bps = 2500 where id = $2`,
        [publicCharity, alice],
      );
      expect(res.affectedRows).toBe(1);
      const { rows } = await tx.query<{ charity_bps: number }>(
        `select charity_bps from public.profiles`,
      );
      expect(rows[0]?.charity_bps).toBe(2500);
    });
  });

  it('CHR-02: still cannot set a percentage below the 10% minimum, even on their own profile', async () => {
    const err = await as(db, asAlice(), (tx) =>
      pgError(tx.query(`update public.profiles set charity_bps = 500 where id = $1`, [alice])),
    );
    expect(err.constraint).toBe('profiles_charity_bps_minimum');
  });

  it("cannot promote themselves to admin, or change another user's profile", async () => {
    const promote = await as(db, asAlice(), (tx) =>
      pgError(tx.query(`update public.profiles set role = 'admin' where id = $1`, [alice])),
    );
    expect(promote.code).toBe(PG.insufficientPrivilege);

    await as(db, asAlice(), async (tx) => {
      const res = await tx.query(
        `update public.profiles set display_name = 'pwned' where id = $1`,
        [bob],
      );
      expect(res.affectedRows).toBe(0); // the row is simply invisible to Alice
    });
    const { rows } = await db.query<{ display_name: string | null }>(
      `select display_name from public.profiles where id = $1`,
      [bob],
    );
    expect(rows[0]?.display_name).toBeNull();
  });

  it('a forged "admin" claim in the JWT is ignored — the role comes from the database', async () => {
    const forged: Actor = {
      role: 'authenticated',
      userId: bob,
      claims: { user_role: 'admin', app_metadata: { role: 'admin' }, is_admin: true },
    };
    expect(await count(forged, `select id from public.profiles`)).toBe(1);
    expect(await count(forged, `select id from public.scores`)).toBe(1);
    expect(await count(forged, `select 1 from public.admin_audit_log`)).toBe(0);
    const isAdmin = await as(
      db,
      forged,
      async (tx) => (await tx.query<{ ok: boolean }>(`select public.is_admin() as ok`)).rows[0]?.ok,
    );
    expect(isAdmin).toBe(false);
  });
});

describe('draws are gated by subscription or participation (restrictive default, D-030)', () => {
  it('an active subscriber sees published draws and their tier results — but not drafts or simulations', async () => {
    expect(await count(asAlice(), `select id from public.draws`)).toBe(1);
    expect(
      await count(asAlice(), `select id from public.draws where id = $1`, [simulatedDraw]),
    ).toBe(0);
    expect(await count(asAlice(), `select 1 from public.draw_tier_results`)).toBe(3);
    expect(
      await count(asAlice(), `select 1 from public.draw_tier_results where draw_id = $1`, [
        simulatedDraw,
      ]),
    ).toBe(0);
  });

  it('DSH-04: a user sees their own published entry, but never a candidate simulation result', async () => {
    expect(await count(asAlice(), `select id from public.draw_entries`)).toBe(1);
    // Alice\'s simulated 5-match jackpot must not leak before publishing.
    expect(
      await count(asAlice(), `select id from public.draw_entries where draw_id = $1`, [
        simulatedDraw,
      ]),
    ).toBe(0);
    expect(await count(asAlice(), `select 1 from public.draw_entries where match_count = 5`)).toBe(
      0,
    );
  });

  it('a registered non-subscriber who never took part sees no draw data', async () => {
    expect(await count(asBob(), `select id from public.draws`)).toBe(0);
    expect(await count(asBob(), `select 1 from public.draw_tier_results`)).toBe(0);
    expect(await count(asBob(), `select id from public.draw_entries`)).toBe(0);
  });

  it('a lapsed subscriber still sees the draw they took part in, and their own entry', async () => {
    expect(await count(asCarol(), `select id from public.draws`)).toBe(1);
    expect(await count(asCarol(), `select id from public.draw_entries`)).toBe(1);
  });

  it('SUB-05: access follows live subscription state on the very next query', async () => {
    await asOwner(db, async (tx) => {
      await impersonate(tx, asAlice());
      const seen = async () =>
        (
          await tx.query<{ n: number }>(
            `select count(*)::int as n from (select id from public.draws) q`,
          )
        ).rows[0]?.n;
      // Alice is entered in the published draw, so she keeps seeing it even after lapsing...
      expect(await seen()).toBe(1);
      await tx.exec('reset role');
      await tx.query(`update public.subscriptions set status = 'lapsed' where user_id = $1`, [
        alice,
      ]);
      await impersonate(tx, asAlice());
      expect(await seen()).toBe(1);
    });

    // ...but a lapsed user with NO participation loses access. Bob subscribes, then lapses.
    await asOwner(db, async (tx) => {
      const sub = await createSubscription(tx, bob, alicePlan, 'active');
      await impersonate(tx, asBob());
      const seen = async () =>
        (
          await tx.query<{ n: number }>(
            `select count(*)::int as n from (select id from public.draws) q`,
          )
        ).rows[0]?.n;
      expect(await seen()).toBe(1);
      await tx.exec('reset role');
      await tx.query(`update public.subscriptions set status = 'lapsed' where id = $1`, [sub]);
      await impersonate(tx, asBob());
      expect(await seen()).toBe(0);
    });
  });
});

describe('entitlement lookups cannot be used to probe other users', () => {
  it('a signed-in user cannot ask whether ANOTHER user is a subscriber (no RPC oracle)', async () => {
    const err = await as(db, asBob(), (tx) =>
      pgError(tx.query(`select public.is_active_subscriber($1)`, [alice])),
    );
    expect(err.code).toBe(PG.insufficientPrivilege);
  });

  it('a signed-in user can ask only about themselves', async () => {
    const own = (actor: Actor) =>
      as(
        db,
        actor,
        async (tx) =>
          (
            await tx.query<{ ok: boolean }>(
              `select public.current_user_is_active_subscriber() as ok`,
            )
          ).rows[0]?.ok,
      );
    expect(await own(asAlice())).toBe(true); // Alice has an active subscription
    expect(await own(asBob())).toBe(false); // Bob never subscribed
  });

  it('anonymous visitors cannot call either lookup', async () => {
    for (const sql of [
      `select public.is_active_subscriber(gen_random_uuid())`,
      `select public.current_user_is_active_subscriber()`,
    ]) {
      const err = await as(db, anon, (tx) => pgError(tx.query(sql)));
      expect(err.code, sql).toBe(PG.insufficientPrivilege);
    }
  });

  it('the API (service role) can look up any user by id', async () => {
    const ok = await as(
      db,
      asService,
      async (tx) =>
        (await tx.query<{ ok: boolean }>(`select public.is_active_subscriber($1) as ok`, [alice]))
          .rows[0]?.ok,
    );
    expect(ok).toBe(true);
  });
});

describe('administrator', () => {
  it('ADM-01..07: can read every user-facing table, including drafts, candidates and archived charities', async () => {
    expect(await count(asAdmin(), `select id from public.profiles`)).toBe(4);
    expect(await count(asAdmin(), `select id from public.scores`)).toBe(3);
    expect(await count(asAdmin(), `select id from public.subscriptions`)).toBe(2);
    expect(await count(asAdmin(), `select id from public.payments`)).toBe(2);
    expect(await count(asAdmin(), `select id from public.charity_contributions`)).toBe(1);
    expect(await count(asAdmin(), `select id from public.draws`)).toBe(2);
    expect(await count(asAdmin(), `select id from public.draw_entries`)).toBe(3);
    expect(await count(asAdmin(), `select id from public.winners`)).toBe(1);
    expect(await count(asAdmin(), `select id from public.winner_proofs`)).toBe(1);
    expect(await count(asAdmin(), `select id from public.charities`)).toBe(2);
    expect(await count(asAdmin(), `select id from public.plans`)).toBe(2);
    expect(await count(asAdmin(), `select 1 from public.platform_settings`)).toBe(1);
    expect(await count(asAdmin(), `select 1 from public.admin_audit_log`)).toBe(1);
  });

  it('is_admin() is true only for a database admin', async () => {
    const check = (actor: Actor) =>
      as(
        db,
        actor,
        async (tx) =>
          (await tx.query<{ ok: boolean }>(`select public.is_admin() as ok`)).rows[0]?.ok,
      );
    expect(await check(asAdmin())).toBe(true);
    expect(await check(asAlice())).toBe(false);
  });

  it('still has no direct write path: admin changes go through the API and are audited', async () => {
    for (const sql of [
      `update public.winners set payout_status = 'paid', paid_at = now()`,
      `insert into public.scores (user_id, played_on, stableford_score) values ('${bob}', '2027-05-01', 30)`,
      `update public.profiles set role = 'admin' where id = '${bob}'`,
      `update public.draws set mode = 'algorithmic'`,
    ]) {
      const err = await as(db, asAdmin(), (tx) => pgError(tx.query(sql)));
      expect(err.code, sql).toBe(PG.insufficientPrivilege);
    }
  });

  it('can still not read service-only tables directly', async () => {
    const err = await as(db, asAdmin(), (tx) =>
      pgError(tx.query(`select * from public.stripe_events`)),
    );
    expect(err.code).toBe(PG.insufficientPrivilege);
  });
});

describe('service role (the API server)', () => {
  it("Phase 2: the API's profile lookup returns the role and reflects a role change immediately", async () => {
    // The exact columns the API reads on every authenticated request (apps/api/src/auth/profiles.ts).
    const lookup = (tx: Transaction, id: string) =>
      tx.query<{ id: string; role: string; display_name: string | null }>(
        `select id, role, display_name from public.profiles where id = $1`,
        [id],
      );
    await as(db, asService, async (tx) => {
      expect((await lookup(tx, bob)).rows[0]).toMatchObject({ id: bob, role: 'user' });
      expect((await lookup(tx, admin)).rows[0]?.role).toBe('admin');
      expect((await lookup(tx, '00000000-0000-0000-0000-00000000dead')).rows).toHaveLength(0);

      await tx.query(`update public.profiles set role = 'admin' where id = $1`, [bob]);
      expect((await lookup(tx, bob)).rows[0]?.role).toBe('admin');
    });
  });

  it('sees everything, including service-only tables', async () => {
    expect(await count(asService, `select id from public.profiles`)).toBe(4);
    expect(await count(asService, `select 1 from public.stripe_events`)).toBe(1);
    expect(await count(asService, `select 1 from public.billing_customers`)).toBe(1);
    expect(await count(asService, `select id from public.draws`)).toBe(2);
  });

  it("can perform the API's writes, subject to the same constraints and guards", async () => {
    await as(db, asService, async (tx) => {
      await addScore(tx, bob, '2027-05-01', 33);
      const capped = await attempt(tx, async () => {
        for (let d = 2; d <= 6; d++) await addScore(tx, bob, `2027-05-0${String(d)}`);
      });
      expect(capped.constraint).toBe('scores_max_five_per_user');
    });
  });
});
