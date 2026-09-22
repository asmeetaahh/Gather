import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../errors.js';
import { InMemoryBilling } from '../../test-support/billing.js';
import { InMemoryCharities } from '../../test-support/charities.js';
import { FakeSubscriptions, InMemoryScores } from '../../test-support/scores.js';
import { InMemoryWinners } from '../../test-support/winners.js';
import { createScoreService } from '../../scores/service.js';
import { InMemoryAdminUsers } from '../../test-support/admin-users.js';
import { createAdminUserService, type AdminUserService } from './service.js';

const ALICE = '11111111-1111-4111-8111-111111111111';

let users: InMemoryAdminUsers;
let scoresRepo: InMemoryScores;
let subs: FakeSubscriptions;
let charities: InMemoryCharities;
let billing: InMemoryBilling;
let winners: InMemoryWinners;
let service: AdminUserService;

beforeEach(() => {
  users = new InMemoryAdminUsers();
  scoresRepo = new InMemoryScores();
  subs = new FakeSubscriptions();
  charities = new InMemoryCharities();
  billing = new InMemoryBilling();
  winners = new InMemoryWinners();
  service = createAdminUserService({
    users,
    scores: createScoreService({ repository: scoresRepo, subscriptions: subs }),
    charities,
    billing,
    winners,
  });
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

describe('list (PRD §11 ADM-01)', () => {
  it('is empty with no users', async () => {
    expect(await service.list()).toEqual({ users: [] });
  });

  it('lists a seeded user with their real charity/subscription/score summary', async () => {
    users.seedUser({ id: ALICE, email: 'alice@example.test', charityName: 'Riverside' });
    users.setActiveSubscriber(ALICE, true);
    users.setScoreCount(ALICE, 3);
    const { users: list } = await service.list();
    expect(list).toEqual([
      expect.objectContaining({
        id: ALICE,
        email: 'alice@example.test',
        hasActiveSubscription: true,
        charityName: 'Riverside',
        scoreCount: 3,
      }),
    ]);
  });
});

describe('detail — composes the SAME repositories the user’s own pages use', () => {
  it('404s an unknown user', async () => {
    const err = await rejection(service.detail('00000000-0000-4000-8000-000000000000'));
    expect(err.status).toBe(404);
  });

  it('combines profile, real scores, real subscription, real charity and real winnings', async () => {
    users.seedUser({ id: ALICE });
    scoresRepo.seed(ALICE, '2027-01-01', 30);
    scoresRepo.seed(ALICE, '2027-01-02', 35);
    charities.seedCharity({ name: 'Riverside', slug: 'riverside' });
    const [charityId] = (
      await charities.list({ limit: 1, offset: 0 }, '2027-01-01T00:00:00Z')
    ).charities.map((c) => c.id);
    charities.seedProfile(ALICE, charityId ?? null, 1500);
    const plan = billing.seedPlan({
      name: 'Monthly',
      interval: 'month',
      amountMinor: 1000,
      currency: 'USD',
    });
    billing.seedSubscription({ userId: ALICE, planId: plan.id, stripeSubscriptionId: 'sub_1' });
    winners.seedWinner({ userId: ALICE, matchCount: 3, prizeMinor: 500, currency: 'USD' });

    const detail = await service.detail(ALICE);
    expect(detail.scores).toEqual([
      { id: expect.any(String) as string, playedOn: '2027-01-02', stablefordScore: 35 },
      { id: expect.any(String) as string, playedOn: '2027-01-01', stablefordScore: 30 },
    ]);
    expect(detail.subscription).toMatchObject({ status: 'active', planName: 'Monthly' });
    expect(detail.charity).toMatchObject({ name: 'Riverside' });
    expect(detail.percentageBps).toBe(1500);
    expect(detail.winners).toHaveLength(1);
    expect(detail.winners[0]).toMatchObject({ matchCount: 3, prizeMinor: 500, currency: 'USD' });
  });

  it('a user with nothing yet: null subscription/charity, empty scores/winners', async () => {
    users.seedUser({ id: ALICE });
    const detail = await service.detail(ALICE);
    expect(detail).toMatchObject({
      subscription: null,
      charity: null,
      percentageBps: 0,
      scores: [],
      winners: [],
    });
  });
});

describe('updateDisplayName (PRD §11 ADM-01: "edit user profiles")', () => {
  it('updates the name and returns the full detail', async () => {
    users.seedUser({ id: ALICE, displayName: 'Old Name' });
    const detail = await service.updateDisplayName(ALICE, { displayName: 'New Name' });
    expect(detail.displayName).toBe('New Name');
  });

  it('404s an unknown user, and does not fabricate a row', async () => {
    const err = await rejection(
      service.updateDisplayName('00000000-0000-4000-8000-000000000000', { displayName: 'x' }),
    );
    expect(err.status).toBe(404);
  });
});

describe('score mutations reuse the REAL ScoreService — same subscription rule (SUB-05/D-062)', () => {
  it('an admin adding a score for a NON-subscriber is refused, exactly like the user’s own route would be', async () => {
    // No active subscription seeded for Alice: `subs.active` stays empty, mirroring `ScoreService`'s
    // own rule that writes need an active subscription — this is not bypassed for admins.
    const err = await rejection(
      createScoreService({ repository: scoresRepo, subscriptions: subs }).add(ALICE, {
        playedOn: '2027-01-01',
        stablefordScore: 30,
      }),
    );
    expect(err.status).toBe(403);
  });

  it('an admin adding a score for an active subscriber succeeds, via the exact same service', async () => {
    subs.active.add(ALICE);
    const scoreService = createScoreService({ repository: scoresRepo, subscriptions: subs });
    const result = await scoreService.add(ALICE, { playedOn: '2027-01-01', stablefordScore: 30 });
    expect(result.score.stablefordScore).toBe(30);
  });
});
