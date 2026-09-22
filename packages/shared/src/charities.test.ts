import { describe, expect, it } from 'vitest';
import {
  API_ADMIN_CHARITIES_PATH,
  CHARITY_ERROR_CODES,
  CHARITY_LIST_DEFAULT_LIMIT,
  SIGNUP_CHARITY_METADATA_KEY,
  checkCharityPercentage,
  formatPercent,
  isUuid,
  isValidCharitySlug,
  parseCharityListQuery,
  parseCreateCharityRequest,
  parseDonationRequest,
  parseUpdateCharityPreference,
  parseUpdateCharityRequest,
  percentToBps,
} from './charities.js';

const ID = '11111111-1111-4111-8111-111111111111';

describe('checkCharityPercentage (CHR-02 minimum 10%, CHR-03 may increase, D-064)', () => {
  it.each([1000, 1001, 1250, 2500, 9999, 10000])('accepts %i bps', (bps) => {
    expect(checkCharityPercentage(bps)).toEqual({ ok: true, bps });
  });

  it.each([0, 1, 500, 999, -1000])('rejects %i as below the 10% minimum', (bps) => {
    const r = checkCharityPercentage(bps);
    expect(r).toMatchObject({ ok: false, problem: 'below_minimum' });
    if (!r.ok) expect(r.message).toMatch(/at least 10%/);
  });

  it.each([10001, 20000, 1e9])('rejects %i as above 100%', (bps) => {
    expect(checkCharityPercentage(bps)).toMatchObject({ ok: false, problem: 'above_maximum' });
  });

  it.each([12.5, NaN, Infinity, '1000', null, undefined, true, [], {}])(
    'rejects the non-integer %j',
    (bps) => {
      expect(checkCharityPercentage(bps)).toMatchObject({ ok: false, problem: 'not_an_integer' });
    },
  );

  it('honours a configured product cap, and 100% when none is set', () => {
    expect(checkCharityPercentage(3000, 3000)).toEqual({ ok: true, bps: 3000 });
    expect(checkCharityPercentage(3001, 3000)).toMatchObject({
      ok: false,
      problem: 'above_maximum',
    });
    expect(checkCharityPercentage(10000, null)).toEqual({ ok: true, bps: 10000 });
  });

  it('never accepts a cap above 100%, and the minimum still applies under a cap', () => {
    expect(checkCharityPercentage(10001, 50000)).toMatchObject({
      ok: false,
      problem: 'above_maximum',
    });
    expect(checkCharityPercentage(999, 3000)).toMatchObject({
      ok: false,
      problem: 'below_minimum',
    });
  });

  it('has no "increase only" rule: it does not know the current value at all (D-064)', () => {
    expect(checkCharityPercentage.length).toBeLessThanOrEqual(2); // (value, maxBps) — no "current" parameter
  });
});

describe('formatPercent / percentToBps', () => {
  it.each([
    [1000, '10%'],
    [1250, '12.5%'],
    [1005, '10.05%'],
    [10000, '100%'],
    [1099, '10.99%'],
    [1050, '10.5%'],
  ])('formats %i as %s', (bps, text) => {
    expect(formatPercent(bps)).toBe(text);
  });

  it.each([
    ['10', 1000],
    ['12.5', 1250],
    ['12.50', 1250],
    ['10.05', 1005],
    ['100', 10000],
    [' 25 ', 2500],
    ['0.5', 50],
    ['7', 700],
  ])('parses "%s" as %i bps (exact, no floating point)', (text, bps) => {
    expect(percentToBps(text)).toBe(bps);
  });

  it.each(['', 'abc', '-10', '1e2', '10.555', '10.', '.5', '1,000', '1000', '10%', '  '])(
    'rejects "%s"',
    (text) => {
      expect(percentToBps(text)).toBeNull();
    },
  );

  it('round-trips every hundredth of a percent from 0.00 to 100.00 without error', () => {
    for (let bps = 0; bps <= 10000; bps++) {
      const text = formatPercent(bps).replace('%', '');
      expect(percentToBps(text), `${String(bps)} -> ${text}`).toBe(bps);
    }
  });
});

