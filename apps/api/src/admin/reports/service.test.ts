import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryDraws } from '../../test-support/draws.js';
import { InMemoryWinners } from '../../test-support/winners.js';
import { InMemoryAdminReports } from '../../test-support/admin-reports.js';
import { createDrawService, type DrawService } from '../../draws/service.js';
import { createAdminReportsService, type AdminReportsService } from './service.js';

const ADMIN = '99999999-9999-4999-8999-999999999999';
const ALICE = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2027-06-01T00:00:00Z');

let reportsRepo: InMemoryAdminReports;
let drawsRepo: InMemoryDraws;
let winnersRepo: InMemoryWinners;
let drawService: DrawService;
let service: AdminReportsService;

beforeEach(() => {
  reportsRepo = new InMemoryAdminReports();
  drawsRepo = new InMemoryDraws();
  drawsRepo.setPoolBps(1000);
  drawsRepo.setActivePlanCurrency('USD');
  winnersRepo = new InMemoryWinners();
  drawService = createDrawService({ repository: drawsRepo, random: () => ({ next: () => 0.1 }) });
  service = createAdminReportsService({
    reports: reportsRepo,
    draws: drawsRepo,
    winners: winnersRepo,
    now: () => NOW,
  });
});

describe('get (PRD §11 ADM-07)', () => {
  it('everything is zero/empty with no data at all', async () => {
    const { reports } = await service.get();
    expect(reports).toEqual({
      totalUsers: 0,
      activeSubscribers: 0,
      draws: { total: 0, draft: 0, simulated: 0, published: 0 },
      prizePoolByCurrency: [],
      charityContributionsByCurrency: [],
      winners: { total: 0, awaitingProof: 0, pendingReview: 0, approved: 0, rejected: 0, paid: 0 },
      generatedAt: NOW.toISOString(),
    });
  });

  it('reuses the reports repository for total users and charity contributions', async () => {
    reportsRepo.setUserCount(42);
    reportsRepo.setCharityContributions([{ currency: 'USD', amountMinor: 5000 }]);
    const { reports } = await service.get();
    expect(reports.totalUsers).toBe(42);
    expect(reports.charityContributionsByCurrency).toEqual([
      { currency: 'USD', amountMinor: 5000 },
    ]);
  });

  it('reuses the reports repository for the active-subscriber count', async () => {
    reportsRepo.setActiveSubscribers(7);
    expect((await service.get()).reports.activeSubscribers).toBe(7);
  });

  it('reuses DrawRepository.list() (the same data GET /api/admin/draws serves) for draw statistics', async () => {
    drawsRepo.seedEligible(ALICE, [1, 2, 3, 4, 5]);
    drawsRepo.setNumberRange({ min: 1, max: 5 });
    const draft = await drawService.create(ADMIN, { drawMonth: '2027-01-01', mode: 'random' });
    const toSimulate = await drawService.create(ADMIN, { drawMonth: '2027-02-01', mode: 'random' });
    await drawService.simulate(toSimulate.id);
    const toPublish = await drawService.create(ADMIN, { drawMonth: '2027-03-01', mode: 'random' });
    await drawService.simulate(toPublish.id);
    await drawService.publish(toPublish.id, ADMIN);
    void draft;

    const { reports } = await service.get();
    expect(reports.draws).toEqual({ total: 3, draft: 1, simulated: 1, published: 1 });
  });

  it('sums prize_pool_minor for PUBLISHED draws only, by currency — never a draft/simulated one', async () => {
    drawsRepo.seedEligible(ALICE, [1, 2, 3, 4, 5]);
    drawsRepo.setNumberRange({ min: 1, max: 5 });
    drawsRepo.seedPayment({
      basisMinor: 10_000,
      currency: 'USD',
      intervalMonths: 1,
      periodStartMonth: '2027-01-01',
    });
    const published = await drawService.create(ADMIN, { drawMonth: '2027-01-01', mode: 'random' });
    await drawService.simulate(published.id);
    await drawService.publish(published.id, ADMIN);

    const stillSimulated = await drawService.create(ADMIN, {
      drawMonth: '2027-02-01',
      mode: 'random',
    });
    await drawService.simulate(stillSimulated.id); // never published: must NOT be counted

    const { reports } = await service.get();
    expect(reports.prizePoolByCurrency).toEqual([{ currency: 'USD', amountMinor: 1000 }]);
  });

  it('reuses WinnerRepository.listForAdmin() (the same data GET /api/admin/winners serves) for winner statistics', async () => {
    winnersRepo.seedWinner({ userId: ALICE, verificationStatus: 'awaiting_proof' });
    winnersRepo.seedWinner({ userId: ALICE, verificationStatus: 'pending_review' });
    winnersRepo.seedWinner({
      userId: ALICE,
      verificationStatus: 'approved',
      payoutStatus: 'pending',
    });
    winnersRepo.seedWinner({ userId: ALICE, verificationStatus: 'approved', payoutStatus: 'paid' });
    winnersRepo.seedWinner({ userId: ALICE, verificationStatus: 'rejected' });

    const { reports } = await service.get();
    expect(reports.winners).toEqual({
      total: 5,
      awaitingProof: 1,
      pendingReview: 1,
      approved: 2,
      rejected: 1,
      paid: 1,
    });
  });

  it('generatedAt reflects the injected clock — this is a live snapshot, never a cached report', async () => {
    expect((await service.get()).reports.generatedAt).toBe(NOW.toISOString());
  });
});
