import {
  SCORE_ERROR_CODES,
  type CreateScoreRequest,
  type CreateScoreResponse,
  type ScoreDto,
} from '@gather/shared';
import type { SubscriptionGate } from '../auth/entitlement.js';
import { AppError } from '../errors.js';
import type { ScoreRepository } from './repository.js';

export interface ScoreService {
  list(userId: string): Promise<ScoreDto[]>;
  add(userId: string, input: CreateScoreRequest): Promise<CreateScoreResponse>;
  edit(userId: string, playedOn: string, stablefordScore: number): Promise<ScoreDto>;
  remove(userId: string, playedOn: string): Promise<void>;
}

export interface ScoreServiceDeps {
  repository: ScoreRepository;
  subscriptions: SubscriptionGate;
}

/**
 * Score use-cases. Every method receives the user id of the VERIFIED caller — never anything from a
 * request — so a user can only ever touch their own scores.
 *
 * Access (PRD §03: subscribers "enter / edit golf scores"; §04: non-subscribers get restricted access):
 *   - WRITES (add, edit, delete) need an active subscription, checked afresh on every call (SUB-05).
 *   - READING one's own scores is allowed to any signed-in user, so a lapsed user can still see their
 *     history. Provisional pending D-030 (which features non-subscribers may use).
 */
export function createScoreService({ repository, subscriptions }: ScoreServiceDeps): ScoreService {
  /** Throws 403 unless the user currently has an active subscription. A failed lookup also fails the request. */
  async function requireSubscriber(userId: string): Promise<void> {
    if (!(await subscriptions.isActiveSubscriber(userId))) {
      throw new AppError(
        403,
        SCORE_ERROR_CODES.subscriptionRequired,
        'An active subscription is required to manage scores.',
      );
    }
  }

  const notFound = () =>
    new AppError(404, SCORE_ERROR_CODES.notFound, 'You have no score for that date.');

  return {
    list: (userId) => repository.list(userId),

    async add(userId, input) {
      await requireSubscriber(userId);
      const result = await repository.add(userId, input);
      switch (result.kind) {
        case 'created':
          return { score: result.score, replacedPlayedOn: result.replacedPlayedOn };
        case 'duplicate_date':
          throw new AppError(
            409,
            SCORE_ERROR_CODES.duplicateDate,
            'You already have a score for that date. Edit it instead.',
          );
        case 'too_old':
          throw new AppError(
            422,
            SCORE_ERROR_CODES.tooOld,
            'That date is older than your five most recent scores, so it cannot be added.',
          );
      }
    },

    async edit(userId, playedOn, stablefordScore) {
      await requireSubscriber(userId);
      const score = await repository.update(userId, playedOn, stablefordScore);
      if (!score) throw notFound();
      return score;
    },

    async remove(userId, playedOn) {
      await requireSubscriber(userId);
      if (!(await repository.remove(userId, playedOn))) throw notFound();
    },
  };
}
