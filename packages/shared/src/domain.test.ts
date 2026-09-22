import { describe, expect, it } from 'vitest';
import {
  BPS_DENOMINATOR,
  MAX_RETAINED_SCORES,
  MIN_CHARITY_BPS,
  PRIZE_TIERS,
  SCORE_MAX,
  SCORE_MIN,
} from './domain.js';

describe('PRD constants', () => {
  it('SCR-02: score range is 1-45', () => {
    expect([SCORE_MIN, SCORE_MAX]).toEqual([1, 45]);
  });

  it('SCR-05: at most 5 scores are retained', () => {
    expect(MAX_RETAINED_SCORES).toBe(5);
  });

  it('CHR-02: the minimum charity share is 10% expressed in basis points', () => {
    expect(MIN_CHARITY_BPS / BPS_DENOMINATOR).toBe(0.1);
  });

  it('DRW-09: prize tier shares are 40/35/25 and account for the whole pool', () => {
    expect(PRIZE_TIERS.map((t) => t.shareBps)).toEqual([4_000, 3_500, 2_500]);
    expect(PRIZE_TIERS.reduce((sum, t) => sum + t.shareBps, 0)).toBe(BPS_DENOMINATOR);
  });

  it('DRW-06: only the 5-match tier rolls over', () => {
    expect(PRIZE_TIERS.filter((t) => t.rollsOver).map((t) => t.matchCount)).toEqual([5]);
  });
});
