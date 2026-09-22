import { describe, expect, it } from 'vitest';
import { PRIZE_TIERS } from '@gather/shared';
import { scriptedRandom, seededRandom } from '../test-support/random.js';
import {
  MixedCurrencyPoolError,
  allocateTier,
  computeMatchCount,
  drawAlgorithmicNumbers,
  drawRandomNumbers,
  monthlyPoolShare,
  poolFromBps,
  poolFromFixedPerSubscriber,
  poolFundingBasisForMonth,
  splitPoolAcrossTiers,
  ticketOf,
  toMonthKey,
  type PaymentBasis,
} from './domain.js';

const RANGE_1_45 = { min: 1, max: 45 };

describe('drawRandomNumbers (DRW-04, standard lottery-style; D-012/D-071: 1-45, five distinct)', () => {
  it('produces exactly five distinct numbers within the range, sorted ascending', () => {
    const numbers = drawRandomNumbers(RANGE_1_45, seededRandom(1));
    expect(numbers).toHaveLength(5);
    expect(new Set(numbers).size).toBe(5);
    for (const n of numbers) expect(n).toBeGreaterThanOrEqual(1);
    for (const n of numbers) expect(n).toBeLessThanOrEqual(45);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });

  it('is deterministic: the same seed always produces the same draw', () => {
    expect(drawRandomNumbers(RANGE_1_45, seededRandom(42))).toEqual(
      drawRandomNumbers(RANGE_1_45, seededRandom(42)),
    );
  });

  it('different seeds (usually) produce different draws', () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      drawRandomNumbers(RANGE_1_45, seededRandom(i)),
    );
    expect(new Set(results.map((r) => r.join(','))).size).toBeGreaterThan(15);
  });

  it('never repeats a number and never leaves the range, across 500 seeds', () => {
    for (let seed = 0; seed < 500; seed++) {
      const numbers = drawRandomNumbers(RANGE_1_45, seededRandom(seed));
      expect(new Set(numbers).size, `seed ${String(seed)}`).toBe(5);
      expect(
        numbers.every((n) => n >= 1 && n <= 45),
        `seed ${String(seed)}`,
      ).toBe(true);
    }
  });

  it('an exact, hand-traced draw with a scripted random source', () => {
    // range {1..6}: pool=[1,2,3,4,5,6]. r0=0.9999 -> j=5 -> picks 6 (swap to front). r1..r4=0 -> no
    // further swaps -> picks 2,3,4,5 in place. Result before sort [6,2,3,4,5] -> sorted [2,3,4,5,6].
    expect(drawRandomNumbers({ min: 1, max: 6 }, scriptedRandom(0.9999, 0, 0, 0, 0))).toEqual([
      2, 3, 4, 5, 6,
    ]);
  });

  it('uses the boundary numbers of the range (both ends reachable)', () => {
    // Force every swap to the LAST remaining slot: picks the whole pool in reverse, i.e. the full range.
    expect(drawRandomNumbers({ min: 1, max: 5 }, scriptedRandom(0.999))).toEqual([1, 2, 3, 4, 5]);
  });

  it('a range with exactly five numbers always returns the whole range, whatever the randomness', () => {
    for (const seed of [0, 1, 2, 3]) {
      expect(drawRandomNumbers({ min: 10, max: 14 }, seededRandom(seed))).toEqual([
        10, 11, 12, 13, 14,
      ]);
    }
  });

  it('refuses a range with fewer than five numbers', () => {
    expect(() => drawRandomNumbers({ min: 1, max: 4 }, seededRandom(0))).toThrow(RangeError);
  });
});

