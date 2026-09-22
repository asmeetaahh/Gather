/**
 * Constants that the PRD states explicitly (Digital Heroes PRD v1.0). Only values the PRD
 * defines belong here: anything undecided lives in docs/DECISIONS.md and, where it must be
 * configurable, in the `platform_settings` table — never as a constant.
 *
 * The database enforces the same values with constraints; supabase/tests verifies that these
 * constants and the migrated schema agree.
 */

/** PRD §05: score range 1-45 (Stableford). */
export const SCORE_MIN = 1;
export const SCORE_MAX = 45;

/** PRD §05: "Only the latest 5 scores are retained at any time". */
export const MAX_RETAINED_SCORES = 5;

/** Percentages are integer basis points: 1% = 100, 100% = 10000. */
export const BPS_DENOMINATOR = 10_000;

/** PRD §08: "Minimum contribution: 10% of subscription fee". */
export const MIN_CHARITY_BPS = 1_000;

/**
 * Numbers in a draw. DERIVED, not stated: the PRD never says "5 numbers"; it defines a
 * "5-number match" as the top prize tier, which implies a 5-number draw (see PRD_NOTES.md).
 */
export const DRAW_NUMBER_COUNT = 5;

/** PRD §07 prize pool logic, highest tier first. */
export const PRIZE_TIERS = [
  { matchCount: 5, shareBps: 4_000, rollsOver: true },
  { matchCount: 4, shareBps: 3_500, rollsOver: false },
  { matchCount: 3, shareBps: 2_500, rollsOver: false },
] as const;
