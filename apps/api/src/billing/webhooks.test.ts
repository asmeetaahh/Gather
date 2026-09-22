import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryCharities } from '../test-support/charities.js';
import { FakeGateway, FakeSelection, InMemoryBilling } from '../test-support/billing.js';
import {
  CUSTOMER,
  PERIOD_1,
  PERIOD_2,
  PRICE_MONTH,
  PRICE_YEAR,
  SUB,
  at,
  checkoutSessionObject,
  invoiceObject,
  stripeEvent,
  subscriptionObject,
} from '../test-support/stripe.js';
import { PaymentProviderError } from './gateway.js';
import { createCharitySelectionReader } from './selection.js';
import { InvalidStripeEventError, METADATA_KEYS } from './stripe-events.js';
import { HANDLED_EVENT_TYPES, createWebhookProcessor, type WebhookProcessor } from './webhooks.js';

const U = '11111111-1111-4111-8111-111111111111';
const V = '22222222-2222-4222-8222-222222222222';
const CHARITY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHARITY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let billing: InMemoryBilling;
let gateway: FakeGateway;
let selection: FakeSelection;
let processor: WebhookProcessor;
let t: number; // Stripe event time, advanced per event so ordering is explicit

const snapshot = (charity = CHARITY_A, bps = 1500) => ({
  [METADATA_KEYS.userId]: U,
  [METADATA_KEYS.charityId]: charity,
  [METADATA_KEYS.charityBps]: String(bps),
});

/** Sends an event created `+1s` after the previous one. */
const send = (type: string, object: unknown, o: { id?: string; created?: number } = {}) => {
  t += 1;
  return processor.process(stripeEvent(type, object, { ...o, created: o.created ?? t }));
};

beforeEach(() => {
  billing = new InMemoryBilling();
  gateway = new FakeGateway();
  selection = new FakeSelection();
  billing.seedPlan({ interval: 'month', amountMinor: 1000, stripePriceId: PRICE_MONTH });
  billing.seedPlan({ interval: 'year', amountMinor: 10000, stripePriceId: PRICE_YEAR });
  processor = createWebhookProcessor({ repository: billing, gateway, selection });
  t = at('2026-09-01T00:00:00Z');
});

/** The user as Stripe knows them, subscribed and paid once (the usual starting point for later scenarios). */
async function subscribed(over: { priceId?: string } = {}) {
  await send(
    'customer.subscription.created',
    subscriptionObject({ metadata: snapshot(), ...over }),
  );
  await send('invoice.paid', invoiceObject({ metadata: snapshot() }));
}

