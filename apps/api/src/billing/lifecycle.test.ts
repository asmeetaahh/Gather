import { beforeEach, describe, expect, it } from 'vitest';
import { BILLING_ERROR_CODES } from '@gather/shared';
import { createCharityService } from '../charities/service.js';
import { AppError } from '../errors.js';
import { InMemoryCharities } from '../test-support/charities.js';
import { FakeGateway, FakeSelection, InMemoryBilling } from '../test-support/billing.js';
import {
  PRICE_MONTH,
  PRICE_YEAR,
  at,
  invoiceObject,
  stripeEvent,
  subscriptionObject,
} from '../test-support/stripe.js';
import { createBillingService, type BillingService } from './service.js';
import { METADATA_KEYS } from './stripe-events.js';
import { createWebhookProcessor, type WebhookProcessor } from './webhooks.js';

/**
 * Stripe status → local status → ACCESS → may the user start ANOTHER checkout? (D-068)
 *
 * These are two different questions with two different answers, and this file pins them together so they cannot
 * drift apart: access is decided by the LOCAL status and the recorded period; checkout eligibility by whether the
 * subscription is still open at Stripe. Through the real webhook processor and the real billing service.
 * (The SQL functions that are the authority for both are proven in supabase/tests/billing.test.ts.)
 */

const U = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-15T00:00:00Z'); // inside the fixture period (2026-09-01 → 2026-10-01)

let billing: InMemoryBilling;
let gateway: FakeGateway;
let charities: InMemoryCharities;
let processor: WebhookProcessor;
let service: BillingService;
let t: number;

const snapshot = (charity: string) => ({
  [METADATA_KEYS.userId]: U,
  [METADATA_KEYS.charityId]: charity,
  [METADATA_KEYS.charityBps]: '1500',
});
let charityId: string;
const send = (type: string, object: unknown) => {
  t += 1;
  return processor.process(stripeEvent(type, object, { created: t }));
};
const checkout = () => service.startCheckout({ userId: U, email: null }, 'month');

beforeEach(() => {
  billing = new InMemoryBilling();
  gateway = new FakeGateway();
  charities = new InMemoryCharities();
  charityId = charities.seedCharity({ name: 'Riverside' });
  charities.seedProfile(U, charityId, 1500);
  billing.seedPlan({ interval: 'month', amountMinor: 1000, stripePriceId: PRICE_MONTH });
  billing.seedPlan({ interval: 'year', amountMinor: 10000, stripePriceId: PRICE_YEAR });
  processor = createWebhookProcessor({
    repository: billing,
    gateway,
    selection: new FakeSelection(),
  });
  service = createBillingService({
    repository: billing,
    gateway,
    charities: createCharityService({ repository: charities }),
    webOrigin: 'https://app.test',
    now: () => NOW,
  });
  t = at('2026-09-01T00:00:00Z');
});

describe('every Stripe status: what it means for ACCESS and for a NEW checkout', () => {
  // stripe status | local status | access now | a new checkout is refused
  const TABLE: [string, string, boolean, boolean][] = [
    ['active', 'active', true, true],
    ['trialing', 'active', true, true],
    ['incomplete', 'pending', false, true],
    ['past_due', 'lapsed', false, true],
    ['unpaid', 'lapsed', false, true],
    ['paused', 'lapsed', false, true],
    ['incomplete_expired', 'lapsed', false, false],
    ['canceled', 'cancelled', false, false],
  ];

  it.each(TABLE)(
    'Stripe "%s" → local "%s": access %s, new checkout refused %s',
    async (stripeStatus, local, access, refused) => {
      await send(
        'customer.subscription.created',
        subscriptionObject({ status: stripeStatus, metadata: snapshot(charityId) }),
      );

      expect(billing.subscriptionByStripeId('sub_test_1')?.status).toBe(local);
      expect(billing.hasAccess(U, NOW)).toBe(access);

      if (refused) {
        const err = await checkout().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).status).toBe(409);
        expect((err as AppError).code).toBe(BILLING_ERROR_CODES.alreadySubscribed);
        expect(gateway.calls).toBe(0); // nothing was created at Stripe
      } else {
        await expect(checkout()).resolves.toBeDefined();
      }
    },
  );

  it('access and eligibility genuinely differ for a retrying subscription: NO access, but a second checkout is REFUSED', async () => {
    await send(
      'customer.subscription.created',
      subscriptionObject({ status: 'past_due', metadata: snapshot(charityId) }),
    );
    expect(billing.hasAccess(U, NOW)).toBe(false);
    await expect(checkout()).rejects.toMatchObject({ status: 409 });
  });
});

