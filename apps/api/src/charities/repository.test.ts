import { describe, expect, it } from 'vitest';
import { stubClient } from '../test-support/queryStub.js';
import {
  createSupabaseCharityRepository,
  parseCharityRow,
  toDetail,
  toSummary,
  type CharityRow,
} from './repository.js';

const url = (p: string) => `https://cdn.test/${p}`;
const NOW = '2026-09-21T10:00:00.000Z';
const FILTER = { limit: 20, offset: 0 };

const ROW = {
  id: 'c1',
  slug: 'riverside',
  name: 'Riverside Youth Fund',
  description: 'Coaching for young people.',
  tags: ['youth'],
  is_featured: true,
  charity_images: [
    { id: 'i2', storage_path: 'b.png', alt_text: 'second', sort_order: 2 },
    { id: 'i1', storage_path: 'a.png', alt_text: 'first', sort_order: 1 },
  ],
  charity_events: [
    {
      id: 'e2',
      title: 'Later',
      description: null,
      location: 'Hall',
      starts_at: '2026-12-01T10:00:00+00:00',
      ends_at: null,
    },
    {
      id: 'e1',
      title: 'Sooner',
      description: 'Fun',
      location: null,
      starts_at: '2026-10-01T10:00:00+00:00',
      ends_at: '2026-10-01T16:00:00+00:00',
    },
  ],
};

describe('parseCharityRow (trust boundary)', () => {
  it('maps a row with embedded images and events', () => {
    const row = parseCharityRow(ROW);
    expect(row).toMatchObject({ id: 'c1', slug: 'riverside', isFeatured: true, tags: ['youth'] });
    expect(row.images).toHaveLength(2);
    expect(row.events).toHaveLength(2);
  });

  it('treats absent embeds as empty', () => {
    const bare = Object.fromEntries(
      Object.entries(ROW).filter(([key]) => !key.startsWith('charity_')),
    );
    const row = parseCharityRow(bare);
    expect(row.images).toEqual([]);
    expect(row.events).toEqual([]);
  });

  it.each([
    null,
    'x',
    [],
    {},
    { ...ROW, tags: 'youth' },
    { ...ROW, tags: [1] },
    { ...ROW, is_featured: 'yes' },
    { ...ROW, name: 5 },
    { ...ROW, charity_images: [{}] },
    { ...ROW, charity_events: 'x' },
  ])('rejects a malformed row %j', (row) => {
    expect(() => parseCharityRow(row)).toThrow(/Malformed/);
  });
});

describe('toSummary / toDetail (DIR-02: description, images, upcoming events)', () => {
  const row: CharityRow = parseCharityRow(ROW);

  it('summary: the FIRST image by position is the cover, the soonest event is nextEventAt', () => {
    const s = toSummary(row, url);
    expect(s.coverImage).toEqual({ id: 'i1', url: 'https://cdn.test/a.png', altText: 'first' });
    expect(s.nextEventAt).toBe('2026-10-01T10:00:00+00:00');
    expect(s).toMatchObject({
      id: 'c1',
      slug: 'riverside',
      name: 'Riverside Youth Fund',
      isFeatured: true,
      tags: ['youth'],
    });
    expect(s).not.toHaveProperty('description');
  });

  it('summary: no images and no events give nulls', () => {
    const s = toSummary({ ...row, images: [], events: [] }, url);
    expect(s.coverImage).toBeNull();
    expect(s.nextEventAt).toBeNull();
  });

  it('detail: the full description, ALL images in order, events soonest first', () => {
    const d = toDetail(row, url);
    expect(d.description).toBe('Coaching for young people.');
    expect(d.images.map((i) => i.url)).toEqual([
      'https://cdn.test/a.png',
      'https://cdn.test/b.png',
    ]);
    expect(d.upcomingEvents.map((e) => e.title)).toEqual(['Sooner', 'Later']);
    expect(d.upcomingEvents[0]).toMatchObject({
      endsAt: '2026-10-01T16:00:00+00:00',
      location: null,
      description: 'Fun',
    });
  });

  it('orders equal image positions deterministically', () => {
    const tied = {
      ...row,
      images: [
        { id: 'z', storagePath: 'z.png', altText: '', sortOrder: 0 },
        { id: 'a', storagePath: 'a.png', altText: '', sortOrder: 0 },
      ],
    };
    expect(toDetail(tied, url).images.map((i) => i.id)).toEqual(['a', 'z']);
  });
});

