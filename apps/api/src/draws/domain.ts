import { BPS_DENOMINATOR, DRAW_NUMBER_COUNT, PRIZE_TIERS } from '@gather/shared';

/**
 * PURE domain functions for the draw engine (PRD §06/§07): number generation, matching, pool and tier
 * maths, and rollover. Nothing here does I/O — every function takes its inputs explicitly (including the
 * clock and the random source), so the whole engine is deterministic and testable without a database.
 * "Domain modules are pure functions with the clock and random source passed in" (docs/ARCHITECTURE.md).
 *
 * The specific rules encoded below are DECISIONS D-071 (2026-09-22): see docs/DECISIONS.md for exactly
 * what the PRD states, what the owner decided, and what is this codebase's own implementation choice.
 */

// ---- Number generation (DRW-04; D-012/D-071: range 1-45, five DISTINCT numbers) ----------------

export interface NumberRange {
  /** Inclusive. From `platform_settings.draw_number_min` (D-012/D-071). */
  min: number;
  /** Inclusive. From `platform_settings.draw_number_max`. */
  max: number;
}

/** Injected so draws are deterministic under test — a seeded PRNG in tests, `Math.random` in production. */
export interface RandomSource {
  /** A float in [0, 1), like `Math.random()`. */
  next(): number;
}

function rangeSize(range: NumberRange): number {
  const size = range.max - range.min + 1;
  if (size < DRAW_NUMBER_COUNT) {
    throw new RangeError(
      `The draw range [${String(range.min)}, ${String(range.max)}] holds fewer than ${String(DRAW_NUMBER_COUNT)} numbers.`,
    );
  }
  return size;
}

/**
 * PRD §06: Random mode is "standard lottery-style" — DRAW_NUMBER_COUNT distinct integers drawn uniformly
 * from `range`, without replacement (D-071). A partial Fisher-Yates shuffle: each draw is O(range size).
 */
export function drawRandomNumbers(range: NumberRange, random: RandomSource): number[] {
  const size = rangeSize(range);
  const pool = Array.from({ length: size }, (_, i) => range.min + i);
  const picked: number[] = [];
  for (let i = 0; i < DRAW_NUMBER_COUNT; i++) {
    const j = i + Math.floor(random.next() * (pool.length - i));
    const a = pool[i] as number;
    const b = pool[j] as number;
    pool[i] = b;
    pool[j] = a;
    picked.push(b);
  }
  return picked.sort((a, b) => a - b);
}

/**
 * PRD §06: Algorithmic mode is "weighted by score frequency" (D-071): the probability of drawing a
 * number is proportional to `weights.get(number)` — how many eligible users currently have it in their
 * ticket (see `ticketOf`). Selection is weighted sampling WITHOUT replacement (each round removes the
 * chosen value and re-normalises). A number with weight 0 (or absent from `weights`) can still be picked
 * — but only once every positively-weighted number has already been chosen — falling back to a uniform
 * random choice among the remaining zero-weight numbers, so a draw is always exactly
 * `DRAW_NUMBER_COUNT` distinct numbers even when very few distinct scores exist in the population.
 */
export function drawAlgorithmicNumbers(
  range: NumberRange,
  weights: ReadonlyMap<number, number>,
  random: RandomSource,
): number[] {
  const size = rangeSize(range);
  const candidates = Array.from({ length: size }, (_, i) => {
    const value = range.min + i;
    return { value, weight: weights.get(value) ?? 0 };
  });
  const picked: number[] = [];
  for (let round = 0; round < DRAW_NUMBER_COUNT; round++) {
    const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
    let index: number;
    if (totalWeight > 0) {
      let r = random.next() * totalWeight;
      index = candidates.findIndex((c) => {
        r -= c.weight;
        return r < 0;
      });
      if (index === -1) index = candidates.length - 1; // floating-point safety net
    } else {
      index = Math.floor(random.next() * candidates.length);
    }
    picked.push((candidates[index] as { value: number }).value);
    candidates.splice(index, 1);
  }
  return picked.sort((a, b) => a - b);
}

// ---- Matching (DRW-03; D-011/D-071: ticket = distinct scores, order-independent, highest tier only) --

