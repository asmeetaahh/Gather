import { beforeEach, describe, expect, it } from 'vitest';
import { DRAW_ERROR_CODES } from '@gather/shared';
import { AppError } from '../errors.js';
import { InMemoryDraws } from '../test-support/draws.js';
import { scriptedRandom, seededRandom } from '../test-support/random.js';
import { createDrawService, type DrawService } from './service.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';
const ADMIN = '99999999-9999-4999-8999-999999999999';

let repo: InMemoryDraws;
let service: DrawService;

function build(random?: () => { next(): number }) {
  return createDrawService({ repository: repo, ...(random && { random }) });
}

beforeEach(() => {
  repo = new InMemoryDraws();
  repo.setPoolBps(1000); // 10% of collected basis, so tests have a real pool by default
  service = build(() => seededRandom(1));
});

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('expected the call to be rejected');
}

describe('create (DRW-01/41: one draw per calendar month)', () => {
  it('creates a draft draw', async () => {
    const draw = await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    expect(draw).toMatchObject({
      drawMonth: '2026-11-01',
      mode: 'random',
      status: 'draft',
      winningNumbers: null,
      tierResults: [],
    });
  });

  it('409s a second draw for the same month', async () => {
    await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    const err = await rejection(
      service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'algorithmic' }),
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe(DRAW_ERROR_CODES.duplicateMonth);
  });

  it('different months do not conflict', async () => {
    await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    await expect(
      service.create(ADMIN, { drawMonth: '2026-12-01', mode: 'random' }),
    ).resolves.toBeDefined();
  });
});

describe('get / list', () => {
  it('404s for an unknown draw', async () => {
    const err = await rejection(service.get('00000000-0000-4000-8000-00000000dead'));
    expect(err.status).toBe(404);
    expect(err.code).toBe(DRAW_ERROR_CODES.notFound);
  });

  it('lists newest month first', async () => {
    await service.create(ADMIN, { drawMonth: '2026-09-01', mode: 'random' });
    await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    await service.create(ADMIN, { drawMonth: '2026-10-01', mode: 'random' });
    const { draws } = await service.list();
    expect(draws.map((d) => d.drawMonth)).toEqual(['2026-11-01', '2026-10-01', '2026-09-01']);
  });
});

describe('simulate — configuration preconditions (D-012/D-014/D-071: refuse, never guess)', () => {
  it('refuses when the draw number range is not configured', async () => {
    repo.setNumberRange(null);
    const draw = await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    const err = await rejection(service.simulate(draw.id));
    expect(err.status).toBe(422);
  });

  it('refuses when neither prize-pool mode is configured', async () => {
    repo.clearPool();
    const draw = await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    const err = await rejection(service.simulate(draw.id));
    expect(err.status).toBe(422);
    expect(err.code).toBe(DRAW_ERROR_CODES.poolNotConfigured);
  });

  it('refuses bps mode when nothing funds the month and no active plan exists for a currency', async () => {
    const draw = await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    const err = await rejection(service.simulate(draw.id)); // no payments seeded, no active plan
    expect(err.status).toBe(422);
    expect(err.code).toBe(DRAW_ERROR_CODES.poolNotConfigured);
  });

  it('bps mode with no funding but a configured active plan currency: pool is exactly zero', async () => {
    repo.setActivePlanCurrency('USD');
    const draw = await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    const result = await service.simulate(draw.id);
    expect(result.prizePoolMinor).toBe(0);
    expect(result.currency).toBe('USD');
  });

  it('refuses fixed mode when no active monthly plan exists to determine currency', async () => {
    repo.clearPool();
    repo.setPoolFixed(500);
    const draw = await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    const err = await rejection(service.simulate(draw.id));
    expect(err.status).toBe(422);
  });

  it('refuses when payments funding the month are in more than one currency', async () => {
    repo.seedPayment({
      basisMinor: 1000,
      currency: 'USD',
      intervalMonths: 1,
      periodStartMonth: '2026-11-01',
    });
    repo.seedPayment({
      basisMinor: 1000,
      currency: 'EUR',
      intervalMonths: 1,
      periodStartMonth: '2026-11-01',
    });
    const draw = await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    const err = await rejection(service.simulate(draw.id));
    expect(err.status).toBe(422);
    expect(err.code).toBe(DRAW_ERROR_CODES.mixedCurrency);
  });
});

