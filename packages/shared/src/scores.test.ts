import { describe, expect, it } from 'vitest';
import {
  isValidCalendarDate,
  parseCreateScore,
  parsePlayedOnParam,
  parseUpdateScore,
  playedOnError,
  stablefordScoreError,
} from './scores.js';

describe('stablefordScoreError (SCR-02: integer 1-45)', () => {
  it.each([1, 2, 22, 44, 45])('accepts %i', (value) => {
    expect(stablefordScoreError(value)).toBeNull();
  });

  it.each([0, -1, 46, 100, 1e9])('rejects the out-of-range number %s', (value) => {
    expect(stablefordScoreError(value)).toMatch(/between 1 and 45/);
  });

  it.each([30.5, 0.1, 44.999, NaN, Infinity, -Infinity])('rejects the non-integer %s', (value) => {
    expect(stablefordScoreError(value)).toMatch(/whole number/);
  });

  it.each(['30', '', null, undefined, true, false, [], {}, [30]])(
    'rejects the non-number %j',
    (value) => {
      expect(stablefordScoreError(value)).toMatch(/whole number/);
    },
  );
});

describe('isValidCalendarDate / playedOnError (SCR-03: every score has a date)', () => {
  it.each(['2026-03-05', '2024-02-29', '2000-02-29', '1999-12-31', '0001-01-01', '9999-12-31'])(
    'accepts %s',
    (value) => {
      expect(isValidCalendarDate(value)).toBe(true);
      expect(playedOnError(value)).toBeNull();
    },
  );

  it.each([
    '2026-02-30', // no such day
    '2025-02-29', // not a leap year
    '1900-02-29', // century, not a leap year
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2026-1-5',
    '26-01-01',
    '2026/01/01',
    '01-01-2026',
    '2026-01-01T00:00:00Z',
    ' 2026-01-01',
    '2026-01-01 ',
    'today',
    '',
  ])('rejects "%s"', (value) => {
    expect(isValidCalendarDate(value)).toBe(false);
    expect(playedOnError(value)).not.toBeNull();
  });

  it.each([null, undefined, 20260305, true, {}, []])('rejects the non-string %j', (value) => {
    expect(playedOnError(value)).toMatch(/date is required/);
  });

  it('does NOT reject future or very old dates: those rules are undecided (D-027)', () => {
    expect(playedOnError('2099-12-31')).toBeNull();
    expect(playedOnError('1950-01-01')).toBeNull();
  });
});

describe('parseCreateScore', () => {
  it('accepts a valid body', () => {
    expect(parseCreateScore({ playedOn: '2026-03-05', stablefordScore: 36 })).toEqual({
      ok: true,
      value: { playedOn: '2026-03-05', stablefordScore: 36 },
    });
  });

  it('reports every invalid field at once, by field name', () => {
    const result = parseCreateScore({ playedOn: '2026-02-30', stablefordScore: 46 });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.map((e) => e.field)).toEqual(['playedOn', 'stablefordScore']);
  });

  it('requires both fields', () => {
    const result = parseCreateScore({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(2);
  });

  it.each([null, undefined, 'x', 5, [], [{ playedOn: '2026-03-05', stablefordScore: 30 }]])(
    'rejects a body that is not a JSON object: %j',
    (body) => {
      const result = parseCreateScore(body);
      expect(result).toEqual({
        ok: false,
        errors: [{ field: 'body', message: 'A JSON object is required.' }],
      });
    },
  );

  it('ignores unknown fields such as a client-chosen owner (ownership comes from the token)', () => {
    const result = parseCreateScore({
      playedOn: '2026-03-05',
      stablefordScore: 30,
      userId: 'someone-else',
      user_id: 'someone-else',
      id: 'x',
    });
    expect(result).toEqual({ ok: true, value: { playedOn: '2026-03-05', stablefordScore: 30 } });
  });
});

describe('parseUpdateScore and parsePlayedOnParam', () => {
  it('validates the edit body', () => {
    expect(parseUpdateScore({ stablefordScore: 12 })).toEqual({
      ok: true,
      value: { stablefordScore: 12 },
    });
    expect(parseUpdateScore({ stablefordScore: 0 }).ok).toBe(false);
    expect(parseUpdateScore({}).ok).toBe(false);
    expect(parseUpdateScore(null).ok).toBe(false);
  });

  it('does not let an edit change the date: only stablefordScore is read', () => {
    expect(parseUpdateScore({ stablefordScore: 12, playedOn: '2020-01-01' })).toEqual({
      ok: true,
      value: { stablefordScore: 12 },
    });
  });

  it('validates the path parameter', () => {
    expect(parsePlayedOnParam('2026-03-05')).toEqual({ ok: true, value: '2026-03-05' });
    expect(parsePlayedOnParam('2026-02-30').ok).toBe(false);
    expect(parsePlayedOnParam('abc').ok).toBe(false);
    expect(parsePlayedOnParam(undefined).ok).toBe(false);
  });
});
