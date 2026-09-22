import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { DB_ENUMS, PRIZE_TIERS, STORAGE_BUCKETS } from '@gather/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMigratedDatabase, migrationFiles, pgError } from './support/database';

let db: PGlite;

beforeAll(async () => {
  db = await createMigratedDatabase();
});

const EXPECTED_TABLES = [
  'admin_audit_log',
  'billing_customers',
  'charities',
  'charity_contributions',
  'charity_events',
  'charity_images',
  'draw_entries',
  'draw_tier_results',
  'draws',
  'payments',
  'plans',
  'prize_tiers',
  'platform_settings',
  'profiles',
  'scores',
  'stripe_events',
  'subscriptions',
  'winner_proofs',
  'winners',
].sort();

describe('migrations', () => {
  it('apply cleanly, in order, to an empty database', async () => {
    expect(migrationFiles().length).toBeGreaterThan(0);
    const { rows } = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES);
  });

  it('are named with strictly increasing timestamps', () => {
    const files = migrationFiles();
    expect(files.every((f) => /^\d{14}_[a-z0-9_]+\.sql$/.test(f))).toBe(true);
    expect(new Set(files.map((f) => f.slice(0, 14))).size).toBe(files.length);
  });
});

describe('row level security is on by default', () => {
  it('every public table has RLS enabled', async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' order by 1`,
    );
    const withoutRls = rows.filter((r) => !r.relrowsecurity).map((r) => r.relname);
    expect(withoutRls).toEqual([]);
  });

  it('storage.objects has RLS enabled', async () => {
    const { rows } = await db.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'storage.objects'::regclass`,
    );
    expect(rows[0]?.relrowsecurity).toBe(true);
  });
});

describe('privileges granted to the browser-facing roles', () => {
  interface Grant {
    t: string;
    role: string;
    priv: string;
  }

  async function tableGrants(): Promise<Grant[]> {
    const { rows } = await db.query<Grant>(
      `select c.relname as t, r.rolname as role, p.priv
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public' and c.relkind = 'r'
         cross join (values ('anon'), ('authenticated')) r(rolname)
         cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
                            ('REFERENCES'), ('TRIGGER')) p(priv)
        where has_table_privilege(r.rolname, c.oid, p.priv)
        order by 1, 2, 3`,
    );
    return rows;
  }

  const PUBLIC_READ = ['charities', 'charity_events', 'charity_images', 'plans', 'prize_tiers'];
  const AUTHENTICATED_READ = [
    ...PUBLIC_READ,
    'admin_audit_log',
    'charity_contributions',
    'draw_entries',
    'draw_tier_results',
    'draws',
    'payments',
    'platform_settings',
    'profiles',
    'scores',
    'subscriptions',
    'winner_proofs',
    'winners',
  ].sort();

  it('anon can only SELECT public reference data — nothing else, ever', async () => {
    const anon = (await tableGrants()).filter((g) => g.role === 'anon');
    expect(anon.every((g) => g.priv === 'SELECT')).toBe(true);
    expect(anon.map((g) => g.t).sort()).toEqual([...PUBLIC_READ].sort());
  });

  it('authenticated can only SELECT (no table-level write) on exactly the intended tables', async () => {
    const authed = (await tableGrants()).filter((g) => g.role === 'authenticated');
    expect(authed.every((g) => g.priv === 'SELECT')).toBe(true);
    expect(authed.map((g) => g.t).sort()).toEqual(AUTHENTICATED_READ);
  });

  it('service-only tables are unreachable to anon and authenticated', async () => {
    const granted = new Set((await tableGrants()).map((g) => g.t));
    expect(granted.has('billing_customers')).toBe(false);
    expect(granted.has('stripe_events')).toBe(false);
  });

  it('the only column a browser role can write are three profile preferences', async () => {
    const { rows } = await db.query<{ t: string; col: string; role: string; priv: string }>(
      `select c.relname as t, a.attname as col, r.rolname as role, p.priv
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid and c.relkind = 'r'
         join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
         cross join (values ('anon'), ('authenticated')) r(rolname)
         cross join (values ('INSERT'), ('UPDATE')) p(priv)
        where a.attnum > 0 and not a.attisdropped
          and has_column_privilege(r.rolname, c.oid, a.attnum, p.priv)
        order by 1, 2`,
    );
    expect(rows.map((r) => `${r.role}:${r.priv}:${r.t}.${r.col}`)).toEqual([
      'authenticated:UPDATE:profiles.charity_bps',
      'authenticated:UPDATE:profiles.display_name',
      'authenticated:UPDATE:profiles.selected_charity_id',
    ]);
  });

  it('the admin role column is not writable by users (no self-promotion)', async () => {
    const { rows } = await db.query<{ ok: boolean }>(
      `select has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE') as ok`,
    );
    expect(rows[0]?.ok).toBe(false);
  });
});