describe('list — what is sent to PostgREST', () => {
  it('reads LISTED charities only, upcoming events only, by name, one extra row for paging', async () => {
    const { client, seen } = stubClient({ data: [], error: null });
    await createSupabaseCharityRepository(client).list(FILTER, NOW);
    expect(seen.table).toBe('charities');
    expect(seen.query?.calls).toEqual([
      'select(id, slug, name, description, tags, is_featured, charity_images(id, storage_path, alt_text, sort_order), charity_events(starts_at))',
      'is(archived_at=null)',
      `gte(charity_events.starts_at>=${NOW})`,
      'order(name,asc)',
      'order(id,asc)',
      'order(charity_images.sort_order,asc)',
      'range(0,20)',
    ]);
    expect(seen.bucket).toBeUndefined();
  });

  it('adds the featured filter, the tag containment filter and the prefix full-text search', async () => {
    const { client, seen } = stubClient({ data: [], error: null });
    await createSupabaseCharityRepository(client).list(
      { ...FILTER, featured: true, tag: 'youth', q: 'River you!' },
      NOW,
    );
    const calls = seen.query?.calls ?? [];
    expect(calls).toContain('eq(is_featured=true)');
    expect(calls).toContain('contains(tags=["youth"])');
    expect(calls).toContain('textSearch(search:river:* & you:*|english)');
    expect(calls.at(-1)).toBe('range(0,20)');
  });

  it('applies paging with one extra row: offset 40, limit 10 → range(40,50)', async () => {
    const { client, seen } = stubClient({ data: [], error: null });
    await createSupabaseCharityRepository(client).list({ limit: 10, offset: 40 }, NOW);
    expect(seen.query?.calls.at(-1)).toBe('range(40,50)');
  });

  it('search text with nothing searchable matches NOTHING and never reaches the database', async () => {
    const { client, seen } = stubClient({ data: [ROW], error: null });
    const result = await createSupabaseCharityRepository(client).list({ ...FILTER, q: '!!!' }, NOW);
    expect(result).toEqual({ charities: [], hasMore: false });
    expect(seen.table).toBeUndefined();
  });

  it('reports hasMore when the extra row exists, and trims it from the page', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ ...ROW, id: `c${String(i)}` }));
    const { client } = stubClient({ data: rows, error: null });
    const result = await createSupabaseCharityRepository(client).list({ limit: 2, offset: 0 }, NOW);
    expect(result.charities.map((c) => c.id)).toEqual(['c0', 'c1']);
    expect(result.hasMore).toBe(true);

    const exact = await createSupabaseCharityRepository(
      stubClient({ data: rows.slice(0, 2), error: null }).client,
    ).list({ limit: 2, offset: 0 }, NOW);
    expect(exact.hasMore).toBe(false);
  });

  it('builds image URLs through the charity-media storage bucket', async () => {
    const { client } = stubClient({ data: [ROW], error: null });
    const { charities } = await createSupabaseCharityRepository(client).list(FILTER, NOW);
    expect(charities[0]?.coverImage?.url).toBe('https://cdn.test/charity-media/a.png');
  });

  it('throws when the query fails or a row is malformed', async () => {
    await expect(
      createSupabaseCharityRepository(
        stubClient({ data: null, error: { message: 'boom' } }).client,
      ).list(FILTER, NOW),
    ).rejects.toThrow(/Charity list failed/);
    await expect(
      createSupabaseCharityRepository(stubClient({ data: [{ nope: 1 }], error: null }).client).list(
        FILTER,
        NOW,
      ),
    ).rejects.toThrow(/Malformed/);
  });
});