describe('the subscription lifecycle (SUB-04: renewal, cancellation, lapsed)', () => {
  it('SUBSCRIBE: Checkout completes, the subscription is recorded, the first invoice is paid and attributed', async () => {
    gateway.remoteSubscriptions.set(SUB, subscriptionObject({ metadata: snapshot() }));

    expect(
      await send('checkout.session.completed', checkoutSessionObject({ clientReferenceId: U })),
    ).toBe('processed');
    // The user ↔ customer mapping is learned, and the subscription is visible straight away.
    expect(billing.customerOf(U)).toBe(CUSTOMER);
    expect(billing.subscriptionByStripeId(SUB)).toMatchObject({
      userId: U,
      status: 'active',
      providerStatus: 'active',
    });

    await send('customer.subscription.created', subscriptionObject({ metadata: snapshot() }));
    await send('invoice.paid', invoiceObject({ metadata: snapshot() }));

    expect(billing.subscriptions).toHaveLength(1);
    expect(billing.paymentsOf(U)).toHaveLength(1);
    expect(billing.paymentsOf(U)[0]).toMatchObject({
      state: 'succeeded',
      amountMinor: 1000,
      currency: 'USD',
      stripeInvoiceId: 'in_test_1',
    });
    expect(billing.contributionsOf(U)).toEqual([
      expect.objectContaining({
        charityId: CHARITY_A,
        percentageBps: 1500,
        basisMinor: 1000,
        amountMinor: 150,
        currency: 'USD',
      }),
    ]);
  });

  it('the subscription carries the renewal date, and the payment the period it paid for', async () => {
    await subscribed();
    const sub = billing.subscriptionByStripeId(SUB);
    expect(sub?.periodEnd?.toISOString()).toBe(new Date(PERIOD_1.end * 1000).toISOString());
    expect(billing.paymentsOf(U)[0]?.periodStart?.toISOString()).toBe(
      new Date(PERIOD_1.start * 1000).toISOString(),
    );
    expect(billing.paymentsOf(U)[0]?.periodEnd?.toISOString()).toBe(
      new Date(PERIOD_1.end * 1000).toISOString(),
    );
  });

  it('an incomplete first payment is pending, then active once paid', async () => {
    await send(
      'customer.subscription.created',
      subscriptionObject({ status: 'incomplete', metadata: snapshot() }),
    );
    expect(billing.subscriptionByStripeId(SUB)?.status).toBe('pending');
    await send(
      'customer.subscription.updated',
      subscriptionObject({ status: 'active', metadata: snapshot() }),
    );
    expect(billing.subscriptionByStripeId(SUB)?.status).toBe('active');
  });

  it('RENEWAL: the next invoice is paid, the period moves, and it is a second payment with its own contribution', async () => {
    await subscribed();
    await send(
      'customer.subscription.updated',
      subscriptionObject({ period: PERIOD_2, metadata: snapshot() }),
    );
    await send(
      'invoice.paid',
      invoiceObject({
        id: 'in_renewal',
        billingReason: 'subscription_cycle',
        period: PERIOD_2,
        metadata: snapshot(),
      }),
    );
    selection.set(U, { charityId: CHARITY_A, percentageBps: 1500 });

    expect(billing.subscriptionByStripeId(SUB)?.periodEnd?.toISOString()).toBe(
      new Date(PERIOD_2.end * 1000).toISOString(),
    );
    expect(billing.paymentsOf(U).map((p) => p.stripeInvoiceId)).toEqual([
      'in_test_1',
      'in_renewal',
    ]);
    expect(billing.contributionsOf(U)).toHaveLength(2);
  });

  it('PLAN SWITCH (monthly → yearly, via the portal): the subscription follows the new price', async () => {
    await subscribed();
    await send(
      'customer.subscription.updated',
      subscriptionObject({
        priceId: PRICE_YEAR,
        period: { start: PERIOD_1.start, end: at('2027-09-01T00:00:00Z') },
        metadata: snapshot(),
      }),
    );
    const yearly = (await billing.listActivePlans()).find((p) => p.interval === 'year');
    expect(billing.subscriptionByStripeId(SUB)?.planId).toBe(yearly?.id);
    expect(billing.subscriptions).toHaveLength(1); // the same subscription, not a second one
  });

  it('CANCEL AT PERIOD END: the user keeps access until the paid period ends, then the subscription ends', async () => {
    await subscribed();
    await send(
      'customer.subscription.updated',
      subscriptionObject({
        cancelAtPeriodEnd: true,
        canceledAt: at('2026-09-10T00:00:00Z'),
        metadata: snapshot(),
      }),
    );
    expect(billing.subscriptionByStripeId(SUB)).toMatchObject({
      status: 'active',
      cancelAtPeriodEnd: true,
    });
    expect(billing.subscriptionByStripeId(SUB)?.cancelledAt?.toISOString()).toBe(
      '2026-09-10T00:00:00.000Z',
    );

    await send(
      'customer.subscription.deleted',
      subscriptionObject({
        status: 'canceled',
        cancelAtPeriodEnd: true,
        canceledAt: at('2026-09-10T00:00:00Z'),
        endedAt: PERIOD_1.end,
        metadata: snapshot(),
      }),
    );
    expect(billing.subscriptionByStripeId(SUB)).toMatchObject({
      status: 'cancelled',
      providerStatus: 'canceled',
    });
    expect(billing.subscriptionByStripeId(SUB)?.endedAt?.toISOString()).toBe(
      new Date(PERIOD_1.end * 1000).toISOString(),
    );
  });

  it('a user can change their mind: cancel_at_period_end goes back to false', async () => {
    await subscribed();
    await send(
      'customer.subscription.updated',
      subscriptionObject({ cancelAtPeriodEnd: true, metadata: snapshot() }),
    );
    await send(
      'customer.subscription.updated',
      subscriptionObject({ cancelAtPeriodEnd: false, metadata: snapshot() }),
    );
    expect(billing.subscriptionByStripeId(SUB)?.cancelAtPeriodEnd).toBe(false);
  });

  it('IMMEDIATE CANCELLATION: an active subscription that Stripe deletes is cancelled at once', async () => {
    await subscribed();
    await send(
      'customer.subscription.deleted',
      subscriptionObject({
        status: 'canceled',
        endedAt: at('2026-09-05T00:00:00Z'),
        metadata: snapshot(),
      }),
    );
    expect(billing.subscriptionByStripeId(SUB)?.status).toBe('cancelled');
  });

  it('LAPSE and RECOVERY: a failed renewal lapses the subscription, a later successful payment restores it', async () => {
    await subscribed();
    await send(
      'customer.subscription.updated',
      subscriptionObject({ status: 'past_due', period: PERIOD_2, metadata: snapshot() }),
    );
    await send(
      'invoice.payment_failed',
      invoiceObject({
        id: 'in_retry',
        billingReason: 'subscription_cycle',
        amountPaid: 0,
        amountDue: 1000,
        paidAt: null,
        period: PERIOD_2,
        metadata: snapshot(),
      }),
    );

    expect(billing.subscriptionByStripeId(SUB)).toMatchObject({
      status: 'lapsed',
      providerStatus: 'past_due',
    });
    expect(billing.paymentsOf(U).find((p) => p.stripeInvoiceId === 'in_retry')).toMatchObject({
      state: 'failed',
      amountMinor: 1000,
      paidAt: null,
    });
    expect(billing.contributionsOf(U)).toHaveLength(1); // a failed payment funds no charity

    selection.set(U, { charityId: CHARITY_A, percentageBps: 1500 });
    await send(
      'invoice.paid',
      invoiceObject({
        id: 'in_retry',
        billingReason: 'subscription_cycle',
        amountPaid: 1000,
        period: PERIOD_2,
        metadata: snapshot(),
      }),
    );
    await send(
      'customer.subscription.updated',
      subscriptionObject({ status: 'active', period: PERIOD_2, metadata: snapshot() }),
    );

    expect(billing.subscriptionByStripeId(SUB)?.status).toBe('active');
    expect(billing.paymentsOf(U).find((p) => p.stripeInvoiceId === 'in_retry')?.state).toBe(
      'succeeded',
    );
    expect(billing.paymentsOf(U)).toHaveLength(2); // the failed attempt became the success — not a third row
    expect(billing.contributionsOf(U)).toHaveLength(2);
  });

  it.each(['unpaid', 'paused', 'incomplete_expired'])(
    'Stripe status "%s" is a lapsed subscription',
    async (status) => {
      await subscribed();
      await send(
        'customer.subscription.updated',
        subscriptionObject({ status, metadata: snapshot() }),
      );
      expect(billing.subscriptionByStripeId(SUB)?.status).toBe('lapsed');
    },
  );

  it('RE-SUBSCRIBING after cancellation creates a NEW subscription and keeps the old one as history', async () => {
    await subscribed();
    await send(
      'customer.subscription.deleted',
      subscriptionObject({
        status: 'canceled',
        endedAt: at('2026-09-05T00:00:00Z'),
        metadata: snapshot(),
      }),
    );
    await send(
      'customer.subscription.created',
      subscriptionObject({ id: 'sub_second', metadata: snapshot() }),
    );
    expect(billing.subscriptions.map((s) => [s.stripeSubscriptionId, s.status])).toEqual([
      [SUB, 'cancelled'],
      ['sub_second', 'active'],
    ]);
  });

  it('older API shapes are handled too (period on the subscription, subscription on the invoice)', async () => {
    await send(
      'customer.subscription.created',
      subscriptionObject({ legacyPeriod: true, metadata: snapshot() }),
    );
    await send('invoice.paid', invoiceObject({ legacy: true, metadata: snapshot() }));
    expect(billing.subscriptionByStripeId(SUB)?.status).toBe('active');
    expect(billing.paymentsOf(U)[0]?.stripePaymentIntentId).toBe('pi_test_1');
  });

  it('a second, identical paid-invoice notification type (invoice.payment_succeeded) is handled the same', async () => {
    await send('customer.subscription.created', subscriptionObject({ metadata: snapshot() }));
    await send('invoice.payment_succeeded', invoiceObject({ metadata: snapshot() }));
    expect(billing.paymentsOf(U)).toHaveLength(1);
  });
});