describe('SECURITY DEFINER functions are hardened', () => {
  interface Fn {
    proname: string;
    proconfig: string[] | null;
    anon_exec: boolean;
    public_exec: boolean;
  }

  it('pin search_path and are not executable by anon/public', async () => {
    const { rows } = await db.query<Fn>(
      `select p.proname, p.proconfig,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
              has_function_privilege('public', p.oid, 'EXECUTE') as public_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef order by 1`,
    );
    expect(rows.map((r) => r.proname)).toEqual([
      'current_user_is_active_subscriber',
      'draw_is_published',
      'enforce_score_cap',
      'enforce_selectable_charity',
      'handle_new_user',
      'is_active_subscriber',
      'is_admin',
    ]);
    for (const fn of rows) {
      expect(
        fn.proconfig?.some((c) => c.startsWith('search_path=')),
        fn.proname,
      ).toBe(true);
      expect(fn.anon_exec, `${fn.proname} anon`).toBe(false);
      expect(fn.public_exec, `${fn.proname} public`).toBe(false);
    }
  });

  it('browser roles can execute only the documented helper functions (RPC surface)', async () => {
    // PostgREST exposes every executable public function as /rpc/*. A SECURITY DEFINER function
    // that takes an arbitrary user id would let one user probe another (bypassing RLS), so the
    // allow-list is exact: any new helper must be reviewed and added here deliberately.
    const executableBy = async (role: string) =>
      (
        await db.query<{ proname: string }>(
          `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
              and has_function_privilege($1, p.oid, 'EXECUTE') order by 1`,
          [role],
        )
      ).rows.map((r) => r.proname);

    expect(await executableBy('anon')).toEqual([]);
    expect(await executableBy('authenticated')).toEqual([
      'current_user_is_active_subscriber',
      'draw_is_published',
      'is_admin',
    ]);
  });
});

describe('money and percentages (D-003)', () => {
  interface Column {
    table_name: string;
    column_name: string;
    data_type: string;
    domain_name: string | null;
  }
  let columns: Column[];

  beforeAll(async () => {
    const { rows } = await db.query<Column>(
      `select table_name, column_name, data_type, domain_name
         from information_schema.columns where table_schema = 'public'`,
    );
    columns = rows;
  });

  it('no floating-point, numeric or money column exists anywhere', () => {
    const bad = columns.filter((c) =>
      ['real', 'double precision', 'numeric', 'money'].includes(c.data_type),
    );
    expect(bad).toEqual([]);
  });

  it('every *_minor column is an integer minor-units domain (bigint, non-negative)', () => {
    const minor = columns.filter((c) => c.column_name.endsWith('_minor'));
    expect(minor.length).toBeGreaterThan(0);
    for (const c of minor) {
      expect(c.data_type, `${c.table_name}.${c.column_name}`).toBe('bigint');
      expect(c.domain_name, `${c.table_name}.${c.column_name}`).toBe('minor_units');
    }
  });

  it('every *_bps column is an integer basis-points domain', () => {
    const bps = columns.filter((c) => c.column_name.endsWith('_bps'));
    expect(bps.length).toBeGreaterThan(0);
    for (const c of bps) {
      expect(c.data_type, `${c.table_name}.${c.column_name}`).toBe('integer');
      expect(c.domain_name, `${c.table_name}.${c.column_name}`).toBe('basis_points');
    }
  });

  it('every currency column uses the currency_code domain', () => {
    for (const c of columns.filter((col) => col.column_name === 'currency')) {
      expect(c.domain_name, c.table_name).toBe('currency_code');
    }
  });

  it('every table holding money stores a currency (or documents why not)', () => {
    // draw_tier_results inherits its currency from draws; platform_settings is configuration.
    const documentedExceptions = ['draw_tier_results', 'platform_settings'];
    const moneyTables = new Set(
      columns.filter((c) => c.column_name.endsWith('_minor')).map((c) => c.table_name),
    );
    for (const table of moneyTables) {
      if (documentedExceptions.includes(table)) continue;
      const hasCurrency = columns.some(
        (c) => c.table_name === table && c.column_name === 'currency',
      );
      expect(hasCurrency, `${table} has *_minor columns but no currency`).toBe(true);
    }
  });

  it('rejects fractional amounts and negative amounts', async () => {
    const fractional = await pgError(
      db.query(
        `insert into public.plans (name, billing_interval, amount_minor, currency)
                values ('x', 'month', $1, 'XTS')`,
        ['10.5'],
      ),
    );
    expect(fractional.code).toBe('22P02'); // invalid_text_representation

    const negative = await pgError(
      db.query(`insert into public.plans (name, billing_interval, amount_minor, currency)
                values ('x', 'month', -1, 'XTS')`),
    );
    expect(negative.code).toBe('23514');
  });

  it('every timestamp is timestamptz (stored consistently as UTC instants)', () => {
    expect(columns.filter((c) => c.data_type === 'timestamp without time zone')).toEqual([]);
  });
});