describe('findBySlug', () => {
  it('reads one LISTED charity by slug with upcoming events, soonest first, capped at 20', async () => {
    const { client, seen } = stubClient({ data: ROW, error: null });
    const detail = await createSupabaseCharityRepository(client).findBySlug('riverside', NOW);
    expect(detail?.name).toBe('Riverside Youth Fund');
    expect(seen.query?.calls).toEqual([
      'select(id, slug, name, description, tags, is_featured, charity_images(id, storage_path, alt_text, sort_order), charity_events(id, title, description, location, starts_at, ends_at))',
      'eq(slug=riverside)',
      'is(archived_at=null)',
      `gte(charity_events.starts_at>=${NOW})`,
      'order(charity_events.starts_at,asc)',
      'limit(charity_events.20)',
      'order(charity_images.sort_order,asc)',
      'maybeSingle()',
    ]);
  });

  it('returns null when there is no listed charity', async () => {
    expect(
      await createSupabaseCharityRepository(
        stubClient({ data: null, error: null }).client,
      ).findBySlug('x', NOW),
    ).toBeNull();
  });

  it('throws on a query error', async () => {
    await expect(
      createSupabaseCharityRepository(
        stubClient({ data: null, error: { message: 'x' } }).client,
      ).findBySlug('x', NOW),
    ).rejects.toThrow(/Charity lookup failed/);
  });
});

describe('findForSelection', () => {
  it('reports existence and archived state', async () => {
    const live = stubClient({ data: { id: 'c1', archived_at: null }, error: null });
    expect(await createSupabaseCharityRepository(live.client).findForSelection('c1')).toEqual({
      id: 'c1',
      archived: false,
    });
    expect(live.seen.query?.calls).toEqual([
      'select(id, archived_at)',
      'eq(id=c1)',
      'maybeSingle()',
    ]);
    const gone = stubClient({
      data: { id: 'c1', archived_at: '2026-01-01T00:00:00Z' },
      error: null,
    });
    expect(await createSupabaseCharityRepository(gone.client).findForSelection('c1')).toEqual({
      id: 'c1',
      archived: true,
    });
    expect(
      await createSupabaseCharityRepository(
        stubClient({ data: null, error: null }).client,
      ).findForSelection('c1'),
    ).toBeNull();
  });
});