describe('simulate — eligibility and pool funding (D-014/D-016/D-069/D-070/D-071)', () => {
  it('computes the pool from bps × the basis actually funding the month', async () => {
    repo.seedPayment({
      basisMinor: 10_000,
      currency: 'GBP',
      intervalMonths: 1,
      periodStartMonth: '2026-11-01',
    });
    const draw = await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    const result = await service.simulate(draw.id);
    expect(result).toMatchObject({
      prizePoolMinor: 1000,
      currency: 'GBP',
      activeSubscriberCount: 0,
    });
  });

  it('a yearly payment funds THIS month with its 1/12 share (D-070)', async () => {
    repo.seedPayment({
      basisMinor: 12_000,
      currency: 'USD',
      intervalMonths: 12,
      periodStartMonth: '2026-01-01',
    });
    const draw = await service.create(ADMIN, { drawMonth: '2026-06-01', mode: 'random' });
    const result = await service.simulate(draw.id);
    expect(result.prizePoolMinor).toBe(100); // 10% of 1000 (12000/12)
  });

  it('computes the pool from the fixed-per-subscriber setting × active subscriber count', async () => {
    repo.clearPool();
    repo.setPoolFixed(200);
    repo.setActivePlanCurrency('USD');
    repo.seedEligible(ALICE, [30]);
    repo.seedEligible(BOB, [25]);
    const draw = await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    const result = await service.simulate(draw.id);
    expect(result).toMatchObject({ prizePoolMinor: 400, activeSubscriberCount: 2 });
  });

  it('every active subscriber gets an entry, even with zero scores', async () => {
    repo.seedEligible(ALICE, []);
    repo.setActivePlanCurrency('USD');
    const draw = await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    const result = await service.simulate(draw.id);
    expect(result.activeSubscriberCount).toBe(1);
  });

  it('a user with fewer than five scores can still win, just never the 5-match tier if their ticket is smaller (D-016)', async () => {
    repo.setNumberRange({ min: 1, max: 5 }); // draw is always {1,2,3,4,5}
    repo.seedEligible(ALICE, [1, 2, 3]); // only 3 scores: cannot reach a 4 or 5 match
    repo.setActivePlanCurrency('USD');
    const draw = await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    const result = await service.simulate(draw.id);
    expect(result.tierResults.find((t) => t.matchCount === 3)?.winnersCount).toBe(1);
    expect(result.tierResults.find((t) => t.matchCount === 5)?.winnersCount).toBe(0);
  });
});

describe('simulate — random vs algorithmic mode', () => {
  it('random mode ignores score frequency entirely', async () => {
    repo.setNumberRange({ min: 1, max: 6 });
    repo.seedEligible(ALICE, [1, 1, 1, 1, 1]); // even if everyone scored 1, random mode need not favour it
    repo.setActivePlanCurrency('USD');
    const draw = await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    const s = build(() => scriptedRandom(0.9999, 0, 0, 0, 0));
    const result = await s.simulate(draw.id);
    expect(result.winningNumbers).toEqual([2, 3, 4, 5, 6]); // matches the hand-traced domain test exactly
  });

  it('algorithmic mode is weighted by the CURRENT eligible population’s score frequency', async () => {
    let sevenHits = 0;
    for (let seed = 0; seed < 50; seed++) {
      const trial = new InMemoryDraws();
      trial.setPoolBps(1000);
      trial.setActivePlanCurrency('USD');
      trial.setNumberRange({ min: 1, max: 10 });
      trial.seedEligible(ALICE, [7]);
      trial.seedEligible(BOB, [7]);
      trial.seedEligible(CAROL, [7]);
      const trialService = createDrawService({
        repository: trial,
        random: () => seededRandom(seed),
      });
      const draw = await trialService.create(ADMIN, {
        drawMonth: '2026-11-01',
        mode: 'algorithmic',
      });
      const result = await trialService.simulate(draw.id);
      if (result.winningNumbers?.includes(7)) sevenHits++;
    }
    expect(sevenHits).toBe(50); // weight 3 vs. nine numbers at weight 0: certain
  });
});