describe('money and the charity contribution (D-025 → D-069)', () => {
  const paid = async (over: Parameters<typeof invoiceObject>[0]) => {
    await send(
      'customer.subscription.created',
      subscriptionObject({
        metadata: snapshot(
          CHARITY_A,
          over?.metadata ? Number(over.metadata[METADATA_KEYS.charityBps] ?? 1500) : 1500,
        ),
      }),
    );
    await send('invoice.paid', invoiceObject(over));
    return billing.contributionsOf(U)[0];
  };

  it('the share is the chosen percentage of the fee, rounded UP (never less than chosen)', async () => {
    const c = await paid({ amountPaid: 999, metadata: snapshot(CHARITY_A, 1000) });
    expect(c).toMatchObject({ basisMinor: 999, percentageBps: 1000, amountMinor: 100 }); // 99.9 → 100
  });

  it('at exactly 10% the share is exactly a tenth', async () => {
    expect(
      (await paid({ amountPaid: 2000, metadata: snapshot(CHARITY_A, 1000) }))?.amountMinor,
    ).toBe(200);
  });

  it('the basis is the fee EXCLUDING tax — tax is not ours to give away', async () => {
    const c = await paid({
      amountPaid: 1200,
      totalExcludingTax: 1000,
      metadata: snapshot(CHARITY_A, 1000),
    });
    expect(c).toMatchObject({ basisMinor: 1000, amountMinor: 100 });
    expect(billing.paymentsOf(U)[0]?.amountMinor).toBe(1200); // the payment itself is what was collected
  });

  it('the basis never exceeds what was actually collected (e.g. a credit balance covered part of the invoice)', async () => {
    const c = await paid({
      amountPaid: 600,
      totalExcludingTax: 1000,
      metadata: snapshot(CHARITY_A, 1000),
    });
    expect(c).toMatchObject({ basisMinor: 600, amountMinor: 60 });
  });

  it('only PART of a taxed invoice collected: the tax is taken out in proportion — no tax is ever counted (OWNER D-070)', async () => {
    // total 1200 = 1000 + 200 tax; 600 collected (a credit balance covered the rest) → 500 of it is before tax.
    const c = await paid({
      amountPaid: 600,
      total: 1200,
      totalExcludingTax: 1000,
      metadata: snapshot(CHARITY_A, 1000),
    });
    expect(c).toMatchObject({ basisMinor: 500, amountMinor: 50 });
    expect(billing.paymentsOf(U)[0]?.amountMinor).toBe(600);
  });

  it('is GROSS of Stripe\u2019s processing fees: the same collected amount gives the same share whatever Stripe keeps', async () => {
    // Stripe\u2019s fee is not on the invoice at all, and nothing is deducted for it.
    expect(
      (await paid({ amountPaid: 1000, metadata: snapshot(CHARITY_A, 1000) }))?.amountMinor,
    ).toBe(100);
  });

  it('an invoice whose figures leave nothing before tax cannot be attributed: kept as failed, not recorded', async () => {
    await send('customer.subscription.created', subscriptionObject({ metadata: snapshot() }));
    const outcome = await send(
      'invoice.paid',
      invoiceObject({ amountPaid: 500, total: 1000, totalExcludingTax: 0, metadata: snapshot() }),
    );
    expect(outcome).toBe('unprocessable');
    expect(billing.paymentsOf(U)).toHaveLength(0);
  });

  it('a discounted (coupon) fee is the basis: 10% of what the user actually paid', async () => {
    expect(
      (await paid({ amountPaid: 800, metadata: snapshot(CHARITY_A, 1000) }))?.amountMinor,
    ).toBe(80);
  });

  it('a YEARLY payment contributes in full when it is paid (the charity share is not spread — D-069)', async () => {
    await send(
      'customer.subscription.created',
      subscriptionObject({ priceId: PRICE_YEAR, metadata: snapshot(CHARITY_A, 1000) }),
    );
    await send(
      'invoice.paid',
      invoiceObject({
        amountPaid: 10000,
        period: { start: PERIOD_1.start, end: at('2027-09-01T00:00:00Z') },
        metadata: snapshot(CHARITY_A, 1000),
      }),
    );
    expect(billing.contributionsOf(U)).toHaveLength(1);
    expect(billing.contributionsOf(U)[0]?.amountMinor).toBe(1000);
    expect(billing.paymentsOf(U)[0]?.periodEnd?.toISOString()).toBe('2027-09-01T00:00:00.000Z'); // the period it paid for (D-015)
  });

  it('the currency is upper-cased and stored with both the payment and the contribution', async () => {
    const c = await paid({
      currency: 'gbp',
      amountPaid: 1000,
      metadata: snapshot(CHARITY_A, 1000),
    });
    expect(c?.currency).toBe('GBP');
    expect(billing.paymentsOf(U)[0]?.currency).toBe('GBP');
  });

  it('every amount is an integer of minor units, whatever the input', async () => {
    for (const [paidAmount, bps] of [
      [1, 1000],
      [7, 1234],
      [333, 3333],
      [99999, 9999],
      [123456789, 1000],
    ] as const) {
      billing = new InMemoryBilling();
      billing.seedPlan({ interval: 'month', amountMinor: 1000, stripePriceId: PRICE_MONTH });
      processor = createWebhookProcessor({ repository: billing, gateway, selection });
      const c = await paid({ amountPaid: paidAmount, metadata: snapshot(CHARITY_A, bps) });
      expect(Number.isInteger(c?.amountMinor), `${String(paidAmount)}@${String(bps)}`).toBe(true);
      expect((c?.amountMinor ?? 0) * 10000).toBeGreaterThanOrEqual(paidAmount * bps);
      expect(c?.amountMinor).toBeLessThanOrEqual(paidAmount);
    }
  });
});