describe('preference (CHR-01, CHR-03)', () => {
  const PREF_ROW = {
    charity_bps: 1500,
    charities: { id: 'c1', slug: 'riverside', name: 'Riverside', archived_at: null },
  };

  it('reads the profile scoped by user id, with the selected charity embedded', async () => {
    const { client, seen } = stubClient({ data: PREF_ROW, error: null });
    const pref = await createSupabaseCharityRepository(client).getPreference('u1');
    expect(pref).toEqual({
      percentageBps: 1500,
      charity: { id: 'c1', slug: 'riverside', name: 'Riverside', isArchived: false },
    });
    expect(seen.table).toBe('profiles');
    expect(seen.query?.calls).toEqual([
      'select(charity_bps, charities!selected_charity_id(id, slug, name, archived_at))',
      'eq(id=u1)',
      'maybeSingle()',
    ]);
  });

  it('flags a selected charity that has since been archived, and handles no selection', async () => {
    const archived = {
      charity_bps: 1000,
      charities: { id: 'c1', slug: 's', name: 'N', archived_at: '2026-01-01T00:00:00Z' },
    };
    expect(
      (
        await createSupabaseCharityRepository(
          stubClient({ data: archived, error: null }).client,
        ).getPreference('u')
      )?.charity?.isArchived,
    ).toBe(true);
    expect(
      await createSupabaseCharityRepository(
        stubClient({ data: { charity_bps: 1000, charities: null }, error: null }).client,
      ).getPreference('u'),
    ).toEqual({ percentageBps: 1000, charity: null });
    expect(
      await createSupabaseCharityRepository(
        stubClient({ data: null, error: null }).client,
      ).getPreference('u'),
    ).toBeNull();
  });

  it.each([
    { charity_bps: '1000', charities: null },
    { charity_bps: 10.5, charities: null },
    { charity_bps: 1000, charities: 'x' },
    null,
  ])('rejects a malformed profile row %j', async (data) => {
    if (data === null) return; // "no row" is a valid null result, covered above
    await expect(
      createSupabaseCharityRepository(stubClient({ data, error: null }).client).getPreference('u'),
    ).rejects.toThrow(/Malformed/);
  });

  it('updates ONLY the provided columns, scoped by user id', async () => {
    const both = stubClient({ data: PREF_ROW, error: null });
    await createSupabaseCharityRepository(both.client).updatePreference('u1', {
      charityId: 'c1',
      percentageBps: 1500,
    });
    expect(both.seen.query?.calls[0]).toBe(
      'update({"selected_charity_id":"c1","charity_bps":1500})',
    );
    expect(both.seen.query?.calls).toContain('eq(id=u1)');

    const only = stubClient({ data: PREF_ROW, error: null });
    await createSupabaseCharityRepository(only.client).updatePreference('u1', {
      percentageBps: 2000,
    });
    expect(only.seen.query?.calls[0]).toBe('update({"charity_bps":2000})');
  });

  it('maps the database guard (GS002) to "unavailable" and a foreign-key error (23503) to "not found"', async () => {
    const guard = stubClient({
      data: null,
      error: { code: 'GS002', message: 'An archived charity cannot be selected' },
    });
    expect(
      await createSupabaseCharityRepository(guard.client).updatePreference('u', { charityId: 'c' }),
    ).toEqual({ kind: 'charity_unavailable' });
    const fk = stubClient({ data: null, error: { code: '23503', message: 'fk' } });
    expect(
      await createSupabaseCharityRepository(fk.client).updatePreference('u', { charityId: 'c' }),
    ).toEqual({ kind: 'charity_not_found' });
  });

  it.each(['23514', '42501', 'PGRST116', undefined])(
    'treats any other database error (%s) as a failure, never a business outcome',
    async (code) => {
      const { client } = stubClient({ data: null, error: { ...(code && { code }), message: 'x' } });
      await expect(
        createSupabaseCharityRepository(client).updatePreference('u', { percentageBps: 1000 }),
      ).rejects.toThrow(/Preference update failed/);
    },
  );

  it('reports a missing profile', async () => {
    const { client } = stubClient({ data: null, error: null });
    expect(
      await createSupabaseCharityRepository(client).updatePreference('u', { percentageBps: 1000 }),
    ).toEqual({ kind: 'no_profile' });
  });
});

describe('getMaxBps (platform_settings.charity_max_bps)', () => {
  it('reads the single settings row', async () => {
    const { client, seen } = stubClient({ data: { charity_max_bps: 3000 }, error: null });
    expect(await createSupabaseCharityRepository(client).getMaxBps()).toBe(3000);
    expect(seen.table).toBe('platform_settings');
    expect(seen.query?.calls).toEqual(['select(charity_max_bps)', 'eq(id=true)', 'maybeSingle()']);
  });

  it('is null when unset, when the row is missing, and throws on error', async () => {
    expect(
      await createSupabaseCharityRepository(
        stubClient({ data: { charity_max_bps: null }, error: null }).client,
      ).getMaxBps(),
    ).toBeNull();
    expect(
      await createSupabaseCharityRepository(
        stubClient({ data: null, error: null }).client,
      ).getMaxBps(),
    ).toBeNull();
    await expect(
      createSupabaseCharityRepository(
        stubClient({ data: null, error: { message: 'x' } }).client,
      ).getMaxBps(),
    ).rejects.toThrow(/Settings lookup failed/);
  });
});

