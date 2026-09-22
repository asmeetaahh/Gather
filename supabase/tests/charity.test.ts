import type { PGlite, Transaction } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { SIGNUP_CHARITY_METADATA_KEY } from '@gather/shared';
import {
  as,
  asOwner,
  attempt,
  createMigratedDatabase,
  PG,
  pgError,
  type Actor,
} from './support/database';
import { createUser, uniq } from './support/fixtures';

/**
 * Charity domain (PRD §08, DECISIONS D-064/D-065): the selection guard, and the database behaviour the API's
 * directory queries rely on (full-text prefix search, tag containment, featured flag, visibility).
 */

let db: PGlite;
let alice: string;
let bob: string;

beforeAll(async () => {
  db = await createMigratedDatabase();
  alice = await createUser(db);
  bob = await createUser(db);
});

const asAlice = (): Actor => ({ role: 'authenticated', userId: alice });

interface CharitySeed {
  name: string;
  description?: string;
  tags?: string[];
  featured?: boolean;
  archived?: boolean;
}

async function charity(tx: Transaction, c: CharitySeed): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `insert into public.charities (slug, name, description, tags, is_featured, archived_at)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      `c-${uniq()}`,
      c.name,
      c.description ?? 'A charity description.',
      c.tags ?? [],
      c.featured ?? false,
      c.archived ? new Date().toISOString() : null,
    ],
  );
  return rows[0]?.id ?? '';
}

const select = (tx: Transaction, userId: string, charityId: string | null) =>
  tx.query(`update public.profiles set selected_charity_id = $1 where id = $2`, [
    charityId,
    userId,
  ]);

describe('selecting a charity (CHR-01) — the guard (migration …120000)', () => {
  it('accepts a listed charity, and clearing the selection', async () => {
    await asOwner(db, async (tx) => {
      const c = await charity(tx, { name: 'Listed' });
      expect((await select(tx, alice, c)).affectedRows).toBe(1);
      expect((await select(tx, alice, null)).affectedRows).toBe(1);
    });
  });

  it('rejects an ARCHIVED charity with the custom GS002 error, for the owner role', async () => {
    await asOwner(db, async (tx) => {
      const archived = await charity(tx, { name: 'Gone', archived: true });
      const err = await pgError(select(tx, alice, archived));
      expect(err.code).toBe('GS002');
    });
  });

  it('rejects a non-existent charity through the foreign key (23503), not the guard', async () => {
    await asOwner(db, async (tx) => {
      const err = await pgError(select(tx, alice, '00000000-0000-0000-0000-00000000dead'));
      expect(err.code).toBe(PG.foreignKeyViolation);
    });
  });

  it('a charity archived AFTER it was selected does not block editing the percentage or picking another charity', async () => {
    await asOwner(db, async (tx) => {
      const first = await charity(tx, { name: 'First' });
      const second = await charity(tx, { name: 'Second' });
      await select(tx, alice, first);
      await tx.query(`update public.charities set archived_at = now() where id = $1`, [first]);

      // unrelated update of the same row works
      expect(
        (await tx.query(`update public.profiles set charity_bps = 2000 where id = $1`, [alice]))
          .affectedRows,
      ).toBe(1);
      // re-saving the SAME (now archived) selection is not a change, so it is not blocked
      expect((await select(tx, alice, first)).affectedRows).toBe(1);
      // moving to a listed charity works
      expect((await select(tx, alice, second)).affectedRows).toBe(1);
    });
  });

  it('cannot move from one charity to a different ARCHIVED one', async () => {
    await asOwner(db, async (tx) => {
      const listed = await charity(tx, { name: 'Listed' });
      const archived = await charity(tx, { name: 'Gone', archived: true });
      await select(tx, alice, listed);
      const err = await attempt(tx, () => select(tx, alice, archived));
      expect(err.code).toBe('GS002');
    });
  });
});

describe('the selection guard on the direct browser path (committed data, real RLS)', () => {
  let listed: string;
  let archived: string;

  beforeAll(async () => {
    // committed fixtures (as() runs in its own transaction and would not see uncommitted rows)
    const a = await db.query<{ id: string }>(
      `insert into public.charities (slug, name, description) values ($1, 'Direct Listed', 'd') returning id`,
      [`c-${uniq()}`],
    );
    const b = await db.query<{ id: string }>(
      `insert into public.charities (slug, name, description, archived_at) values ($1, 'Direct Archived', 'd', now()) returning id`,
      [`c-${uniq()}`],
    );
    listed = a.rows[0]?.id ?? '';
    archived = b.rows[0]?.id ?? '';
  });

  it('a signed-in user CAN select a listed charity and raise then lower their percentage (D-064: any value from 10% up)', async () => {
    await as(db, asAlice(), async (tx) => {
      expect((await select(tx, alice, listed)).affectedRows).toBe(1);
      for (const bps of [2500, 1000, 10000, 1000]) {
        expect(
          (
            await tx.query(`update public.profiles set charity_bps = $1 where id = $2`, [
              bps,
              alice,
            ])
          ).affectedRows,
        ).toBe(1);
      }
    });
  });

  it('a signed-in user CANNOT select an archived charity by updating their own profile directly', async () => {
    const err = await as(db, asAlice(), (tx) => pgError(select(tx, alice, archived)));
    expect(err.code).toBe('GS002');
  });

  it('nor can they go below 10% or above 100%', async () => {
    for (const bps of [999, 0, 10001]) {
      const err = await as(db, asAlice(), (tx) =>
        pgError(
          tx.query(`update public.profiles set charity_bps = $1 where id = $2`, [bps, alice]),
        ),
      );
      expect(err.code, String(bps)).toBe(PG.checkViolation);
    }
  });

  it("nor change another user's selection (the row is invisible to them)", async () => {
    await as(db, asAlice(), async (tx) => {
      expect((await select(tx, bob, listed)).affectedRows).toBe(0);
    });
  });
});

describe('directory search (DIR-01): the full-text queries the API sends', () => {
  const search = async (tx: Transaction, tsquery: string) =>
    (
      await tx.query<{ name: string }>(
        `select name from public.charities where search @@ to_tsquery('english', $1) and archived_at is null order by name`,
        [tsquery],
      )
    ).rows.map((r) => r.name);

  async function directory(tx: Transaction) {
    await charity(tx, {
      name: 'Riverside Youth Fund',
      description: 'Coaching and mentoring for young people.',
      tags: ['youth', 'education'],
    });
    await charity(tx, {
      name: 'Ocean Trust',
      description: 'Coastal clean-ups and marine conservation.',
      tags: ['environment'],
      featured: true,
    });
    await charity(tx, {
      name: 'Community Kitchen',
      description: 'Free meals for local families.',
      tags: ['community', 'food'],
      featured: true,
    });
    await charity(tx, {
      name: 'Hidden Archive Youth',
      description: 'Youth coaching, archived.',
      tags: ['youth'],
      archived: true,
    });
  }

  it('matches the START of a word in the name (type-ahead): "river:*"', async () => {
    await asOwner(db, async (tx) => {
      await directory(tx);
      expect(await search(tx, 'river:*')).toEqual(['Riverside Youth Fund']);
    });
  });

  it('matches words in the description, with stemming: "coach:*" and "clean:*"', async () => {
    await asOwner(db, async (tx) => {
      await directory(tx);
      expect(await search(tx, 'coach:*')).toEqual(['Riverside Youth Fund']);
      expect(await search(tx, 'clean:*')).toEqual(['Ocean Trust']);
    });
  });

  it('combines several words with AND: "youth:* & mentor:*"', async () => {
    await asOwner(db, async (tx) => {
      await directory(tx);
      expect(await search(tx, 'youth:* & mentor:*')).toEqual(['Riverside Youth Fund']);
      expect(await search(tx, 'youth:* & marine:*')).toEqual([]);
    });
  });

  it('never returns archived charities', async () => {
    await asOwner(db, async (tx) => {
      await directory(tx);
      expect(await search(tx, 'archive:*')).toEqual([]);
    });
  });

  it('does NOT match the middle of a word (a documented limitation of word search): "side:*"', async () => {
    await asOwner(db, async (tx) => {
      await directory(tx);
      expect(await search(tx, 'side:*')).toEqual([]);
    });
  });

  it('a query of only stop words is harmless (no error, no rows)', async () => {
    await asOwner(db, async (tx) => {
      await directory(tx);
      expect(await search(tx, 'the:*')).toEqual([]);
    });
  });

  it('as a visitor (anon), search works but never exposes archived charities', async () => {
    await db.query(
      `insert into public.charities (slug, name, description, tags) values ($1, 'Anon Visible Search Fund', 'searchable text', '{anon}')`,
      [`c-${uniq()}`],
    );
    await db.query(
      `insert into public.charities (slug, name, description, archived_at) values ($1, 'Anon Hidden Search Fund', 'searchable text', now())`,
      [`c-${uniq()}`],
    );
    const names = await as(db, { role: 'anon' }, async (tx) =>
      (
        await tx.query<{ name: string }>(
          `select name from public.charities where search @@ to_tsquery('english', 'searchabl:*') order by name`,
        )
      ).rows.map((r) => r.name),
    );
    expect(names).toEqual(['Anon Visible Search Fund']);
  });
});

describe('directory filters and spotlight (DIR-01, DIR-03)', () => {
  it('filters by tag with array containment, exactly', async () => {
    await asOwner(db, async (tx) => {
      await charity(tx, { name: 'A', tags: ['youth', 'education'] });
      await charity(tx, { name: 'B', tags: ['youthful'] });
      await charity(tx, { name: 'C', tags: [] });
      const { rows } = await tx.query<{ name: string }>(
        `select name from public.charities where tags @> array['youth'] order by name`,
      );
      expect(rows.map((r) => r.name)).toEqual(['A']);
    });
  });

  it('the spotlight is the listed charities flagged featured, by name; more than one may be featured', async () => {
    await asOwner(db, async (tx) => {
      await charity(tx, { name: 'Zeta Featured', featured: true });
      await charity(tx, { name: 'Alpha Featured', featured: true });
      await charity(tx, { name: 'Not Featured' });
      await charity(tx, { name: 'Archived Featured', featured: true, archived: true });
      const { rows } = await tx.query<{ name: string }>(
        `select name from public.charities where is_featured and archived_at is null order by name`,
      );
      expect(rows.map((r) => r.name)).toEqual(['Alpha Featured', 'Zeta Featured']);
    });
  });

  it('upcoming events are those starting from now on, soonest first; an archived charity has none visible', async () => {
    await asOwner(db, async (tx) => {
      const c = await charity(tx, { name: 'Events' });
      const gone = await charity(tx, { name: 'Gone', archived: true });
      for (const [title, when, who] of [
        ['past', '2020-01-01T10:00Z', c],
        ['later', '2099-06-01T10:00Z', c],
        ['sooner', '2099-01-01T10:00Z', c],
        ['hidden', '2099-03-01T10:00Z', gone],
      ] as const) {
        await tx.query(
          `insert into public.charity_events (charity_id, title, starts_at) values ($1, $2, $3)`,
          [who, title, when],
        );
      }
      const { rows } = await tx.query<{ title: string }>(
        `select title from public.charity_events where charity_id = $1 and starts_at >= now() order by starts_at`,
        [c],
      );
      expect(rows.map((r) => r.title)).toEqual(['sooner', 'later']);
    });
  });
});

describe('choosing a charity at signup (CHR-01, D-065, migration …130000)', () => {
  interface SignupProfile {
    role: string;
    charity_bps: number;
    selected_charity_id: string | null;
  }

  /** Signs a user up with the given signup data and returns the profile the trigger created. */
  async function signUpWith(metadata: unknown): Promise<SignupProfile> {
    return asOwner(db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`,
        [`signup-${uniq()}@example.test`, JSON.stringify(metadata)],
      );
      const profile = await tx.query<SignupProfile>(
        `select role, charity_bps, selected_charity_id from public.profiles where id = $1`,
        [rows[0]?.id],
      );
      expect(profile.rows).toHaveLength(1); // the signup itself always succeeds
      return profile.rows[0] as SignupProfile;
    });
  }
  const chosen = (id: string) => ({ [SIGNUP_CHARITY_METADATA_KEY]: id });

  let listed: string;
  let archived: string;
  beforeAll(async () => {
    // COMMITTED fixtures: asOwner() rolls back, so a charity made inside it would not exist for the signups.
    const make = async (archivedAt: string | null) =>
      (
        await db.query<{ id: string }>(
          `insert into public.charities (slug, name, description, archived_at)
           values ($1, 'Signup fixture', 'd', $2) returning id`,
          [`c-${uniq()}`, archivedAt],
        )
      ).rows[0]?.id ?? '';
    listed = await make(null);
    archived = await make(new Date().toISOString());
  });

  it('records a listed charity chosen on the signup form', async () => {
    const p = await signUpWith(chosen(listed));
    expect(p).toEqual({ role: 'user', charity_bps: 1000, selected_charity_id: listed });
  });

  it('accepts the id in upper case', async () => {
    expect((await signUpWith(chosen(listed.toUpperCase()))).selected_charity_id).toBe(listed);
  });

  it('a signup with no charity still succeeds and leaves it unselected', async () => {
    for (const metadata of [{}, { other: 'x' }, { [SIGNUP_CHARITY_METADATA_KEY]: null }]) {
      expect((await signUpWith(metadata)).selected_charity_id, JSON.stringify(metadata)).toBeNull();
    }
  });

  it('ignores an archived charity (the signup still succeeds)', async () => {
    expect((await signUpWith(chosen(archived))).selected_charity_id).toBeNull();
  });

  it('ignores a charity that does not exist', async () => {
    const missing = '00000000-0000-4000-8000-00000000dead';
    expect((await signUpWith(chosen(missing))).selected_charity_id).toBeNull();
  });

  it.each([
    'not-a-uuid',
    '',
    ' ',
    "'; drop table public.charities; --",
    '11111111-1111-4111-8111-11111111111', // one character short
    '11111111-1111-4111-8111-1111111111111', // one character long
    '11111111111141118111111111111111', // no dashes
    5,
    true,
    { id: 'x' },
    ['a'],
  ])('malformed data can never fail a signup: %j', async (value) => {
    const p = await signUpWith({ [SIGNUP_CHARITY_METADATA_KEY]: value });
    expect(p.selected_charity_id).toBeNull();
    expect(p.role).toBe('user');
  });

  it('reads nothing else: role and percentage still come from the defaults', async () => {
    const p = await signUpWith({
      ...chosen(listed),
      role: 'admin',
      charity_bps: 9999,
      is_admin: true,
    });
    expect(p).toEqual({ role: 'user', charity_bps: 1000, selected_charity_id: listed });
  });

  it('is not executable by browser roles (privileges survived the redefinition)', async () => {
    const { rows } = await db.query<{ anon: boolean; authed: boolean; pub: boolean }>(
      `select has_function_privilege('anon', 'public.handle_new_user()', 'execute') as anon,
              has_function_privilege('authenticated', 'public.handle_new_user()', 'execute') as authed,
              has_function_privilege('public', 'public.handle_new_user()', 'execute') as pub`,
    );
    expect(rows[0]).toEqual({ anon: false, authed: false, pub: false });
  });
});