describe('which charity a payment is attributed to (D-069) — the snapshot needed for historical accounting', () => {
  it('the FIRST payment uses what the user agreed to at Checkout, even if their choice changed since', async () => {
    selection.set(U, { charityId: CHARITY_B, percentageBps: 4000 }); // changed after checkout, before the webhook
    await send(
      'customer.subscription.created',
      subscriptionObject({ metadata: snapshot(CHARITY_A, 1500) }),
    );
    await send(
      'invoice.paid',
      invoiceObject({ billingReason: 'subscription_create', metadata: snapshot(CHARITY_A, 1500) }),
    );
    expect(billing.contributionsOf(U)[0]).toMatchObject({
      charityId: CHARITY_A,
      percentageBps: 1500,
    });
  });

  it('a RENEWAL uses the user’s CURRENT charity and percentage — and each payment keeps its own snapshot', async () => {
    selection.set(U, { charityId: CHARITY_A, percentageBps: 1500 });
    await subscribed();
    selection.set(U, { charityId: CHARITY_B, percentageBps: 3000 }); // the user changed their mind
    await send(
      'invoice.paid',
      invoiceObject({
        id: 'in_2',
        billingReason: 'subscription_cycle',
        metadata: snapshot(CHARITY_A, 1500),
      }),
    );
    const [first, second] = billing.contributionsOf(U);
    expect(first).toMatchObject({ charityId: CHARITY_A, percentageBps: 1500, amountMinor: 150 }); // history untouched
    expect(second).toMatchObject({ charityId: CHARITY_B, percentageBps: 3000, amountMinor: 300 });
  });

  it('a REPLAYED invoice arriving after the user changed charity and percentage does not rewrite the stored contribution', async () => {
    selection.set(U, { charityId: CHARITY_A, percentageBps: 1500 });
    await subscribed();
    selection.set(U, { charityId: CHARITY_B, percentageBps: 3000 });
    await send(
      'invoice.paid',
      invoiceObject({
        id: 'in_2',
        billingReason: 'subscription_cycle',
        metadata: snapshot(CHARITY_A, 1500),
      }),
    );
    const stored = JSON.stringify(billing.contributionsOf(U));

    // The user changes their mind AGAIN, then Stripe replays the renewal invoice under a different event type.
    selection.set(U, { charityId: CHARITY_A, percentageBps: 5000 });
    await send(
      'invoice.payment_succeeded',
      invoiceObject({
        id: 'in_2',
        billingReason: 'subscription_cycle',
        metadata: snapshot(CHARITY_A, 1500),
      }),
    );

    expect(JSON.stringify(billing.contributionsOf(U))).toBe(stored);
    expect(billing.contributionsOf(U).map((c) => [c.charityId, c.percentageBps])).toEqual([
      [CHARITY_A, 1500],
      [CHARITY_B, 3000],
    ]);
  });

  it('the FIRST payment replayed after the user moved on keeps what they agreed to at Checkout', async () => {
    await subscribed();
    selection.set(U, { charityId: CHARITY_B, percentageBps: 9000 });
    await send('invoice.payment_succeeded', invoiceObject({ metadata: snapshot(CHARITY_A, 1500) }));
    expect(billing.contributionsOf(U)).toHaveLength(1);
    expect(billing.contributionsOf(U)[0]).toMatchObject({
      charityId: CHARITY_A,
      percentageBps: 1500,
      amountMinor: 150,
    });
  });

  it('a user may LOWER the percentage to 10% (D-064): the next renewal uses it', async () => {
    selection.set(U, { charityId: CHARITY_A, percentageBps: 5000 });
    await subscribed();
    selection.set(U, { charityId: CHARITY_A, percentageBps: 1000 });
    await send(
      'invoice.paid',
      invoiceObject({
        id: 'in_2',
        billingReason: 'subscription_cycle',
        metadata: snapshot(CHARITY_A, 5000),
      }),
    );
    expect(billing.contributionsOf(U).map((c) => c.percentageBps)).toEqual([1500, 1000]);
  });

  it('a renewal falls back to the Checkout snapshot when the user has no current selection', async () => {
    await subscribed();
    selection.set(U, null);
    await send(
      'invoice.paid',
      invoiceObject({
        id: 'in_2',
        billingReason: 'subscription_cycle',
        metadata: snapshot(CHARITY_A, 2000),
      }),
    );
    expect(billing.contributionsOf(U)[1]).toMatchObject({
      charityId: CHARITY_A,
      percentageBps: 2000,
    });
  });

  it('a snapshot with an out-of-range percentage is not trusted (falls back to the current choice)', async () => {
    selection.set(U, { charityId: CHARITY_B, percentageBps: 2500 });
    await send(
      'customer.subscription.created',
      subscriptionObject({ metadata: snapshot(CHARITY_A, 999) }),
    );
    await send(
      'invoice.paid',
      invoiceObject({ billingReason: 'subscription_create', metadata: snapshot(CHARITY_A, 999) }),
    );
    expect(billing.contributionsOf(U)[0]).toMatchObject({
      charityId: CHARITY_B,
      percentageBps: 2500,
    });
  });

  it('with NO charity anywhere the payment is not recorded at all — money is never left unattributed', async () => {
    await send(
      'customer.subscription.created',
      subscriptionObject({ metadata: { [METADATA_KEYS.userId]: U } }),
    );
    expect(
      await send('invoice.paid', invoiceObject({ metadata: { [METADATA_KEYS.userId]: U } })),
    ).toBe('unprocessable');
    expect(billing.paymentsOf(U)).toHaveLength(0);
    expect(billing.contributionsOf(U)).toHaveLength(0);
    const failed = [...billing.ledger.values()].find((r) => r.type === 'invoice.paid');
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'No charity to attribute this payment to',
    });
  });

  describe('the charity is ARCHIVED between checkout and payment (the D-066 window)', () => {
    let charities: InMemoryCharities;
    let archivedId: string;
    beforeEach(() => {
      charities = new InMemoryCharities();
      archivedId = charities.seedCharity({ name: 'Riverside' });
      charities.seedProfile(U, archivedId, 1500);
      processor = createWebhookProcessor({
        repository: billing,
        gateway,
        selection: createCharitySelectionReader(charities),
      });
    });

    it('the FIRST payment is still attributed to the charity chosen at Checkout: the money was paid on the user’s instruction', async () => {
      charities.archive(archivedId); // archived after checkout was created, before the payment webhook
      await send(
        'customer.subscription.created',
        subscriptionObject({ metadata: snapshot(archivedId, 1500) }),
      );
      await send('invoice.paid', invoiceObject({ metadata: snapshot(archivedId, 1500) }));
      expect(billing.paymentsOf(U)).toHaveLength(1);
      expect(billing.contributionsOf(U)[0]).toMatchObject({
        charityId: archivedId,
        percentageBps: 1500,
        amountMinor: 150,
      });
    });

    it('a RENEWAL after the charity was archived is still attributed to it until the user replaces it (archiving hides, it does not erase — D-043)', async () => {
      await send(
        'customer.subscription.created',
        subscriptionObject({ metadata: snapshot(archivedId, 1500) }),
      );
      await send('invoice.paid', invoiceObject({ metadata: snapshot(archivedId, 1500) }));
      charities.archive(archivedId);
      await send(
        'invoice.paid',
        invoiceObject({
          id: 'in_2',
          billingReason: 'subscription_cycle',
          metadata: snapshot(archivedId, 1500),
        }),
      );
      expect(billing.contributionsOf(U).map((c) => c.charityId)).toEqual([archivedId, archivedId]);
    });

    it('once the user replaces the archived charity the next renewal follows the new one', async () => {
      await send(
        'customer.subscription.created',
        subscriptionObject({ metadata: snapshot(archivedId, 1500) }),
      );
      await send('invoice.paid', invoiceObject({ metadata: snapshot(archivedId, 1500) }));
      charities.archive(archivedId);
      const next = charities.seedCharity({ name: 'Next' });
      charities.seedProfile(U, next, 1500);
      await send(
        'invoice.paid',
        invoiceObject({
          id: 'in_2',
          billingReason: 'subscription_cycle',
          metadata: snapshot(archivedId, 1500),
        }),
      );
      expect(billing.contributionsOf(U)[1]?.charityId).toBe(next);
    });
  });
});

