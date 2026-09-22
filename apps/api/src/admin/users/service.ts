import {
  ADMIN_USER_ERROR_CODES,
  type AdminUserDetailDto,
  type AdminUserSummaryDto,
  type ListAdminUsersResponse,
  type UpdateAdminUserRequest,
} from '@gather/shared';
import type { BillingRepository } from '../../billing/repository.js';
import type { CharityRepository } from '../../charities/repository.js';
import { AppError } from '../../errors.js';
import type { ScoreService } from '../../scores/service.js';
import type { WinnerRepository } from '../../winners/repository.js';
import type { AdminUserRepository, AdminUserRow } from './repository.js';

export interface AdminUserService {
  list(): Promise<ListAdminUsersResponse>;
  detail(id: string): Promise<AdminUserDetailDto>;
  updateDisplayName(id: string, request: UpdateAdminUserRequest): Promise<AdminUserDetailDto>;
}

export interface AdminUserServiceDeps {
  users: AdminUserRepository;
  /** REUSED, not duplicated: the exact same subscription-checked add/edit/remove Phase 3 built. */
  scores: ScoreService;
  charities: CharityRepository;
  billing: BillingRepository;
  winners: WinnerRepository;
}

const notFound = () => new AppError(404, ADMIN_USER_ERROR_CODES.notFound, 'No such user exists.');

function toSummaryDto(row: AdminUserRow): AdminUserSummaryDto {
  return { ...row };
}

/**
 * Admin user use-cases (PRD §11 ADM-01: "view and edit user profiles; edit golf scores; manage
 * subscriptions"). Score edits go through the real `ScoreService` at `req.params.id`, not the caller's
 * own id — the ONLY difference from the user's own `/api/scores` routes is WHOSE id is used, never the
 * rule itself (an admin editing a lapsed user's scores still needs that user to be an active
 * subscriber, exactly as SUB-05/D-062 already require — this endpoint does not invent an admin bypass).
 * "Manage subscriptions" is read-only here: subscription state is driven only by verified Stripe
 * webhooks (D-068/D-070), so nothing lets an admin set it directly — inventing that would contradict an
 * existing decision, not merely extend it.
 */
export function createAdminUserService({
  users,
  scores,
  charities,
  billing,
  winners,
}: AdminUserServiceDeps): AdminUserService {
  async function detailFor(row: AdminUserRow): Promise<AdminUserDetailDto> {
    const [subscription, preference, myScores, myWinners] = await Promise.all([
      billing.findCurrentSubscription(row.id),
      charities.getPreference(row.id),
      scores.list(row.id),
      winners.listForUser(row.id),
    ]);
    return {
      ...row,
      subscription: subscription && {
        status: subscription.status,
        planName: subscription.planName,
        currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      },
      charity: preference?.charity
        ? {
            id: preference.charity.id,
            name: preference.charity.name,
            isArchived: preference.charity.isArchived,
          }
        : null,
      percentageBps: preference?.percentageBps ?? 0,
      scores: myScores.map((s) => ({
        id: s.id,
        playedOn: s.playedOn,
        stablefordScore: s.stablefordScore,
      })),
      winners: myWinners.map((w) => ({
        id: w.id,
        drawMonth: w.drawMonth,
        matchCount: w.matchCount,
        prizeMinor: w.prizeMinor,
        currency: w.currency,
        verificationStatus: w.verificationStatus,
        payoutStatus: w.payoutStatus,
      })),
    };
  }

  return {
    async list() {
      return { users: (await users.list()).map(toSummaryDto) };
    },

    async detail(id) {
      const row = await users.findById(id);
      if (!row) throw notFound();
      return detailFor(row);
    },

    async updateDisplayName(id, request) {
      const row = await users.updateDisplayName(id, request.displayName);
      if (!row) throw notFound();
      return detailFor(row);
    },
  };
}