describe('simulate — snapshot immutability (D-071: later score changes cannot alter a historical draw)', () => {
  it('re-fetching after scores change shows the ORIGINAL simulated snapshot, not the new scores', async () => {
    repo.setNumberRange({ min: 1, max: 5 });
    repo.seedEligible(ALICE, [1, 2, 3]);
    repo.setActivePlanCurrency('USD');
    const draw = await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    const first = await service.simulate(draw.id);
    const firstEntryMatch = first.tierResults.find((t) => t.matchCount === 3)?.winnersCount;

    // Alice's scores change AFTER the simulation ran.
    repo.seedEligible(ALICE, [4, 5]);

    const stillSame = await service.get(draw.id);
    expect(stillSame.tierResults.find((t) => t.matchCount === 3)?.winnersCount).toBe(
      firstEntryMatch,
    );
    expect(stillSame.winningNumbers).toEqual(first.winningNumbers);
  });

  it('re-simulating explicitly DOES pick up the new scores (replaces the candidate snapshot, D-018)', async () => {
    repo.setNumberRange({ min: 1, max: 5 });
    repo.seedEligible(ALICE, [1, 2, 3]);
    repo.setActivePlanCurrency('USD');
    const draw = await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    await service.simulate(draw.id);
    repo.seedEligible(ALICE, [1, 2, 3, 4, 5]); // now a perfect ticket
    const resimulated = await service.simulate(draw.id);
    expect(resimulated.tierResults.find((t) => t.matchCount === 5)?.winnersCount).toBe(1);
  });

  it('once PUBLISHED, re-simulating is refused entirely, whatever scores do afterward', async () => {
    repo.setNumberRange({ min: 1, max: 5 });
    repo.seedEligible(ALICE, [1, 2, 3, 4, 5]);
    repo.setActivePlanCurrency('USD');
    const draw = await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    await service.simulate(draw.id);
    await service.publish(draw.id, ADMIN);
    const err = await rejection(service.simulate(draw.id));
    expect(err.status).toBe(422);
    expect(repo.calls.simulate).toBe(1); // the repository was never asked to overwrite published data
  });
});

describe('multiple winners, zero winners, tiers (DRW-06/08/09; D-019/D-020/D-071)', () => {
  it('splits a tier equally among several winners, with the remainder unpaid', async () => {
    repo.setNumberRange({ min: 1, max: 5 });
    repo.setPoolBps(10_000); // 100% of basis -> an exact, easy-to-check pool
    repo.seedPayment({
      basisMinor: 1000,
      currency: 'USD',
      intervalMonths: 1,
      periodStartMonth: '2026-11-01',
    });
    for (const [id, ticket] of [
      [ALICE, [1, 2, 3]],
      [BOB, [1, 2, 3]],
      [CAROL, [1, 2, 3]],
    ] as const) {
      repo.seedEligible(id, [...ticket]);
    }
    const draw = await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    const result = await service.simulate(draw.id);
    const tier3 = result.tierResults.find((t) => t.matchCount === 3);
    expect(tier3?.winnersCount).toBe(3);
    expect(tier3?.basePoolMinor).toBe(250); // 25% of the 1000 pool
    expect(tier3?.prizePerWinnerMinor).toBe(83);
    expect(tier3?.remainderMinor).toBe(1); // 250 - 83*3
  });

  it('NO 5-match winner: the whole jackpot share rolls over, and the next draw inherits it (DRW-06)', async () => {
    repo.setNumberRange({ min: 1, max: 5 });
    repo.setPoolBps(10_000);
    repo.seedPayment({
      basisMinor: 1000,
      currency: 'USD',
      intervalMonths: 1,
      periodStartMonth: '2026-11-01',
    });
    repo.seedEligible(ALICE, [1, 2, 3]); // only a 3-match, never a 5-match
    const draw = await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    const result = await service.simulate(draw.id);
    const tier5 = result.tierResults.find((t) => t.matchCount === 5);
    expect(tier5).toMatchObject({ winnersCount: 0, prizePerWinnerMinor: 0, rolloverOutMinor: 400 });

    // The rollover carries into the NEXT month's draw, via the real getPriorJackpotRollover lookup.
    await service.publish(draw.id, ADMIN);
    repo.seedPayment({
      basisMinor: 1000,
      currency: 'USD',
      intervalMonths: 1,
      periodStartMonth: '2026-12-01',
    });
    const next = await service.create(ADMIN, { drawMonth: '2026-12-01', mode: 'random' });
    const nextResult = await service.simulate(next.id);
    expect(nextResult.tierResults.find((t) => t.matchCount === 5)?.rolloverInMinor).toBe(400);
  });

  it('a zero-winner NON-rolling tier (4 or 3 matches) carries nowhere: it is simply unclaimed', async () => {
    repo.setNumberRange({ min: 1, max: 5 });
    repo.setPoolBps(10_000);
    repo.seedPayment({
      basisMinor: 1000,
      currency: 'USD',
      intervalMonths: 1,
      periodStartMonth: '2026-11-01',
    });
    // No eligible users at all: every tier has zero winners.
    const draw = await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    const result = await service.simulate(draw.id);
    const tier4 = result.tierResults.find((t) => t.matchCount === 4);
    const tier3 = result.tierResults.find((t) => t.matchCount === 3);
    expect(tier4).toMatchObject({ winnersCount: 0, rolloverOutMinor: 0 });
    expect(tier3).toMatchObject({ winnersCount: 0, rolloverOutMinor: 0 });
  });

  it('a WON jackpot does not roll over — the pot is distributed, not carried forward', async () => {
    repo.setNumberRange({ min: 1, max: 5 });
    repo.setPoolBps(10_000);
    repo.seedPayment({
      basisMinor: 1000,
      currency: 'USD',
      intervalMonths: 1,
      periodStartMonth: '2026-11-01',
    });
    repo.seedEligible(ALICE, [1, 2, 3, 4, 5]);
    const draw = await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    const result = await service.simulate(draw.id);
    const tier5 = result.tierResults.find((t) => t.matchCount === 5);
    expect(tier5).toMatchObject({ winnersCount: 1, prizePerWinnerMinor: 400, rolloverOutMinor: 0 });
  });
});