describe('IDEMPOTENCY — a webhook delivered more than once changes nothing more than once', () => {
  it('the same event id delivered twice is acknowledged as a duplicate', async () => {
    await send('customer.subscription.created', subscriptionObject({ metadata: snapshot() }));
    const event = stripeEvent('invoice.paid', invoiceObject({ metadata: snapshot() }), {
      id: 'evt_same',
      created: t + 1,
    });
    expect(await processor.process(event)).toBe('processed');
    expect(await processor.process(event)).toBe('duplicate');
    expect(await processor.process(event)).toBe('duplicate');
    expect(billing.paymentsOf(U)).toHaveLength(1);
    expect(billing.contributionsOf(U)).toHaveLength(1);
    expect(billing.calls.recordPayment).toBe(1); // the duplicates never reached the database
  });

  it('two DIFFERENT events for the same invoice (paid + payment_succeeded) still record one payment and one contribution', async () => {
    await send('customer.subscription.created', subscriptionObject({ metadata: snapshot() }));
    await send('invoice.paid', invoiceObject({ metadata: snapshot() }));
    await send('invoice.payment_succeeded', invoiceObject({ metadata: snapshot() }));
    expect(billing.paymentsOf(U)).toHaveLength(1);
    expect(billing.contributionsOf(U)).toHaveLength(1);
  });

  it('simultaneous deliveries of the same event cannot double-count', async () => {
    await send('customer.subscription.created', subscriptionObject({ metadata: snapshot() }));
    const event = stripeEvent('invoice.paid', invoiceObject({ metadata: snapshot() }), {
      id: 'evt_race',
      created: t + 1,
    });
    await Promise.all([
      processor.process(event),
      processor.process(event),
      processor.process(event),
    ]);
    expect(billing.paymentsOf(U)).toHaveLength(1);
    expect(billing.contributionsOf(U)).toHaveLength(1);
    expect(billing.ledger.get('evt_race')?.status).toBe('processed');
  });

  it('a replayed subscription event leaves the subscription exactly as it was', async () => {
    const event = stripeEvent(
      'customer.subscription.created',
      subscriptionObject({ metadata: snapshot() }),
      { id: 'evt_sub', created: t + 1 },
    );
    await processor.process(event);
    const before = JSON.stringify(billing.subscriptions);
    await processor.process(event);
    expect(JSON.stringify(billing.subscriptions)).toBe(before);
  });

  it('a transient failure is retried: the event is kept as failed, then processed on redelivery, exactly once', async () => {
    await send('customer.subscription.created', subscriptionObject({ metadata: snapshot() }));
    const event = stripeEvent('invoice.paid', invoiceObject({ metadata: snapshot() }), {
      id: 'evt_retry',
      created: t + 1,
    });

    billing.failNext('recordPayment');
    await expect(processor.process(event)).rejects.toThrow(/simulated database outage/);
    expect(billing.ledger.get('evt_retry')).toMatchObject({ status: 'failed' });
    expect(billing.paymentsOf(U)).toHaveLength(0);

    expect(await processor.process(event)).toBe('processed'); // Stripe redelivers
    expect(billing.ledger.get('evt_retry')?.status).toBe('processed');
    expect(billing.paymentsOf(U)).toHaveLength(1);
    expect(billing.contributionsOf(U)).toHaveLength(1);
    expect(await processor.process(event)).toBe('duplicate');
  });

  it('a payment and its contribution are written together: a failure records neither', async () => {
    await send('customer.subscription.created', subscriptionObject({ metadata: snapshot() }));
    billing.failNext('recordPayment');
    await expect(send('invoice.paid', invoiceObject({ metadata: snapshot() }))).rejects.toThrow();
    expect(billing.paymentsOf(U)).toHaveLength(0);
    expect(billing.contributionsOf(U)).toHaveLength(0);
  });
});