/**
 * A user's ticket for one draw (D-071): the DISTINCT values among their (up to five) latest Stableford
 * scores — a user with fewer than five scores simply has a smaller ticket (D-016), and one who scored the
 * same value twice contributes it once (a set, matching "matching is order-independent").
 */
export function ticketOf(scores: readonly number[]): number[] {
  return [...new Set(scores)];
}

/**
 * How many of the winning numbers are in the ticket (0-5). Order-independent set membership (D-011/
 * D-071): position never matters, and a value present more than once (impossible in a ticket or a draw,
 * both already deduplicated) would still only ever count once. The highest PRIZE TIER a match_count of N
 * qualifies for is decided by the caller comparing against the tier table — this function only counts.
 */
export function computeMatchCount(
  ticket: readonly number[],
  winningNumbers: readonly number[],
): number {
  const drawn = new Set(winningNumbers);
  let count = 0;
  for (const value of new Set(ticket)) if (drawn.has(value)) count++;
  return count;
}

// ---- Prize pool funding (DRW-07; D-014/D-069/D-070/D-071) ---------------------------------------

/** Raised when payments funding the same month's pool are not all in one currency (cannot be summed). */
export class MixedCurrencyPoolError extends Error {
  constructor(readonly currencies: readonly string[]) {
    super(
      `The payments funding this draw's pool are in more than one currency: ${currencies.join(', ')}.`,
    );
    this.name = 'MixedCurrencyPoolError';
  }
}

export interface PaymentBasis {
  /** The basis recorded with the payment's charity contribution (D-069/D-070): before tax, gross of fees. */
  basisMinor: number;
  currency: string;
  /** 1 for a monthly-interval subscription payment, 12 for a yearly one. */
  intervalMonths: 1 | 12;
  /** First day of the calendar month the payment's covered period STARTS in, `YYYY-MM-01`, UTC. */
  periodStartMonth: string;
}

function monthIndex(firstOfMonth: string): number {
  const [year, month] = firstOfMonth.split('-').map(Number);
  return (year as number) * 12 + ((month as number) - 1);
}

/**
 * `YYYY-MM-01` for the UTC calendar month containing `date` (D-071: timestamps are UTC, PRD_NOTES ASM-08).
 */