describe('drawAlgorithmicNumbers (DRW-04 "weighted by score frequency"; D-013/D-071)', () => {
  it('always returns exactly five distinct numbers in range, even with no weight data at all', () => {
    for (let seed = 0; seed < 100; seed++) {
      const numbers = drawAlgorithmicNumbers(RANGE_1_45, new Map(), seededRandom(seed));
      expect(new Set(numbers).size, `seed ${String(seed)}`).toBe(5);
      expect(numbers.every((n) => n >= 1 && n <= 45)).toBe(true);
    }
  });

  it('a single, overwhelmingly weighted number is picked in essentially every draw', () => {
    const weights = new Map([[7, 100]]);
    let hits = 0;
    const trials = 200;
    for (let seed = 0; seed < trials; seed++) {
      if (drawAlgorithmicNumbers(RANGE_1_45, weights, seededRandom(seed)).includes(7)) hits++;
    }
    expect(hits).toBe(trials); // weight 100 vs. 44 numbers at weight 0: certain to be chosen first
  });

  it('an unweighted (never-scored) number is picked far less often than a heavily weighted one', () => {
    const weights = new Map([[7, 100]]);
    const trials = 300;
    let sevenHits = 0;
    let unweightedHits = 0;
    for (let seed = 0; seed < trials; seed++) {
      const numbers = drawAlgorithmicNumbers(RANGE_1_45, weights, seededRandom(seed));
      if (numbers.includes(7)) sevenHits++;
      if (numbers.includes(40)) unweightedHits++; // 40 has weight 0
    }
    expect(sevenHits).toBeGreaterThan(unweightedHits * 5);
  });

  it('an exact, hand-traced draw: the weighted number is chosen first, the rest fall back to uniform among the zero-weight pool', () => {
    // range {1..10}, only value 7 has weight. r0=0 -> the weighted-selection loop finds value 7
    // (subtracting zero weights changes nothing, so it lands exactly on the first nonzero weight).
    // Remaining rounds have total weight 0 -> fallback branch; r=0 each time -> always index 0 of
    // whatever remains -> 1, 2, 3, 4 in turn.
    const weights = new Map([[7, 100]]);
    expect(drawAlgorithmicNumbers({ min: 1, max: 10 }, weights, scriptedRandom(0))).toEqual([
      1, 2, 3, 4, 7,
    ]);
  });

  it('fills in from the unweighted pool when fewer than five numbers have any weight', () => {
    // Only two distinct scores exist among eligible users' tickets right now.
    const weights = new Map([
      [3, 5],
      [9, 2],
    ]);
    const numbers = drawAlgorithmicNumbers({ min: 1, max: 20 }, weights, seededRandom(7));
    expect(numbers).toHaveLength(5);
    expect(new Set(numbers).size).toBe(5);
    expect(numbers).toEqual(expect.arrayContaining([3, 9]));
  });

  it('ignores weights for numbers outside the configured range', () => {
    const weights = new Map([[999, 1000]]);
    const numbers = drawAlgorithmicNumbers({ min: 1, max: 10 }, weights, seededRandom(3));
    expect(numbers.every((n) => n >= 1 && n <= 10)).toBe(true);
  });

  it('refuses a range with fewer than five numbers', () => {
    expect(() => drawAlgorithmicNumbers({ min: 1, max: 4 }, new Map(), seededRandom(0))).toThrow(
      RangeError,
    );
  });
});

describe('ticketOf (D-011/D-071: a ticket is the DISTINCT values among a user’s latest scores)', () => {
  it('deduplicates repeated score values', () => {
    expect(ticketOf([22, 22, 30, 15, 8])).toEqual([22, 30, 15, 8]);
  });

  it('a user with fewer than five scores simply has a smaller ticket (D-016)', () => {
    expect(ticketOf([12, 30])).toEqual([12, 30]);
    expect(ticketOf([])).toEqual([]);
  });

  it('leaves an already-distinct ticket unchanged (order preserved)', () => {
    expect(ticketOf([5, 1, 9, 2, 40])).toEqual([5, 1, 9, 2, 40]);
  });
});

