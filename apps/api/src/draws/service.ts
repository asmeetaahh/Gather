import {
  DRAW_ERROR_CODES,
  type CreateDrawRequest,
  type DrawDetailDto,
  type DrawSummaryDto,
  type ListDrawsResponse,
} from '@gather/shared';
import { AppError } from '../errors.js';
import {
  MixedCurrencyPoolError,
  allocateTier,
  computeMatchCount,
  drawAlgorithmicNumbers,
  drawRandomNumbers,
  poolFromBps,
  poolFromFixedPerSubscriber,
  poolFundingBasisForMonth,
  splitPoolAcrossTiers,
  type RandomSource,
} from './domain.js';
import {
  DrawStateConflictError,
  type DrawDetailRecord,
  type DrawRecord,
  type DrawRepository,
} from './repository.js';

export interface DrawService {
  list(): Promise<ListDrawsResponse>;
  get(id: string): Promise<DrawDetailDto>;
  create(createdBy: string, input: CreateDrawRequest): Promise<DrawDetailDto>;
  /** Computes and atomically writes a candidate snapshot (PRD §06 "simulation"; D-018/D-071). */
  simulate(id: string): Promise<DrawDetailDto>;
  /** Freezes a simulated draw and creates its winners; idempotent (D-071). */
  publish(id: string, publishedBy: string): Promise<DrawDetailDto>;
}

export interface DrawServiceDeps {
  repository: DrawRepository;
  /**
   * A FRESH random source for each `simulate()` call (production: real randomness every time; tests: a
   * seeded or scripted source, for determinism). All other "current time" facts (eligibility,
   * `simulated_at`/`published_at`) are read from the database's own clock inside the SQL functions, so
   * no clock needs to be injected here.
   */
  random?: () => RandomSource;
}

const notFound = () => new AppError(404, DRAW_ERROR_CODES.notFound, 'No such draw exists.');

function toSummaryDto(record: DrawRecord): DrawSummaryDto {
  return { ...record };
}

function toDetailDto(record: DrawDetailRecord): DrawDetailDto {
  return { ...record };
}