describe('publish (DRW-05; D-018/D-045/D-071: DRAFT → SIMULATED → PUBLISHED, atomic, idempotent)', () => {
  async function simulatedDraw() {
    repo.setNumberRange({ min: 1, max: 5 });
    repo.setPoolBps(10_000);
    repo.seedPayment({
      basisMinor: 1000,
      currency: 'USD',
      intervalMonths: 1,
      periodStartMonth: '2026-11-01',
    });
    repo.seedEligible(ALICE, [1, 2, 3, 4, 5]);
    const draw = await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    await service.simulate(draw.id);
    return draw.id;
  }

  it('refuses to publish a draft that was never simulated — the lifecycle cannot be skipped', async () => {
    const draw = await service.create(ADMIN, { drawMonth: '2026-11-01', mode: 'random' });
    const err = await rejection(service.publish(draw.id, ADMIN));
    expect(err.status).toBe(422);
    expect(err.code).toBe(DRAW_ERROR_CODES.notSimulated);
    expect(repo.calls.publish).toBe(0); // never even asked the repository
  });

  it('publishes a simulated draw and creates the winners', async () => {
    const id = await simulatedDraw();
    const result = await service.publish(id, ADMIN);
    expect(result.status).toBe('published');
    expect(repo.winnersOf(id)).toEqual([
      { drawId: id, userId: ALICE, matchCount: 5, prizeMinor: 400 },
    ]);
  });

  it('is IDEMPOTENT: a second publish call changes nothing and creates no second set of winners', async () => {
    const id = await simulatedDraw();
    await service.publish(id, ADMIN);
    const before = repo.winnersOf(id);
    await service.publish(id, ADMIN);
    expect(repo.winnersOf(id)).toEqual(before);
    expect(repo.calls.publish).toBe(2); // both calls reached the repository; the second changed nothing
  });

  it('handles CONCURRENT publish attempts without duplicating winners', async () => {
    const id = await simulatedDraw();
    await Promise.all([
      service.publish(id, ADMIN),
      service.publish(id, ADMIN),
      service.publish(id, ADMIN),
    ]);
    expect(repo.winnersOf(id)).toHaveLength(1);
  });

  it('404s for an unknown draw', async () => {
    const err = await rejection(service.publish('00000000-0000-4000-8000-00000000dead', ADMIN));
    expect(err.status).toBe(404);
  });

  it('a published draw is visibly immutable through the read API (its own fields do not change again)', async () => {
    const id = await simulatedDraw();
    const first = await service.publish(id, ADMIN);
    const again = await service.get(id);
    expect(again).toEqual(first);
  });
});