describe('computeMatchCount — highest-tier-only matching (DRW-03; D-011/D-071)', () => {
  const WINNERS = [1, 2, 3, 4, 5];

  it('exact 5-match', () => {
    expect(computeMatchCount([1, 2, 3, 4, 5], WINNERS)).toBe(5);
  });
  it('exact 4-match', () => {
    expect(computeMatchCount([1, 2, 3, 4, 99], WINNERS)).toBe(4);
  });
  it('exact 3-match', () => {
    expect(computeMatchCount([1, 2, 3, 98, 99], WINNERS)).toBe(3);
  });
  it('below the lowest prize tier (0, 1, 2 matches) is a valid, non-winning count', () => {
    expect(computeMatchCount([10, 20, 30], WINNERS)).toBe(0);
    expect(computeMatchCount([1, 20, 30], WINNERS)).toBe(1);
    expect(computeMatchCount([1, 2, 30, 40], WINNERS)).toBe(2);
  });

  it('a duplicate value in the ticket counts once, not twice (order-independent set matching)', () => {
    expect(computeMatchCount([1, 1, 1, 2, 3], WINNERS)).toBe(3);
    // Even a ticket that was not pre-deduplicated by the caller is handled safely.
    expect(computeMatchCount([22, 22, 30], [22, 9, 30, 41, 2])).toBe(2);
  });

  it('is order-independent: shuffling the ticket or the winning numbers changes nothing', () => {
    expect(computeMatchCount([5, 3, 1, 4, 2], [3, 1, 5, 4, 2])).toBe(5);
    expect(computeMatchCount([99, 3, 1], [5, 3, 1, 98, 2])).toBe(2);
  });

  it('a ticket with fewer than five numbers cannot exceed its own size in matches', () => {
    expect(computeMatchCount([1, 2], WINNERS)).toBe(2);
    expect(computeMatchCount([], WINNERS)).toBe(0);
  });

  it('the result is always a single number, never simultaneously more than one tier', () => {
    // A 5-match ticket cannot ALSO separately register as a 3-match: match_count is one integer, and a
    // draw_entries row has exactly one match_count column (the schema itself makes "highest tier only"
    // structurally true; this pins the domain function's contract).
    const result = computeMatchCount([1, 2, 3, 4, 5], WINNERS);
    expect(typeof result).toBe('number');
    expect(result).toBe(5);
  });
});