describe('ORDERING — Stripe does not deliver events in order', () => {
  it('an OLDER subscription event never overwrites a newer one', async () => {
    const newer = stripeEvent(
      'customer.subscription.updated',
      subscriptionObject({ status: 'past_due', metadata: snapshot() }),
      { created: at('2026-09-02T00:00:00Z') },
    );
    const older = stripeEvent(
      'customer.subscription.updated',
      subscriptionObject({ status: 'active', metadata: snapshot() }),
      { created: at('2026-09-01T00:00:00Z') },
    );
    await processor.process(newer);
    await processor.process(older); // arrives late
    expect(billing.subscriptionByStripeId(SUB)?.status).toBe('lapsed');
  });

  it('cancel then a late "created": the ended subscription stays ended', async () => {
    await processor.process(
      stripeEvent(
        'customer.subscription.deleted',
        subscriptionObject({
          status: 'canceled',
          endedAt: at('2026-09-03T00:00:00Z'),
          metadata: snapshot(),
        }),
        { created: at('2026-09-03T00:00:00Z') },
      ),
    );
    await processor.process(
      stripeEvent('customer.subscription.created', subscriptionObject({ metadata: snapshot() }), {
        created: at('2026-09-01T00:00:00Z'),
      }),
    );
    expect(billing.subscriptionByStripeId(SUB)?.status).toBe('cancelled');
  });

  it('an invoice that arrives BEFORE its subscription pulls the subscription from Stripe, then records the payment', async () => {
    gateway.remoteSubscriptions.set(SUB, subscriptionObject({ metadata: snapshot() }));
    expect(await send('invoice.paid', invoiceObject({ metadata: snapshot() }))).toBe('processed');
    expect(gateway.retrieved).toEqual([SUB]);
    expect(billing.subscriptionByStripeId(SUB)?.status).toBe('active');
    expect(billing.paymentsOf(U)).toHaveLength(1);
    expect(billing.contributionsOf(U)).toHaveLength(1);
  });

  it('…and if Stripe cannot be reached the event fails TRANSIENTLY (redelivered later), never silently dropped', async () => {
    await expect(
      send('invoice.paid', invoiceObject({ metadata: snapshot() })),
    ).rejects.toBeInstanceOf(PaymentProviderError);
    expect([...billing.ledger.values()][0]).toMatchObject({ status: 'failed' });
    expect(billing.paymentsOf(U)).toHaveLength(0);
    gateway.remoteSubscriptions.set(SUB, subscriptionObject({ metadata: snapshot() }));
    const again = stripeEvent('invoice.paid', invoiceObject({ metadata: snapshot() }), {
      id: [...billing.ledger.keys()][0] as string,
      created: t,
    });
    expect(await processor.process(again)).toBe('processed');
    expect(billing.paymentsOf(U)).toHaveLength(1);
  });

  it('a payment-failed event that arrives first also pulls the subscription', async () => {
    gateway.remoteSubscriptions.set(
      SUB,
      subscriptionObject({ status: 'past_due', metadata: snapshot() }),
    );
    await send(
      'invoice.payment_failed',
      invoiceObject({ amountPaid: 0, amountDue: 1000, paidAt: null, metadata: snapshot() }),
    );
    expect(billing.subscriptionByStripeId(SUB)?.status).toBe('lapsed');
    expect(billing.paymentsOf(U)[0]?.state).toBe('failed');
  });
});

