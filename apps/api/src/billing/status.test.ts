import { describe, expect, it } from 'vitest';
import { mapProviderStatus } from './status.js';
import { UnprocessableEventError } from './stripe-events.js';

describe('mapProviderStatus — Stripe status → local state (provisional D-068 / D-026)', () => {
  it.each([
    ['active', 'active'],
    ['trialing', 'active'],
    ['incomplete', 'pending'],
    ['past_due', 'lapsed'],
    ['unpaid', 'lapsed'],
    ['paused', 'lapsed'],
    ['incomplete_expired', 'lapsed'],
    ['canceled', 'cancelled'],
  ])('%s → %s', (provider, local) => {
    expect(mapProviderStatus(provider)).toBe(local);
  });

  it.each(['', 'ACTIVE', 'cancelled', 'something_new'])(
    'refuses the unknown status "%s" rather than guessing access',
    (status) => {
      expect(() => mapProviderStatus(status)).toThrow(UnprocessableEventError);
    },
  );
});