describe('toMonthKey', () => {
  it('formats the UTC calendar month as YYYY-MM-01', () => {
    expect(toMonthKey(new Date('2026-11-15T23:59:59Z'))).toBe('2026-11-01');
    expect(toMonthKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01');
    expect(toMonthKey(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-01');
  });
});

describe('monthlyPoolShare / poolFundingBasisForMonth (D-014/D-069/D-070/D-071)', () => {
  const monthly = (
    basisMinor: number,
    periodStartMonth: string,
    currency = 'USD',
  ): PaymentBasis => ({
    basisMinor,
    currency,
    intervalMonths: 1,
    periodStartMonth,
  });
  const yearly = (
    basisMinor: number,
    periodStartMonth: string,
    currency = 'USD',
  ): PaymentBasis => ({
    basisMinor,
    currency,
    intervalMonths: 12,
    periodStartMonth,
  });

  it('a monthly payment funds ONLY the one month it starts in, in full', () => {
    const p = monthly(1000, '2026-09-01');
    expect(monthlyPoolShare(p, '2026-09-01')).toBe(1000n);
    expect(monthlyPoolShare(p, '2026-08-01')).toBe(0n);
    expect(monthlyPoolShare(p, '2026-10-01')).toBe(0n);
  });

  it('a yearly payment splits its basis into twelve EQUAL monthly shares (D-070’s 1/12 rule)', () => {
    const p = yearly(1200, '2026-01-01'); // divides evenly: 100/month
    for (let m = 1; m <= 12; m++) {
      const month = `2026-${String(m).padStart(2, '0')}-01`;
      expect(monthlyPoolShare(p, month), month).toBe(100n);
    }
    expect(monthlyPoolShare(p, '2027-01-01')).toBe(0n); // the 13th month is not covered
    expect(monthlyPoolShare(p, '2025-12-01')).toBe(0n);
  });

  it('a yearly payment’s remainder from floor division goes entirely to the FIRST covered month', () => {
    const p = yearly(1000, '2026-03-01'); // 1000 / 12 = 83 remainder 4
    expect(monthlyPoolShare(p, '2026-03-01')).toBe(83n + 4n); // first month gets the remainder
    for (let i = 1; i < 12; i++) {
      const d = new Date(Date.UTC(2026, 2 + i, 1));
      expect(monthlyPoolShare(p, toMonthKey(d))).toBe(83n);
    }
    // Every minor unit is accounted for: nothing invented, nothing lost across the whole span.
    let total = 0n;
    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.UTC(2026, 2 + i, 1));
      total += monthlyPoolShare(p, toMonthKey(d));
    }
    expect(total).toBe(1000n);
  });

  it('poolFundingBasisForMonth sums every contributing payment for that month', () => {
    const result = poolFundingBasisForMonth(
      [monthly(500, '2026-09-01'), monthly(300, '2026-09-01'), monthly(999, '2026-08-01')],
      '2026-09-01',
    );
    expect(result).toEqual({ basisMinor: 800, currency: 'USD' });
  });

  it('sums a mix of monthly and yearly contributions for the same month', () => {
    const result = poolFundingBasisForMonth(
      [monthly(500, '2026-09-01'), yearly(1200, '2026-01-01')],
      '2026-09-01',
    );
    expect(result).toEqual({ basisMinor: 600, currency: 'USD' }); // 500 + 100 (1200/12)
  });

  it('is null when nothing funds that month at all', () => {
    expect(poolFundingBasisForMonth([], '2026-09-01')).toBeNull();
    expect(poolFundingBasisForMonth([monthly(500, '2026-01-01')], '2026-09-01')).toBeNull();
  });

  it('throws MixedCurrencyPoolError when contributing payments are not all the same currency', () => {
    expect(() =>
      poolFundingBasisForMonth(
        [monthly(500, '2026-09-01', 'USD'), monthly(500, '2026-09-01', 'EUR')],
        '2026-09-01',
      ),
    ).toThrow(MixedCurrencyPoolError);
  });

  it('a currency mismatch OUTSIDE the target month is not a problem (it never contributes)', () => {
    const result = poolFundingBasisForMonth(
      [monthly(500, '2026-09-01', 'USD'), monthly(500, '2026-01-01', 'EUR')],
      '2026-09-01',
    );
    expect(result).toEqual({ basisMinor: 500, currency: 'USD' });
  });
});

describe('poolFromBps / poolFromFixedPerSubscriber (D-014/D-071)', () => {
  it('poolFromBps rounds DOWN (never overstates what the percentage implies)', () => {
    expect(poolFromBps(1000, 1000)).toBe(100); // exact 10%
    expect(poolFromBps(999, 1000)).toBe(99); // 99.9 -> 99, not 100
    expect(poolFromBps(1, 1000)).toBe(0);
    expect(poolFromBps(0, 5000)).toBe(0);
  });

  it('is exact at large amounts (BigInt, no floating-point drift)', () => {
    expect(poolFromBps(Number.MAX_SAFE_INTEGER, 10_000)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('poolFromFixedPerSubscriber multiplies the configured per-subscriber amount by the count', () => {
    expect(poolFromFixedPerSubscriber(120, 500)).toBe(60_000);
    expect(poolFromFixedPerSubscriber(0, 500)).toBe(0);
  });
});

describe('splitPoolAcrossTiers (DRW-09: 40/35/25)', () => {
  it('splits by the configured shares, each rounded down', () => {
    const shares = splitPoolAcrossTiers(1000);
    expect(shares).toEqual([
      { matchCount: 5, shareBps: 4000, rollsOver: true, poolMinor: 400 },
      { matchCount: 4, shareBps: 3500, rollsOver: false, poolMinor: 350 },
      { matchCount: 3, shareBps: 2500, rollsOver: false, poolMinor: 250 },
    ]);
  });

  it('an amount that does not split evenly leaves at most a couple of minor units unallocated to any tier', () => {
    const shares = splitPoolAcrossTiers(1);
    const allocated = shares.reduce((sum, s) => sum + s.poolMinor, 0);
    expect(allocated).toBeLessThanOrEqual(1);
    expect(shares.every((s) => s.poolMinor >= 0)).toBe(true);
  });

  it('never allocates more than the pool in total, for many pool sizes', () => {
    for (const pool of [0, 1, 3, 7, 9999, 1_000_000_007]) {
      const total = splitPoolAcrossTiers(pool).reduce((sum, s) => sum + s.poolMinor, 0);
      expect(total, String(pool)).toBeLessThanOrEqual(pool);
    }
  });

  it('matches the live prize_tiers shape from the shared package', () => {
    expect(splitPoolAcrossTiers(10_000).map((s) => s.shareBps)).toEqual(
      PRIZE_TIERS.map((t) => t.shareBps),
    );
  });
});

describe('allocateTier — equal split, remainder, rollover (DRW-06/08; D-019/D-020/D-071)', () => {
  const base = { matchCount: 5 as const, shareBps: 4000, rollsOver: true };

  it('splits equally among several winners, flooring, with the leftover as remainder', () => {
    const result = allocateTier({ ...base, poolMinor: 1000, rolloverInMinor: 0, winnersCount: 3 });
    expect(result.prizePerWinnerMinor).toBe(333);
    expect(result.remainderMinor).toBe(1);
    expect(result.rolloverOutMinor).toBe(0);
    expect(result.prizePerWinnerMinor * 3 + result.remainderMinor).toBe(1000);
  });

  it('a single winner takes the whole pot (rollover included) exactly, no remainder', () => {
    const result = allocateTier({ ...base, poolMinor: 700, rolloverInMinor: 300, winnersCount: 1 });
    expect(result).toMatchObject({
      prizePerWinnerMinor: 1000,
      remainderMinor: 0,
      rolloverOutMinor: 0,
    });
  });

  it('an evenly divisible pot has zero remainder', () => {
    const result = allocateTier({ ...base, poolMinor: 900, rolloverInMinor: 0, winnersCount: 3 });
    expect(result).toMatchObject({ prizePerWinnerMinor: 300, remainderMinor: 0 });
  });

  it('ZERO winners on a ROLLING tier (the 5-match jackpot): the whole pot rolls over, nothing paid', () => {
    const result = allocateTier({ ...base, poolMinor: 400, rolloverInMinor: 150, winnersCount: 0 });
    expect(result).toMatchObject({
      prizePerWinnerMinor: 0,
      remainderMinor: 0,
      rolloverOutMinor: 550,
    });
  });

  it('ZERO winners on a NON-rolling tier (4 or 3 matches): nothing is paid and nothing rolls over', () => {
    const result = allocateTier({
      matchCount: 4,
      shareBps: 3500,
      rollsOver: false,
      poolMinor: 350,
      rolloverInMinor: 0,
      winnersCount: 0,
    });
    expect(result).toMatchObject({
      prizePerWinnerMinor: 0,
      remainderMinor: 0,
      rolloverOutMinor: 0,
    });
    expect(result.basePoolMinor).toBe(350); // the unclaimed pool is still recorded, just carried nowhere
  });

  it('a zero pool with zero winners allocates nothing and rolls over nothing', () => {
    const result = allocateTier({ ...base, poolMinor: 0, rolloverInMinor: 0, winnersCount: 0 });
    expect(result).toMatchObject({
      prizePerWinnerMinor: 0,
      remainderMinor: 0,
      rolloverOutMinor: 0,
    });
  });

  it('many winners splitting a small pot: some get 0 if the pot is smaller than the winner count', () => {
    const result = allocateTier({ ...base, poolMinor: 2, rolloverInMinor: 0, winnersCount: 5 });
    expect(result).toMatchObject({ prizePerWinnerMinor: 0, remainderMinor: 2 });
  });

  it('the allocation never exceeds the pot, for a spread of pools and winner counts', () => {
    for (const poolMinor of [0, 1, 2, 3, 7, 100, 1_000_001]) {
      for (const winnersCount of [0, 1, 2, 3, 7, 11]) {
        const result = allocateTier({ ...base, poolMinor, rolloverInMinor: 0, winnersCount });
        const allocated =
          result.prizePerWinnerMinor * winnersCount +
          result.remainderMinor +
          result.rolloverOutMinor;
        expect(
          allocated,
          `pool ${String(poolMinor)} winners ${String(winnersCount)}`,
        ).toBeLessThanOrEqual(poolMinor);
      }
    }
  });
});