describe('an actively retrying subscription cannot be double-charged, and access behaviour stays explicit', () => {
  it('active → renewal fails (past_due) → recovers → is later cancelled', async () => {
    const metadata = snapshot(charityId);
    await send('customer.subscription.created', subscriptionObject({ metadata }));
    await send('invoice.paid', invoiceObject({ metadata }));
    expect(billing.hasAccess(U, NOW)).toBe(true);

    // The renewal payment fails: access stops AT ONCE (not after Stripe's retries run out) …
    await send(
      'customer.subscription.updated',
      subscriptionObject({ status: 'past_due', metadata }),
    );
    expect(billing.hasAccess(U, NOW)).toBe(false);
    // … but Stripe is still retrying it, so a second subscription is refused (it could charge the user twice).
    await expect(checkout()).rejects.toMatchObject({ code: BILLING_ERROR_CODES.alreadySubscribed });
    expect(gateway.checkouts).toHaveLength(0);
    expect(gateway.customers).toHaveLength(0);

    // A retry succeeds: the SAME subscription is active again, access returns, still no second subscription.
    await send(
      'invoice.paid',
      invoiceObject({ id: 'in_retry', billingReason: 'subscription_cycle', metadata }),
    );
    await send('customer.subscription.updated', subscriptionObject({ status: 'active', metadata }));
    expect(billing.hasAccess(U, NOW)).toBe(true);
    expect(billing.subscriptions).toHaveLength(1);
    await expect(checkout()).rejects.toMatchObject({ status: 409 });

    // Only when the subscription is really over may the user start a new one.
    await send(
      'customer.subscription.deleted',
      subscriptionObject({ status: 'canceled', endedAt: at('2026-09-20T00:00:00Z'), metadata }),
    );
    expect(billing.hasAccess(U, NOW)).toBe(false);
    await expect(checkout()).resolves.toBeDefined();
  });

  it('retries that run out (Stripe cancels the subscription) end the block', async () => {
    const metadata = snapshot(charityId);
    await send(
      'customer.subscription.created',
      subscriptionObject({ status: 'past_due', metadata }),
    );
    await expect(checkout()).rejects.toMatchObject({ status: 409 });
    await send(
      'customer.subscription.deleted',
      subscriptionObject({ status: 'canceled', endedAt: at('2026-09-25T00:00:00Z'), metadata }),
    );
    await expect(checkout()).resolves.toBeDefined();
  });
});

describe('ACCESS is the recorded paid period — no tolerance for a late webhook (PRD SUB-05)', () => {
  const sub = (periodEnd: string) => {
    const s = subscriptionObject({
      metadata: snapshot(charityId),
      period: { start: at('2026-08-01T00:00:00Z'), end: at(periodEnd) },
    });
    return s;
  };

  it('access while the period is current', async () => {
    await send('customer.subscription.created', sub('2026-10-01T00:00:00Z'));
    expect(billing.hasAccess(U, new Date('2026-09-30T23:59:59Z'))).toBe(true);
  });

  it('access ends at the recorded period end — a renewal that has not been RECORDED yet grants nothing', async () => {
    await send('customer.subscription.created', sub('2026-10-01T00:00:00Z'));
    expect(billing.hasAccess(U, new Date('2026-10-01T00:00:00Z'))).toBe(false);
    expect(billing.hasAccess(U, new Date('2026-10-01T00:01:00Z'))).toBe(false);
    expect(billing.hasAccess(U, new Date('2026-10-04T00:00:00Z'))).toBe(false); // days later: no grace
  });

  it('access resumes as soon as the renewal IS recorded (the new period)', async () => {
    await send('customer.subscription.created', sub('2026-10-01T00:00:00Z'));
    const later = new Date('2026-10-01T00:05:00Z');
    expect(billing.hasAccess(U, later)).toBe(false);
    await send(
      'customer.subscription.updated',
      subscriptionObject({
        metadata: snapshot(charityId),
        period: { start: at('2026-10-01T00:00:00Z'), end: at('2026-11-01T00:00:00Z') },
      }),
    );
    expect(billing.hasAccess(U, later)).toBe(true);
  });

  it('cancelling at period end keeps access until the period ends and not after, whether or not the "deleted" webhook has arrived', async () => {
    await send(
      'customer.subscription.created',
      subscriptionObject({
        metadata: snapshot(charityId),
        cancelAtPeriodEnd: true,
        canceledAt: at('2026-09-10T00:00:00Z'),
      }),
    );
    expect(billing.hasAccess(U, new Date('2026-09-30T00:00:00Z'))).toBe(true);
    expect(billing.hasAccess(U, new Date('2026-10-01T00:00:01Z'))).toBe(false);
  });
});