export function createDrawService({
  repository,
  random = () => ({ next: () => Math.random() }),
}: DrawServiceDeps): DrawService {
  async function requireDraw(id: string): Promise<DrawDetailRecord> {
    const draw = await repository.findById(id);
    if (!draw) throw notFound();
    return draw;
  }

  /**
   * The prize pool for `drawMonth`, in whichever mode is configured (D-014/D-069/D-070/D-071).
   * Refuses — never guesses — when neither mode is configured, or when a currency genuinely cannot be
   * determined (no funding this month AND no active monthly plan to fall back on).
   */
  async function computePool(
    drawMonth: string,
    activeSubscriberCount: number,
  ): Promise<{
    poolMinor: number;
    currency: string;
    contributionBps: number | null;
    contributionFixedMinor: number | null;
  }> {
    const { pool } = await repository.getSettings();
    if (!pool) {
      throw new AppError(
        422,
        DRAW_ERROR_CODES.poolNotConfigured,
        'The prize pool is not configured. Set platform_settings.prize_pool_bps or prize_pool_per_subscription_minor first.',
      );
    }

    if (pool.kind === 'fixed') {
      const currency = await repository.getActiveMonthlyPlanCurrency();
      if (!currency) {
        throw new AppError(
          422,
          DRAW_ERROR_CODES.poolNotConfigured,
          'No active monthly plan exists to determine the prize pool currency.',
        );
      }
      return {
        poolMinor: poolFromFixedPerSubscriber(activeSubscriberCount, pool.fixedMinor),
        currency,
        contributionBps: null,
        contributionFixedMinor: pool.fixedMinor,
      };
    }

    const payments = await repository.listPaymentBasesFunding(drawMonth);
    let funding;
    try {
      funding = poolFundingBasisForMonth(payments, drawMonth);
    } catch (error) {
      if (error instanceof MixedCurrencyPoolError) {
        throw new AppError(422, DRAW_ERROR_CODES.mixedCurrency, error.message);
      }
      throw error;
    }
    if (funding) {
      return {
        poolMinor: poolFromBps(funding.basisMinor, pool.bps),
        currency: funding.currency,
        contributionBps: pool.bps,
        contributionFixedMinor: null,
      };
    }
    // No subscription payment funds this month at all yet (e.g. the platform's very first draw): the
    // pool is genuinely 0, but a currency is still required (draws_pool_has_currency).
    const currency = await repository.getActiveMonthlyPlanCurrency();
    if (!currency) {
      throw new AppError(
        422,
        DRAW_ERROR_CODES.poolNotConfigured,
        'No subscription payments fund this month yet, and no active monthly plan exists to determine the prize pool currency.',
      );
    }
    return { poolMinor: 0, currency, contributionBps: pool.bps, contributionFixedMinor: null };
  }

  return {
    async list() {
      return { draws: (await repository.list()).map(toSummaryDto) };
    },

    async get(id) {
      return toDetailDto(await requireDraw(id));
    },

    async create(createdBy, input) {
      const result = await repository.create({
        drawMonth: input.drawMonth,
        mode: input.mode,
        createdBy,
      });
      if (result.kind === 'duplicate_month') {
        throw new AppError(
          409,
          DRAW_ERROR_CODES.duplicateMonth,
          'A draw already exists for that month.',
        );
      }
      return toDetailDto({ ...result.draw, winningNumbers: null, tierResults: [] });
    },

    async simulate(id) {
      const draw = await requireDraw(id);
      if (draw.status === 'published') {
        throw new AppError(
          422,
          DRAW_ERROR_CODES.notSimulated,
          'A published draw cannot be re-simulated.',
        );
      }

      const { numberRange } = await repository.getSettings();
      if (!numberRange) {
        throw new AppError(
          422,
          DRAW_ERROR_CODES.poolNotConfigured,
          'The draw number range is not configured. Set platform_settings.draw_number_min/max first.',
        );
      }

      const tickets = await repository.listEligibleTickets();
      const activeSubscriberCount = tickets.size;
      const pool = await computePool(draw.drawMonth, activeSubscriberCount);

      const randomSource = random();
      let winningNumbers: number[];
      if (draw.mode === 'algorithmic') {
        const weights = new Map<number, number>();
        for (const scores of tickets.values()) {
          for (const value of new Set(scores)) weights.set(value, (weights.get(value) ?? 0) + 1);
        }
        winningNumbers = drawAlgorithmicNumbers(numberRange, weights, randomSource);
      } else {
        winningNumbers = drawRandomNumbers(numberRange, randomSource);
      }

      const entries = [...tickets.entries()].map(([userId, scores]) => ({
        userId,
        entryNumbers: scores,
        matchCount: computeMatchCount(scores, winningNumbers),
      }));

      const rolloverIn = await repository.getPriorJackpotRollover(draw.drawMonth);
      const tierResults = splitPoolAcrossTiers(pool.poolMinor).map((tier) => {
        const winnersCount = entries.filter((e) => e.matchCount === tier.matchCount).length;
        const allocation = allocateTier({
          ...tier,
          rolloverInMinor: tier.matchCount === 5 ? rolloverIn : 0,
          winnersCount,
        });
        return {
          matchCount: allocation.matchCount,
          shareBps: allocation.shareBps,
          rollsOver: allocation.rollsOver,
          basePoolMinor: allocation.basePoolMinor,
          rolloverInMinor: allocation.rolloverInMinor,
          winnersCount: allocation.winnersCount,
          prizePerWinnerMinor: allocation.prizePerWinnerMinor,
          remainderMinor: allocation.remainderMinor,
          rolloverOutMinor: allocation.rolloverOutMinor,
        };
      });

      try {
        await repository.simulate({
          drawId: draw.id,
          winningNumbers,
          activeSubscriberCount,
          currency: pool.currency,
          prizePoolMinor: pool.poolMinor,
          poolContributionBps: pool.contributionBps,
          poolContributionFixedMinor: pool.contributionFixedMinor,
          entries,
          tierResults,
        });
      } catch (error) {
        if (error instanceof DrawStateConflictError && error.kind === 'already_published') {
          throw new AppError(
            422,
            DRAW_ERROR_CODES.notSimulated,
            'A published draw cannot be re-simulated.',
          );
        }
        throw error;
      }

      return toDetailDto(await requireDraw(id));
    },

    async publish(id, publishedBy) {
      const draw = await requireDraw(id);
      if (draw.status === 'draft') {
        throw new AppError(
          422,
          DRAW_ERROR_CODES.notSimulated,
          'Simulate this draw before publishing it.',
        );
      }
      try {
        await repository.publish(id, publishedBy);
      } catch (error) {
        if (error instanceof DrawStateConflictError && error.kind === 'not_simulated') {
          throw new AppError(
            422,
            DRAW_ERROR_CODES.notSimulated,
            'Simulate this draw before publishing it.',
          );
        }
        throw error;
      }
      return toDetailDto(await requireDraw(id));
    },
  };
}
