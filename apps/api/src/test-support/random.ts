import type { RandomSource } from '../draws/domain.js';

/**
 * A small, deterministic PRNG (mulberry32) for tests: the SAME seed always produces the SAME sequence,
 * so draw-engine tests can assert exact results instead of only "it looks plausible". Never used in
 * production (production uses `Math.random`).
 */
export function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return {
    next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** Replays an exact, fixed sequence of `next()` values — for pinning down one specific decision point. */
export function scriptedRandom(...values: number[]): RandomSource {
  let i = 0;
  return {
    next() {
      const value = values[i % values.length];
      i += 1;
      return value as number;
    },
  };
}