describe('parseCharityListQuery (DIR-01)', () => {
  const ok = (q: Record<string, unknown>) => {
    const r = parseCharityListQuery(q);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return r.value;
  };

  it('applies defaults when nothing is given', () => {
    expect(ok({})).toEqual({ limit: CHARITY_LIST_DEFAULT_LIMIT, offset: 0 });
  });

  it('reads search, tag, featured and paging', () => {
    expect(
      ok({ q: '  Riverside  ', tag: 'Youth', featured: 'true', limit: '5', offset: '10' }),
    ).toEqual({
      q: 'Riverside',
      tag: 'youth',
      featured: true,
      limit: 5,
      offset: 10,
    });
  });

  it('treats blank q / tag / featured / limit / offset as absent', () => {
    expect(ok({ q: '   ', tag: '', featured: '', limit: '', offset: '' })).toEqual({
      limit: 20,
      offset: 0,
    });
  });

  it.each([
    [{ limit: '0' }, 'limit'],
    [{ limit: '51' }, 'limit'],
    [{ limit: '-1' }, 'limit'],
    [{ limit: '2.5' }, 'limit'],
    [{ limit: 'abc' }, 'limit'],
    [{ offset: '-1' }, 'offset'],
    [{ offset: '10001' }, 'offset'],
    [{ offset: 'x' }, 'offset'],
    [{ featured: 'false' }, 'featured'],
    [{ featured: 'yes' }, 'featured'],
    [{ tag: 'a,b' }, 'tag'],
    [{ tag: '{x}' }, 'tag'],
    [{ tag: 'x'.repeat(41) }, 'tag'],
    [{ tag: '-lead' }, 'tag'],
    [{ q: 'x'.repeat(101) }, 'q'],
    [{ q: ['a', 'b'] }, 'q'],
    [{ tag: { a: 1 } }, 'tag'],
    [{ limit: ['1', '2'] }, 'limit'],
  ])('rejects %j naming the field "%s"', (query, field) => {
    const r = parseCharityListQuery(query);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.field)).toContain(field);
  });

  it('reports every problem at once', () => {
    const r = parseCharityListQuery({ limit: '0', offset: '-1', featured: 'no' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.field).sort()).toEqual(['featured', 'limit', 'offset']);
  });

  it('ignores unknown parameters', () => {
    expect(ok({ userId: 'x', archived: 'true' })).toEqual({ limit: 20, offset: 0 });
  });
});

describe('parseUpdateCharityPreference (CHR-01, CHR-03)', () => {
  it('accepts either field or both', () => {
    expect(parseUpdateCharityPreference({ charityId: ID })).toEqual({
      ok: true,
      value: { charityId: ID },
    });
    expect(parseUpdateCharityPreference({ percentageBps: 1500 })).toEqual({
      ok: true,
      value: { percentageBps: 1500 },
    });
    expect(parseUpdateCharityPreference({ charityId: ID, percentageBps: 2000 })).toEqual({
      ok: true,
      value: { charityId: ID, percentageBps: 2000 },
    });
  });

  it('does NOT range-check the percentage here (that needs server configuration)', () => {
    expect(parseUpdateCharityPreference({ percentageBps: 5 }).ok).toBe(true);
  });

  it.each([{}, { userId: ID }, null, undefined, 'x', 5, [], [{ charityId: ID }]])(
    'rejects a body with no usable field: %j',
    (body) => {
      expect(parseUpdateCharityPreference(body).ok).toBe(false);
    },
  );

  it.each([
    { charityId: 'nope' },
    { charityId: 5 },
    { charityId: null },
    { charityId: ID.toUpperCase().slice(0, 35) },
    { percentageBps: '1500' },
    { percentageBps: 15.5 },
    { percentageBps: null },
  ])('rejects invalid field values %j', (body) => {
    expect(parseUpdateCharityPreference(body).ok).toBe(false);
  });

  it('ignores an owner supplied in the body', () => {
    expect(
      parseUpdateCharityPreference({
        charityId: ID,
        userId: 'someone-else',
        user_id: 'x',
        role: 'admin',
      }),
    ).toEqual({ ok: true, value: { charityId: ID } });
  });
});

