import { describe, expect, it } from 'vitest';
import {
  API_ADMIN_WINNERS_PATH,
  API_MY_WINNERS_PATH,
  WINNER_ERROR_CODES,
  WINNER_PROOF_ALLOWED_MIME_TYPES,
  WINNER_PROOF_MAX_BYTES,
  parseRegisterWinnerProofRequest,
  parseReviewWinnerRequest,
} from './winners.js';

describe('paths', () => {
  it('are under /api/me and /api/admin', () => {
    expect(API_MY_WINNERS_PATH).toBe('/api/me/winners');
    expect(API_ADMIN_WINNERS_PATH).toBe('/api/admin/winners');
  });
});

describe('storage limits (development defaults, D-021/D-051)', () => {
  it('mirror the winner-proofs bucket configuration', () => {
    expect(WINNER_PROOF_MAX_BYTES).toBe(10_485_760);
    expect(WINNER_PROOF_ALLOWED_MIME_TYPES).toEqual(['image/png', 'image/jpeg', 'image/webp']);
  });
});

describe('parseRegisterWinnerProofRequest', () => {
  it('accepts a storage path', () => {
    expect(parseRegisterWinnerProofRequest({ storagePath: 'w1/screenshot.png' })).toEqual({
      ok: true,
      value: { storagePath: 'w1/screenshot.png' },
    });
  });

  it('ignores everything else', () => {
    expect(
      parseRegisterWinnerProofRequest({ storagePath: 'w1/x.png', winnerId: 'other', id: 'x' }),
    ).toEqual({ ok: true, value: { storagePath: 'w1/x.png' } });
  });

  it.each([undefined, null, 5, '', ' '.repeat(0), 'x'.repeat(513), [], {}])(
    'rejects storagePath %j',
    (storagePath) => {
      const result = parseRegisterWinnerProofRequest({ storagePath });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.map((e) => e.field)).toEqual(['storagePath']);
    },
  );

  it('accepts a storage path at the maximum length', () => {
    const storagePath = `w1/${'a'.repeat(509)}`; // 512 total
    expect(storagePath.length).toBe(512);
    expect(parseRegisterWinnerProofRequest({ storagePath })).toEqual({
      ok: true,
      value: { storagePath },
    });
  });

  it.each([null, undefined, 'x', 5, [], true])('rejects a non-object body %j', (body) => {
    const result = parseRegisterWinnerProofRequest(body);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toEqual([{ field: 'body', message: 'A JSON object is required.' }]);
  });
});

describe('parseReviewWinnerRequest', () => {
  it.each(['approved', 'rejected'] as const)('accepts decision "%s" alone', (decision) => {
    expect(parseReviewWinnerRequest({ decision })).toEqual({ ok: true, value: { decision } });
  });

  it('accepts an optional note', () => {
    expect(parseReviewWinnerRequest({ decision: 'rejected', note: 'Blurry screenshot' })).toEqual({
      ok: true,
      value: { decision: 'rejected', note: 'Blurry screenshot' },
    });
  });

  it('ignores everything else', () => {
    expect(
      parseReviewWinnerRequest({ decision: 'approved', reviewedBy: 'someone-else', id: 'x' }),
    ).toEqual({ ok: true, value: { decision: 'approved' } });
  });

  it.each([undefined, null, 5, '', 'Approved', 'APPROVED', 'maybe', ['approved']])(
    'rejects decision %j',
    (decision) => {
      const result = parseReviewWinnerRequest({ decision });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.map((e) => e.field)).toContain('decision');
    },
  );

  it.each([5, [], {}, 'x'.repeat(2001)])('rejects an invalid note %j', (note) => {
    const result = parseReviewWinnerRequest({ decision: 'approved', note });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.field)).toContain('note');
  });

  it('accepts a note at the maximum length', () => {
    const note = 'x'.repeat(2000);
    expect(parseReviewWinnerRequest({ decision: 'approved', note })).toEqual({
      ok: true,
      value: { decision: 'approved', note },
    });
  });

  it('reports both fields when both are invalid', () => {
    const result = parseReviewWinnerRequest({ decision: 'x', note: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.field).sort()).toEqual(['decision', 'note']);
  });

  it.each([null, undefined, 'x', 5, [], true])('rejects a non-object body %j', (body) => {
    const result = parseReviewWinnerRequest(body);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toEqual([{ field: 'body', message: 'A JSON object is required.' }]);
  });
});

describe('WINNER_ERROR_CODES', () => {
  it('are stable and distinct', () => {
    const codes = Object.values(WINNER_ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    expect(WINNER_ERROR_CODES.notFound).toBe('winner_not_found');
    expect(WINNER_ERROR_CODES.proofNotAwaiting).toBe('winner_proof_not_awaiting');
    expect(WINNER_ERROR_CODES.notApproved).toBe('winner_not_approved_for_payout');
  });
});