export function toMonthKey(date: Date): string {
  return `${String(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * How much of ONE payment's basis funds `drawMonth`'s pool (D-070/D-071, extending the owner's locked
 * "1/12 of the applicable basis per covered monthly draw" rule): a monthly payment's WHOLE basis funds
 * the one month its period starts in (the N=1 case); a yearly payment's basis is split into twelve EQUAL
 * monthly shares — floor division, with the remainder placed in the first covered month — across the
 * twelve consecutive months starting at its period's start month. Zero for a month the payment does not
 * cover.
 */
export function monthlyPoolShare(payment: PaymentBasis, drawMonth: string): bigint {
  const offset = monthIndex(drawMonth) - monthIndex(payment.periodStartMonth);
  if (offset < 0 || offset >= payment.intervalMonths) return 0n;
  const interval = BigInt(payment.intervalMonths);
  const basis = BigInt(payment.basisMinor);
  const share = basis / interval;
  return offset === 0 ? share + (basis % interval) : share;
}

export interface PoolFunding {
  basisMinor: number;
  currency: string;
}

/**
 * The total basis funding `drawMonth`'s pool from already-collected subscription payments. `null` when
 * nothing funds this month at all (no payments, or none whose period covers it). Throws
 * `MixedCurrencyPoolError` if the contributing payments are not all in one currency — this system has no
 * FX conversion, so it refuses rather than silently choosing one or discarding data.
 */
export function poolFundingBasisForMonth(
  payments: readonly PaymentBasis[],
  drawMonth: string,
): PoolFunding | null {
  let totalMinor = 0n;
  const currencies = new Set<string>();
  for (const payment of payments) {
    const share = monthlyPoolShare(payment, drawMonth);
    if (share === 0n) continue;
    currencies.add(payment.currency);
    totalMinor += share;
  }
  if (currencies.size > 1) throw new MixedCurrencyPoolError([...currencies].sort());
  const [currency] = currencies;
  if (currency === undefined) return null;
  return { basisMinor: Number(totalMinor), currency };
}

/**
 * Pool size in `platform_settings.prize_pool_bps` mode (D-014/D-069/D-070): the configured percentage of
 * the basis actually funding this month, ROUNDED DOWN — the platform is never on the hook for more than
 * the percentage strictly implies (the opposite rounding from the charity share, D-070, which instead
 * protects the recipient's minimum; here there is no equivalent party to protect).
 */
export function poolFromBps(basisMinor: number, poolBps: number): number {
  return Number((BigInt(basisMinor) * BigInt(poolBps)) / BigInt(BPS_DENOMINATOR));
}

/** Pool size in `platform_settings.prize_pool_per_subscription_minor` mode (DRW-07: "active subscriber count"). */
export function poolFromFixedPerSubscriber(
  activeSubscriberCount: number,
  perSubscriptionMinor: number,
): number {
  return activeSubscriberCount * perSubscriptionMinor;
}

// ---- Tier split and equal winner split (DRW-08/09; D-020/D-071) --------------------------------

export interface TierShare {
  matchCount: 3 | 4 | 5;
  shareBps: number;
  rollsOver: boolean;
  /** This draw's own share of the pool for the tier (floor; see `splitPoolAcrossTiers`). */
  poolMinor: number;
}

/**
 * Splits the total prize pool across the three tiers by their configured shares (PRD §07: 40/35/25,
 * `prize_tiers`), each tier's share rounded DOWN. Up to two minor units of the total may be left
 * unallocated to any tier as a result (three shares, each floored) — an implementation detail (D-071),
 * distinct from D-020's "equal split among winners" remainder handled separately by `allocateTier`.
 */
export function splitPoolAcrossTiers(
  prizePoolMinor: number,
  tiers: readonly (typeof PRIZE_TIERS)[number][] = PRIZE_TIERS,
): TierShare[] {
  return tiers.map((tier) => ({
    matchCount: tier.matchCount,
    shareBps: tier.shareBps,
    rollsOver: tier.rollsOver,
    poolMinor: poolFromBps(prizePoolMinor, tier.shareBps),
  }));
}

export interface TierAllocationInput {
  matchCount: 3 | 4 | 5;
  shareBps: number;
  rollsOver: boolean;
  /** This draw's own share of the pool for the tier (from `splitPoolAcrossTiers`). */
  poolMinor: number;
  /** Carried in from an earlier draw's unclaimed jackpot; always 0 for a tier that does not roll over. */
  rolloverInMinor: number;
  winnersCount: number;
}

export interface TierAllocationResult extends TierAllocationInput {
  basePoolMinor: number;
  prizePerWinnerMinor: number;
  remainderMinor: number;
  rolloverOutMinor: number;
}

/**
 * One tier's full allocation (PRD §07/§08 DRW-06/08; D-019/D-020/D-071):
 *   - with winners: the tier's pot (its own pool share + any rollover in) is split EQUALLY, rounded
 *     DOWN per winner; the leftover minor units are recorded as `remainderMinor` and paid to no one
 *     (D-020: the schema's own neutral field for exactly this, deliberately not distributed further).
 *   - with ZERO winners: nothing is paid; if the tier rolls over (only the 5-match jackpot, DRW-06) the
 *     WHOLE pot carries forward as `rolloverOutMinor` ("if unclaimed" — D-019's synchronous, at-publish
 *     reading: zero winners at publish time; a winner who later fails verification is a separate,
 *     still-open question, D-019, not decided by this function). A non-rolling tier's unclaimed pot is
 *     simply recorded (`basePoolMinor`) and carried nowhere.
 */
export function allocateTier(input: TierAllocationInput): TierAllocationResult {
  const pot = input.poolMinor + input.rolloverInMinor;
  if (input.winnersCount > 0) {
    const prizePerWinner = Math.floor(pot / input.winnersCount);
    return {
      ...input,
      basePoolMinor: input.poolMinor,
      prizePerWinnerMinor: prizePerWinner,
      remainderMinor: pot - prizePerWinner * input.winnersCount,
      rolloverOutMinor: 0,
    };
  }
  return {
    ...input,
    basePoolMinor: input.poolMinor,
    prizePerWinnerMinor: 0,
    remainderMinor: 0,
    rolloverOutMinor: input.rollsOver ? pot : 0,
  };
}