describe('INVALID and unappliable events', () => {
  const ledgerFailed = () => [...billing.ledger.values()].filter((r) => r.status === 'failed');

  it('a payload that is not an event at all is rejected without touching anything', async () => {
    for (const bad of [
      null,
      'evt',
      5,
      [],
      {},
      { id: 'e' },
      { id: 'e', type: 'x', created: 1, livemode: false },
    ]) {
      await expect(processor.process(bad)).rejects.toBeInstanceOf(InvalidStripeEventError);
    }
    expect(billing.ledger.size).toBe(0);
  });

  it('LIVE-mode events are never applied (test mode only, ASM-11)', async () => {
    await expect(
      processor.process(
        stripeEvent('customer.subscription.created', subscriptionObject({ metadata: snapshot() }), {
          livemode: true,
        }),
      ),
    ).rejects.toThrow(/Live-mode/);
    expect(billing.subscriptions).toHaveLength(0);
    expect(billing.ledger.size).toBe(0);
  });

  it('an unknown event type is acknowledged and ignored — recorded as processed so it is not retried', async () => {
    expect(await send('customer.created', { id: 'cus_1' }, { id: 'evt_x' })).toBe('ignored');
    expect(billing.ledger.get('evt_x')?.status).toBe('processed');
    expect(billing.subscriptions).toHaveLength(0);
  });

  it('a payment-mode Checkout session is not ours to handle', async () => {
    expect(
      await send(
        'checkout.session.completed',
        checkoutSessionObject({ mode: 'payment', subscription: null }),
      ),
    ).toBe('ignored');
  });

  it('an invoice that belongs to no subscription is ignored (not a subscription payment)', async () => {
    expect(await send('invoice.paid', invoiceObject({ subscription: null }))).toBe('ignored');
    expect(billing.paymentsOf(U)).toHaveLength(0);
  });

  it('an invoice with nothing collected (100% coupon, credit) records no payment and no contribution', async () => {
    await send('customer.subscription.created', subscriptionObject({ metadata: snapshot() }));
    expect(
      await send(
        'invoice.paid',
        invoiceObject({ amountPaid: 0, amountDue: 0, metadata: snapshot() }),
      ),
    ).toBe('ignored');
    expect(billing.paymentsOf(U)).toHaveLength(0);
    expect(billing.contributionsOf(U)).toHaveLength(0);
  });

  it('a failed-payment event with nothing due is ignored', async () => {
    await send('customer.subscription.created', subscriptionObject({ metadata: snapshot() }));
    expect(
      await send(
        'invoice.payment_failed',
        invoiceObject({ amountPaid: 0, amountDue: 0, metadata: snapshot() }),
      ),
    ).toBe('ignored');
  });

  it('an object we cannot read inside a valid event is recorded as failed and acknowledged (a retry would fail the same way)', async () => {
    expect(await send('invoice.paid', { id: 'in_bad' }, { id: 'evt_bad' })).toBe('unprocessable');
    expect(billing.ledger.get('evt_bad')).toMatchObject({ status: 'failed' });
  });

  it.each([
    ['fractional money', { amount_paid: 10.5 }],
    ['negative money', { amount_paid: -1 }],
    ['money as a string', { amount_paid: '1000' }],
  ])('an invoice with %s is refused — money must be integer minor units', async (_label, patch) => {
    await send('customer.subscription.created', subscriptionObject({ metadata: snapshot() }));
    expect(
      await send('invoice.paid', { ...invoiceObject({ metadata: snapshot() }), ...patch }),
    ).toBe('unprocessable');
    expect(billing.paymentsOf(U)).toHaveLength(0);
  });

  it('a subscription on a Stripe price we have no plan for is not recorded', async () => {
    expect(
      await send(
        'customer.subscription.created',
        subscriptionObject({ priceId: 'price_unknown', metadata: snapshot() }),
      ),
    ).toBe('unprocessable');
    expect(billing.subscriptions).toHaveLength(0);
    expect(ledgerFailed()[0]?.error).toMatch(
      /No plan is configured for Stripe price price_unknown/,
    );
  });

  it('a subscription for a Stripe customer we do not know (and that names no user) is not recorded', async () => {
    expect(await send('customer.subscription.created', subscriptionObject({ metadata: {} }))).toBe(
      'unprocessable',
    );
    expect(billing.subscriptions).toHaveLength(0);
    expect(ledgerFailed()[0]?.error).toBe('Unknown Stripe customer');
  });

  it('a customer that disagrees with the user named in the metadata is refused', async () => {
    billing.seedCustomer(V, CUSTOMER); // the customer belongs to V …
    expect(
      await send('customer.subscription.created', subscriptionObject({ metadata: snapshot() })),
    ).toBe('unprocessable'); // … but the metadata says U
    expect(billing.subscriptions).toHaveLength(0);
  });

  it('a Stripe customer already belonging to ANOTHER user is never re-assigned', async () => {
    billing.seedCustomer(V, CUSTOMER);
    expect(
      await send(
        'customer.subscription.created',
        subscriptionObject({ metadata: { [METADATA_KEYS.userId]: U } }),
      ),
    ).toBe('unprocessable');
    expect(billing.customerOf(V)).toBe(CUSTOMER);
    expect(billing.customerOf(U)).toBeNull();
  });

  it('a user who already has a different Stripe customer is refused', async () => {
    billing.seedCustomer(U, 'cus_first');
    expect(
      await send(
        'customer.subscription.created',
        subscriptionObject({ customer: 'cus_second', metadata: snapshot() }),
      ),
    ).toBe('unprocessable');
    expect(billing.customerOf(U)).toBe('cus_first');
  });

  it('an unknown Stripe status is refused rather than guessed', async () => {
    expect(
      await send(
        'customer.subscription.created',
        subscriptionObject({ status: 'brand_new_state', metadata: snapshot() }),
      ),
    ).toBe('unprocessable');
    expect(billing.subscriptions).toHaveLength(0);
  });

  it('an ACTIVE subscription without a period end is refused (there would be no renewal date)', async () => {
    const raw = subscriptionObject({ metadata: snapshot() });
    const item = (raw.items as { data: Record<string, unknown>[] }).data[0];
    delete item?.current_period_end;
    expect(await send('customer.subscription.created', raw)).toBe('unprocessable');
  });

  it('a SECOND live subscription for a user who already has one is not applied, and the first is untouched', async () => {
    await subscribed();
    const before = JSON.stringify(billing.subscriptionByStripeId(SUB));
    expect(
      await send(
        'customer.subscription.created',
        subscriptionObject({ id: 'sub_duplicate', metadata: snapshot() }),
      ),
    ).toBe('unprocessable');
    expect(billing.subscriptions).toHaveLength(1);
    expect(JSON.stringify(billing.subscriptionByStripeId(SUB))).toBe(before);
    expect(ledgerFailed()[0]?.error).toMatch(/another live subscription/);
  });

  it('an invoice whose customer is not the subscription’s user is refused', async () => {
    await subscribed();
    billing.seedCustomer(V, 'cus_bob');
    expect(
      await send(
        'invoice.paid',
        invoiceObject({ id: 'in_x', customer: 'cus_bob', metadata: snapshot() }),
      ),
    ).toBe('unprocessable');
    expect(billing.paymentsOf(U)).toHaveLength(1);
    expect(billing.paymentsOf(V)).toHaveLength(0);
  });

  it('a Checkout session without a customer is refused', async () => {
    expect(
      await send(
        'checkout.session.completed',
        checkoutSessionObject({ customer: null, clientReferenceId: U }),
      ),
    ).toBe('unprocessable');
  });

  it('a permanently unappliable event does not make Stripe retry (it is acknowledged, and kept for a person)', async () => {
    const outcome = await send(
      'customer.subscription.created',
      subscriptionObject({ priceId: 'price_unknown', metadata: snapshot() }),
      { id: 'evt_perm' },
    );
    expect(outcome).toBe('unprocessable');
    expect(billing.ledger.get('evt_perm')?.status).toBe('failed');
  });
});