describe('enums stay in sync with @gather/shared', () => {
  it('every public enum is mirrored with identical values in the same order', async () => {
    const { rows } = await db.query<{ typname: string; labels: string[] }>(
      `select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels
         from pg_type t
         join pg_enum e on e.enumtypid = t.oid
         join pg_namespace n on n.oid = t.typnamespace and n.nspname = 'public'
        group by t.typname order by 1`,
    );
    const actual = Object.fromEntries(rows.map((r) => [r.typname, r.labels]));
    const expected = Object.fromEntries(Object.entries(DB_ENUMS).map(([k, v]) => [k, [...v]]));
    expect(actual).toEqual(expected);
  });
});

describe('reference data defined by the PRD', () => {
  it('DRW-09 / DRW-06: prize tiers are seeded as 40/35/25 with only 5-match rolling over', async () => {
    const { rows } = await db.query<{
      match_count: number;
      share_bps: number;
      rolls_over: boolean;
    }>(
      `select match_count, share_bps, rolls_over from public.prize_tiers order by match_count desc`,
    );
    expect(rows).toEqual(
      PRIZE_TIERS.map((t) => ({
        match_count: t.matchCount,
        share_bps: t.shareBps,
        rolls_over: t.rollsOver,
      })),
    );
    expect(rows.reduce((sum, r) => sum + r.share_bps, 0)).toBe(10_000);
  });

  it('platform_settings has exactly one row; still-undecided values are NULL', async () => {
    const { rows } = await db.query<Record<string, unknown>>(
      `select * from public.platform_settings`,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0] ?? {};
    // D-012/D-071 (owner decision, 2026-09-22): the draw number range is now decided (1-45, mirroring
    // the score range) and seeded by migration …150000 — everything else stays undecided.
    for (const key of ['prize_pool_bps', 'prize_pool_per_subscription_minor', 'charity_max_bps']) {
      expect(row[key], key).toBeNull();
    }
    expect(row.draw_number_min).toBe(1);
    expect(row.draw_number_max).toBe(45);
    const second = await pgError(
      db.query(`insert into public.platform_settings (id) values (false)`),
    );
    expect(second.code).toBe('23514');
  });

  it('no plans are pre-created: prices are an open decision (D-024)', async () => {
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from public.plans`);
    expect(rows[0]?.n).toBe(0);
  });
});

describe('storage buckets', () => {
  it('winner proof is private; charity media is public; both restrict file types', async () => {
    const { rows } = await db.query<{
      id: string;
      public: boolean;
      file_size_limit: string | null;
      allowed_mime_types: string[] | null;
    }>(`select id, public, file_size_limit, allowed_mime_types from storage.buckets order by id`);

    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[STORAGE_BUCKETS.winnerProofs]?.public).toBe(false);
    expect(byId[STORAGE_BUCKETS.charityMedia]?.public).toBe(true);
    for (const bucket of rows) {
      expect(
        bucket.allowed_mime_types?.every((m) => m.startsWith('image/')),
        bucket.id,
      ).toBe(true);
      expect(bucket.file_size_limit, bucket.id).not.toBeNull();
    }
  });
});

describe('development seed (supabase/seed.sql)', () => {
  it('applies cleanly on top of the migrations and is idempotent', async () => {
    const seed = readFileSync(join(import.meta.dirname, '..', 'seed.sql'), 'utf8');
    const fresh = await createMigratedDatabase();
    await fresh.exec(seed);
    await fresh.exec(seed);

    const charities = await fresh.query<{ n: number; featured: number }>(
      `select count(*)::int as n, count(*) filter (where is_featured)::int as featured from public.charities`,
    );
    expect(charities.rows[0]).toEqual({ n: 3, featured: 1 });
    const events = await fresh.query<{ n: number }>(
      `select count(*)::int as n from public.charity_events where starts_at > now()`,
    );
    expect(events.rows[0]?.n).toBe(3);
  });

  it('seeds no plans, users, payments or draws (prices/currency are undecided)', async () => {
    const seed = readFileSync(join(import.meta.dirname, '..', 'seed.sql'), 'utf8');
    const fresh = await createMigratedDatabase();
    await fresh.exec(seed);
    for (const table of ['plans', 'profiles', 'payments', 'subscriptions', 'draws', 'winners']) {
      const { rows } = await fresh.query<{ n: number }>(
        `select count(*)::int as n from public.${table}`,
      );
      expect(rows[0]?.n, table).toBe(0);
    }
  });
});
