import type { AdminReportsDto, AdminReportsResponse } from '@gather/shared';
import type { DrawRepository } from '../../draws/repository.js';
import type { WinnerRepository } from '../../winners/repository.js';
import type { AdminReportsRepository } from './repository.js';

export interface AdminReportsService {
  get(): Promise<AdminReportsResponse>;
}

export interface AdminReportsServiceDeps {
  reports: AdminReportsRepository;
  /** REUSED: the same list a `GET /api/admin/draws` call reads, just summarised by status/currency. */
  draws: DrawRepository;
  /** REUSED: the same list `GET /api/admin/winners` reads, just summarised by status. */
  winners: WinnerRepository;
  now?: () => Date;
}

/** Sums `prize_pool_minor` for PUBLISHED draws only, one entry per currency — never mixed. */
function prizePoolByCurrency(
  draws: { status: string; prizePoolMinor: number | null; currency: string | null }[],
): { currency: string; amountMinor: number }[] {
  const totals = new Map<string, number>();
  for (const d of draws) {
    if (d.status !== 'published' || d.prizePoolMinor === null || d.currency === null) continue;
    const sum = (totals.get(d.currency) ?? 0) + d.prizePoolMinor;
    if (!Number.isSafeInteger(sum)) throw new Error('Prize pool total exceeds safe range');
    totals.set(d.currency, sum);
  }
  return [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amountMinor]) => ({ currency, amountMinor }));
}

/**
 * Admin reports (PRD §11 ADM-07). Every figure is a live count/sum over already-stored facts —
 * nothing is cached, estimated or fabricated (DECISIONS D-074 records the exact definition chosen for
 * each still-open term in D-029). No Stripe data is read directly: prize pool and contribution
 * figures come only from what this system itself already recorded from verified webhooks.
 */
export function createAdminReportsService({
  reports,
  draws,
  winners,
  now = () => new Date(),
}: AdminReportsServiceDeps): AdminReportsService {
  return {
    async get() {
      const [totalUsers, activeSubscribers, contributions, allDraws, allWinners] =
        await Promise.all([
          reports.countUsers(),
          reports.countActiveSubscribers(),
          reports.charityContributionsByCurrency(),
          draws.list(),
          winners.listForAdmin(),
        ]);

      const reportsDto: AdminReportsDto = {
        totalUsers,
        activeSubscribers,
        draws: {
          total: allDraws.length,
          draft: allDraws.filter((d) => d.status === 'draft').length,
          simulated: allDraws.filter((d) => d.status === 'simulated').length,
          published: allDraws.filter((d) => d.status === 'published').length,
        },
        prizePoolByCurrency: prizePoolByCurrency(allDraws),
        charityContributionsByCurrency: contributions,
        winners: {
          total: allWinners.length,
          awaitingProof: allWinners.filter((w) => w.verificationStatus === 'awaiting_proof').length,
          pendingReview: allWinners.filter((w) => w.verificationStatus === 'pending_review').length,
          approved: allWinners.filter((w) => w.verificationStatus === 'approved').length,
          rejected: allWinners.filter((w) => w.verificationStatus === 'rejected').length,
          paid: allWinners.filter((w) => w.payoutStatus === 'paid').length,
        },
        generatedAt: now().toISOString(),
      };
      return { reports: reportsDto };
    },
  };
}