describe('listContributions (CHR-04: independent donations are contributions too)', () => {
  const C = {
    id: 'k1',
    charity_id: 'c1',
    source: 'donation',
    currency: 'USD',
    amount_minor: 500,
    basis_minor: null,
    percentage_bps: null,
    created_at: '2026-03-01T00:00:00+00:00',
    charities: { name: 'Riverside' },
  };

  it("reads only this user's rows, newest first, capped", async () => {
    const { client, seen } = stubClient({ data: [C], error: null });
    const list = await createSupabaseCharityRepository(client).listContributions('u1');
    expect(list).toEqual([
      {
        id: 'k1',
        charityId: 'c1',
        charityName: 'Riverside',
        source: 'donation',
        amountMinor: 500,
        currency: 'USD',
        percentageBps: null,
        basisMinor: null,
        createdAt: C.created_at,
      },
    ]);
    expect(seen.table).toBe('charity_contributions');
    expect(seen.query?.calls).toEqual([
      'select(id, charity_id, source, currency, amount_minor, basis_minor, percentage_bps, created_at, charities(name))',
      'eq(user_id=u1)',
      'order(created_at,desc)',
      'limit(100)',
    ]);
  });

  it('maps subscription contributions with their percentage and basis', async () => {
    const sub = {
      ...C,
      source: 'subscription',
      percentage_bps: 1000,
      basis_minor: 5000,
      amount_minor: 500,
    };
    const [c] = await createSupabaseCharityRepository(
      stubClient({ data: [sub], error: null }).client,
    ).listContributions('u');
    expect(c).toMatchObject({ source: 'subscription', percentageBps: 1000, basisMinor: 5000 });
  });

  it.each([
    { ...C, source: 'gift' },
    { ...C, amount_minor: '500' },
    { ...C, amount_minor: 5.5 },
    { ...C, id: 1 },
    'x',
  ])('rejects a malformed row %j', async (row) => {
    await expect(
      createSupabaseCharityRepository(
        stubClient({ data: [row], error: null }).client,
      ).listContributions('u'),
    ).rejects.toThrow(/Malformed/);
  });

  it('throws when the query fails', async () => {
    await expect(
      createSupabaseCharityRepository(
        stubClient({ data: null, error: { message: 'x' } }).client,
      ).listContributions('u'),
    ).rejects.toThrow(/Contribution lookup failed/);
  });
});