describe('parseDonationRequest (CHR-04) — validation only; payment is a later phase', () => {
  it('accepts a positive integer amount, a currency code and a charity id', () => {
    expect(parseDonationRequest({ charityId: ID, amountMinor: 500, currency: 'USD' })).toEqual({
      ok: true,
      value: { charityId: ID, amountMinor: 500, currency: 'USD' },
    });
  });

  it('accepts a 1-minor-unit donation: the PRD defines no minimum (D-025)', () => {
    expect(parseDonationRequest({ charityId: ID, amountMinor: 1, currency: 'EUR' }).ok).toBe(true);
  });

  it.each([0, -5, 5.5, NaN, Infinity, '500', null, undefined, 2 ** 53])(
    'rejects the amount %j (money is integer minor units)',
    (amountMinor) => {
      const r = parseDonationRequest({ charityId: ID, amountMinor, currency: 'USD' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.map((e) => e.field)).toEqual(['amountMinor']);
    },
  );

  it.each(['usd', 'US', 'USDD', '', '123', null, undefined, 5])(
    'rejects the currency %j',
    (currency) => {
      expect(parseDonationRequest({ charityId: ID, amountMinor: 100, currency }).ok).toBe(false);
    },
  );

  it('rejects a missing or malformed charity and non-object bodies', () => {
    expect(parseDonationRequest({ amountMinor: 100, currency: 'USD' }).ok).toBe(false);
    expect(parseDonationRequest({ charityId: 'x', amountMinor: 100, currency: 'USD' }).ok).toBe(
      false,
    );
    for (const body of [null, 'x', [], 5]) expect(parseDonationRequest(body).ok).toBe(false);
  });
});

describe('identifiers', () => {
  it('validates charity slugs like the database does', () => {
    for (const ok of ['a', 'riverside-youth-fund', 'abc-123'])
      expect(isValidCharitySlug(ok)).toBe(true);
    for (const bad of [
      '',
      'Upper',
      'a b',
      'a--b',
      '-a',
      'a-',
      'a/b',
      '../etc',
      'x'.repeat(201),
      null,
      5,
    ])
      expect(isValidCharitySlug(bad)).toBe(false);
  });

  it('validates UUIDs', () => {
    expect(isUuid(ID)).toBe(true);
    for (const bad of ['', 'x', ID.slice(1), `${ID}0`, null, 1]) expect(isUuid(bad)).toBe(false);
  });
});

describe('signup charity contract (CHR-01, D-065)', () => {
  it('the signup-data key matches what the database trigger reads', () => {
    // supabase/migrations/…130000_signup_charity_selection.sql reads exactly this key.
    expect(SIGNUP_CHARITY_METADATA_KEY).toBe('selected_charity_id');
  });

  it('has distinct, stable codes for "no charity selected" and "selected charity archived"', () => {
    expect(CHARITY_ERROR_CODES.selectionRequired).toBe('charity_required');
    expect(CHARITY_ERROR_CODES.selectedUnavailable).toBe('selected_charity_unavailable');
    const codes = Object.values(CHARITY_ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('admin charity management (PRD §11 ADM-05)', () => {
  it('API_ADMIN_CHARITIES_PATH is under the admin prefix', () => {
    expect(API_ADMIN_CHARITIES_PATH).toBe('/api/admin/charities');
  });

  describe('parseCreateCharityRequest', () => {
    it('accepts a minimal valid request', () => {
      expect(
        parseCreateCharityRequest({
          slug: 'riverside-youth',
          name: 'Riverside Youth Fund',
          description: 'Supports young golfers.',
        }),
      ).toEqual({
        ok: true,
        value: {
          slug: 'riverside-youth',
          name: 'Riverside Youth Fund',
          description: 'Supports young golfers.',
        },
      });
    });

    it('accepts optional tags and trims name/description', () => {
      const result = parseCreateCharityRequest({
        slug: 'x',
        name: '  Ocean Trust  ',
        description: '  Clean water.  ',
        tags: ['youth', 'ocean'],
      });
      expect(result).toEqual({
        ok: true,
        value: {
          slug: 'x',
          name: 'Ocean Trust',
          description: 'Clean water.',
          tags: ['youth', 'ocean'],
        },
      });
    });

    it('ignores unknown fields such as id or archivedAt', () => {
      const result = parseCreateCharityRequest({
        slug: 'x',
        name: 'Ocean Trust',
        description: 'Clean water.',
        id: 'x',
        archivedAt: '2020-01-01',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toHaveProperty('id');
        expect(result.value).not.toHaveProperty('archivedAt');
      }
    });

    it.each([
      ['missing slug', { name: 'x', description: 'x' }],
      ['invalid slug', { slug: 'Not Valid!', name: 'x', description: 'x' }],
      ['missing name', { slug: 'x', description: 'x' }],
      ['empty name', { slug: 'x', name: '  ', description: 'x' }],
      ['missing description', { slug: 'x', name: 'x' }],
      ['empty description', { slug: 'x', name: 'x', description: '  ' }],
      ['non-array tags', { slug: 'x', name: 'x', description: 'x', tags: 'youth' }],
      ['a non-string tag', { slug: 'x', name: 'x', description: 'x', tags: [1] }],
    ])('rejects %s', (_label, body) => {
      const result = parseCreateCharityRequest(body);
      expect(result.ok).toBe(false);
    });

    it.each([null, undefined, 'x', 5, [], true])('rejects a non-object body %j', (body) => {
      const result = parseCreateCharityRequest(body);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.errors).toEqual([{ field: 'body', message: 'A JSON object is required.' }]);
    });
  });

  describe('parseUpdateCharityRequest', () => {
    it('accepts a single field', () => {
      expect(parseUpdateCharityRequest({ isFeatured: true })).toEqual({
        ok: true,
        value: { isFeatured: true },
      });
    });

    it('accepts every field at once, trimming name/description', () => {
      const result = parseUpdateCharityRequest({
        name: '  New Name  ',
        description: '  New description.  ',
        tags: ['a'],
        isFeatured: false,
      });
      expect(result).toEqual({
        ok: true,
        value: {
          name: 'New Name',
          description: 'New description.',
          tags: ['a'],
          isFeatured: false,
        },
      });
    });

    it('rejects an empty body (nothing to change)', () => {
      const result = parseUpdateCharityRequest({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0]?.field).toBe('body');
    });

    it.each([
      ['empty name', { name: '  ' }],
      ['empty description', { description: '' }],
      ['non-boolean isFeatured', { isFeatured: 'yes' }],
      ['non-array tags', { tags: 'x' }],
    ])('rejects %s', (_label, body) => {
      expect(parseUpdateCharityRequest(body).ok).toBe(false);
    });

    it.each([null, undefined, 'x', 5, [], true])('rejects a non-object body %j', (body) => {
      const result = parseUpdateCharityRequest(body);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.errors).toEqual([{ field: 'body', message: 'A JSON object is required.' }]);
    });
  });

  it('the duplicate-slug error code is stable and distinct from the others', () => {
    expect(CHARITY_ERROR_CODES.duplicateSlug).toBe('charity_slug_exists');
    const codes = Object.values(CHARITY_ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
