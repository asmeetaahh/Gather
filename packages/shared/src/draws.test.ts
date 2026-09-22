import { describe, expect, it } from 'vitest';
import {
  API_ADMIN_DRAWS_PATH,
  API_MY_DRAWS_PATH,
  DRAW_ERROR_CODES,
  parseCreateDrawRequest,
} from './draws.js';

describe('API_ADMIN_DRAWS_PATH', () => {
  it('is under the admin prefix', () => {
    expect(API_ADMIN_DRAWS_PATH).toBe('/api/admin/draws');
  });
});

describe('API_MY_DRAWS_PATH', () => {
  it('is under /api/me', () => {
    expect(API_MY_DRAWS_PATH).toBe('/api/me/draws');
  });
});

describe('parseCreateDrawRequest', () => {
  it.each(['random', 'algorithmic'] as const)(
    'accepts a first-of-month date and mode "%s"',
    (mode) => {
      expect(parseCreateDrawRequest({ drawMonth: '2026-11-01', mode })).toEqual({
        ok: true,
        value: { drawMonth: '2026-11-01', mode },
      });
    },
  );

  it('ignores everything else (an id, a status, numbers)', () => {
    expect(
      parseCreateDrawRequest({
        drawMonth: '2026-11-01',
        mode: 'random',
        id: 'x',
        status: 'published',
        winningNumbers: [1, 2, 3, 4, 5],
      }),
    ).toEqual({ ok: true, value: { drawMonth: '2026-11-01', mode: 'random' } });
  });

  it.each([
    ['not the first of the month', '2026-11-15'],
    ['a two-digit year', '26-11-01'],
    ['month 13', '2026-13-01'],
    ['month 00', '2026-00-01'],
    ['a date-time', '2026-11-01T00:00:00Z'],
    ['the wrong separator', '2026/11/01'],
    ['empty', ''],
  ])('rejects drawMonth: %s ("%s")', (_label, drawMonth) => {
    const result = parseCreateDrawRequest({ drawMonth, mode: 'random' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.field)).toContain('drawMonth');
  });

  it.each([undefined, null, 5, '', 'Random', 'ALGORITHMIC', ['random']])(
    'rejects mode %j',
    (mode) => {
      const result = parseCreateDrawRequest({ drawMonth: '2026-11-01', mode });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.map((e) => e.field)).toContain('mode');
    },
  );

  it('reports both fields when both are invalid', () => {
    const result = parseCreateDrawRequest({ drawMonth: 'x', mode: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.field).sort()).toEqual(['drawMonth', 'mode']);
  });

  it.each([null, undefined, 'x', 5, [], true])('rejects a non-object body %j', (body) => {
    const result = parseCreateDrawRequest(body);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toEqual([{ field: 'body', message: 'A JSON object is required.' }]);
  });
});

describe('DRAW_ERROR_CODES', () => {
  it('are stable and distinct', () => {
    const codes = Object.values(DRAW_ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    expect(DRAW_ERROR_CODES.notSimulated).toBe('draw_not_simulated');
    expect(DRAW_ERROR_CODES.poolNotConfigured).toBe('prize_pool_not_configured');
  });
});