describe('the documented event list is what the processor really handles', () => {
  it.each(HANDLED_EVENT_TYPES)(
    '%s is dispatched (an empty object is refused as unreadable, never "ignored")',
    async (type) => {
      expect(await send(type, {})).toBe('unprocessable');
    },
  );

  it('anything outside the list is ignored', async () => {
    for (const type of [
      'charge.refunded',
      'charge.dispute.created',
      'customer.updated',
      'invoice.created',
      'payment_intent.succeeded',
    ]) {
      expect(await send(type, { id: 'x' }), type).toBe('ignored');
    }
  });

  it('refunds and chargebacks are NOT handled (D-026 is still open)', () => {
    expect(HANDLED_EVENT_TYPES.some((t) => /refund|dispute/.test(t))).toBe(false);
  });
});

describe('the ledger keeps no customer data', () => {
  it('stores only what identifies the event — not names, emails or addresses', async () => {
    await send(
      'customer.subscription.created',
      {
        ...subscriptionObject({ metadata: snapshot() }),
        customer_email: 'alice@example.test',
        customer_name: 'Alice',
      },
      { id: 'evt_pii' },
    );
    const row = billing.ledger.get('evt_pii');
    expect(row?.summary).toEqual({
      id: 'evt_pii',
      type: 'customer.subscription.created',
      created: expect.any(String) as string,
    });
    expect(JSON.stringify(row)).not.toMatch(/alice|customer_email/i);
  });
});