describe('admin charity management (PRD §11 ADM-05)', () => {
  const ADMIN_ROW = { ...ROW, archived_at: null };
  const ARCHIVED_ROW = { ...ROW, archived_at: '2026-01-01T00:00:00.000Z' };

  describe('adminList', () => {
    it('selects archived_at and applies NO listed-only filter', async () => {
      const { client, seen } = stubClient({ data: [ADMIN_ROW], error: null });
      const result = await createSupabaseCharityRepository(client).adminList(NOW);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: 'c1', isArchived: false });
      expect(seen.query?.calls[0]).toContain('archived_at');
      expect(seen.query?.calls).not.toContain('is(archived_at=null)');
    });

    it('marks an archived charity isArchived: true', async () => {
      const { client } = stubClient({ data: [ARCHIVED_ROW], error: null });
      const [charity] = await createSupabaseCharityRepository(client).adminList(NOW);
      expect(charity?.isArchived).toBe(true);
    });

    it('throws on a query error', async () => {
      await expect(
        createSupabaseCharityRepository(
          stubClient({ data: null, error: { message: 'x' } }).client,
        ).adminList(NOW),
      ).rejects.toThrow(/Admin charity list failed/);
    });
  });

  describe('adminFindById', () => {
    it('finds an archived charity by id (the public repository never would)', async () => {
      const { client, seen } = stubClient({ data: ARCHIVED_ROW, error: null });
      const charity = await createSupabaseCharityRepository(client).adminFindById('c1', NOW);
      expect(charity?.isArchived).toBe(true);
      expect(seen.query?.calls).toContain('eq(id=c1)');
      expect(seen.query?.calls).not.toContain('is(archived_at=null)');
    });

    it('returns null when no such charity exists at all', async () => {
      const { client } = stubClient({ data: null, error: null });
      expect(await createSupabaseCharityRepository(client).adminFindById('x', NOW)).toBeNull();
    });
  });

  describe('create', () => {
    it('inserts the given fields and returns the admin DTO', async () => {
      const { client, seen } = stubClient({ data: ADMIN_ROW, error: null });
      const result = await createSupabaseCharityRepository(client).create({
        slug: 'riverside',
        name: 'Riverside Youth Fund',
        description: 'Coaching for young people.',
        tags: ['youth'],
      });
      expect(result).toEqual({
        kind: 'created',
        charity: expect.objectContaining({ id: 'c1' }) as unknown,
      });
      expect(seen.query?.calls[0]).toBe(
        'insert({"slug":"riverside","name":"Riverside Youth Fund","description":"Coaching for young people.","tags":["youth"]})',
      );
      expect(seen.query?.calls).toContain('single()');
    });

    it('maps a unique-slug violation to duplicate_slug', async () => {
      const { client } = stubClient({ data: null, error: { code: '23505', message: 'x' } });
      expect(
        await createSupabaseCharityRepository(client).create({
          slug: 'taken',
          name: 'x',
          description: 'x',
        }),
      ).toEqual({ kind: 'duplicate_slug' });
    });

    it('any other error is a plain failure', async () => {
      await expect(
        createSupabaseCharityRepository(
          stubClient({ data: null, error: { message: 'x' } }).client,
        ).create({
          slug: 'x',
          name: 'x',
          description: 'x',
        }),
      ).rejects.toThrow(/Charity creation failed/);
    });
  });

  describe('update', () => {
    it('sends only the changed columns', async () => {
      const { client, seen } = stubClient({ data: ADMIN_ROW, error: null });
      await createSupabaseCharityRepository(client).update('c1', { name: 'New Name' }, NOW);
      expect(seen.query?.calls[0]).toBe('update({"name":"New Name"})');
      expect(seen.query?.calls).toContain('eq(id=c1)');
    });

    it('maps isFeatured to is_featured', async () => {
      const { client, seen } = stubClient({ data: ADMIN_ROW, error: null });
      await createSupabaseCharityRepository(client).update('c1', { isFeatured: true }, NOW);
      expect(seen.query?.calls[0]).toBe('update({"is_featured":true})');
    });

    it('returns null when no such charity exists', async () => {
      const { client } = stubClient({ data: null, error: null });
      expect(
        await createSupabaseCharityRepository(client).update('x', { name: 'x' }, NOW),
      ).toBeNull();
    });
  });

  describe('setArchived', () => {
    it('archiving sets archived_at to a timestamp', async () => {
      const { client, seen } = stubClient({ data: ARCHIVED_ROW, error: null });
      const result = await createSupabaseCharityRepository(client).setArchived('c1', true, NOW);
      expect(result?.isArchived).toBe(true);
      const call = seen.query?.calls[0] ?? '';
      expect(call).toMatch(/^update\(\{"archived_at":"/);
    });

    it('unarchiving sets archived_at to null', async () => {
      const { client, seen } = stubClient({ data: ADMIN_ROW, error: null });
      const result = await createSupabaseCharityRepository(client).setArchived('c1', false, NOW);
      expect(result?.isArchived).toBe(false);
      expect(seen.query?.calls[0]).toBe('update({"archived_at":null})');
    });

    it('returns null when no such charity exists', async () => {
      const { client } = stubClient({ data: null, error: null });
      expect(await createSupabaseCharityRepository(client).setArchived('x', true, NOW)).toBeNull();
    });
  });
});
