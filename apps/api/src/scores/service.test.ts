import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { FakeSubscriptions, InMemoryScores } from '../test-support/scores.js';
import { createScoreService } from './service.js';

const U = 'user-1';

function setup(subscribed = true) {
  const repository = new InMemoryScores();
  const subscriptions = new FakeSubscriptions();
  if (subscribed) subscriptions.active.add(U);
  return { repository, subscriptions, service: createScoreService({ repository, subscriptions }) };
}

const statusOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof AppError ? `${String(error.status)} ${error.code}` : 'other error';
  }
  return 'ok';
};

describe('score service access rules', () => {
  it('checks the subscription BEFORE any write, on every write', async () => {
    const { service, subscriptions, repository } = setup(false);
    expect(await statusOf(service.add(U, { playedOn: '2026-03-01', stablefordScore: 30 }))).toBe(
      '403 subscription_required',
    );
    expect(await statusOf(service.edit(U, '2026-03-01', 30))).toBe('403 subscription_required');
    expect(await statusOf(service.remove(U, '2026-03-01'))).toBe('403 subscription_required');
    expect(subscriptions.calls).toBe(3);
    expect(repository.calls).toEqual({ list: 0, add: 0, update: 0, remove: 0 });
  });

  it('does not consult the subscription to read', async () => {
    const { service, subscriptions } = setup(false);
    expect(await service.list(U)).toEqual([]);
    expect(subscriptions.calls).toBe(0);
  });

  it('never writes when the entitlement lookup itself fails', async () => {
    const { service, subscriptions, repository } = setup();
    subscriptions.failWith = new Error('down');
    expect(await statusOf(service.add(U, { playedOn: '2026-03-01', stablefordScore: 30 }))).toBe(
      'other error',
    );
    expect(repository.calls.add).toBe(0);
  });
});

describe('score service outcomes', () => {
  it('turns a repository "too old" / "duplicate" into the documented statuses', async () => {
    const { service, repository } = setup();
    for (let d = 1; d <= 5; d++) repository.seed(U, `2026-03-0${String(d)}`, 30);
    expect(await statusOf(service.add(U, { playedOn: '2026-01-01', stablefordScore: 30 }))).toBe(
      '422 score_too_old',
    );
    expect(await statusOf(service.add(U, { playedOn: '2026-03-03', stablefordScore: 30 }))).toBe(
      '409 score_date_exists',
    );
  });

  it('turns a missing score into 404 on edit and on delete', async () => {
    const { service } = setup();
    expect(await statusOf(service.edit(U, '2026-03-01', 30))).toBe('404 score_not_found');
    expect(await statusOf(service.remove(U, '2026-03-01'))).toBe('404 score_not_found');
  });

  it('returns the replaced date so a UI can tell the user which score was dropped', async () => {
    const { service, repository } = setup();
    for (let d = 1; d <= 5; d++) repository.seed(U, `2026-03-0${String(d)}`, 30);
    const result = await service.add(U, { playedOn: '2026-03-06', stablefordScore: 30 });
    expect(result.replacedPlayedOn).toBe('2026-03-01');
  });
});
