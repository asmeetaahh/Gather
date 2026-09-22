import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BILLING_ERROR_CODES, CHARITY_ERROR_CODES, AUTH_ERROR_CODES } from '@gather/shared';
import { createCharityService } from '../charities/service.js';
import { AppError } from '../errors.js';
import { InMemoryCharities } from '../test-support/charities.js';
import { FakeGateway, InMemoryBilling } from '../test-support/billing.js';
import { PaymentProviderError } from './gateway.js';
import { createBillingService, purchasablePlans, type BillingService } from './service.js';

const NOW = new Date('2026-09-21T10:00:00.000Z');
const U = '11111111-1111-4111-8111-111111111111';
const V = '22222222-2222-4222-8222-222222222222';
const WEB = 'https://app.test';

let charities: InMemoryCharities;
let billing: InMemoryBilling;
let gateway: FakeGateway;
let service: BillingService;
let riverside: string;

function build(overrides: { gateway?: FakeGateway | null; now?: () => Date } = {}) {
  gateway = overrides.gateway === null ? (null as never) : (overrides.gateway ?? gateway);
  return createBillingService({
    repository: billing,
    gateway: overrides.gateway === null ? null : gateway,
    charities: createCharityService({ repository: charities }),
    webOrigin: WEB,
    now: overrides.now ?? (() => NOW),
  });
}

beforeEach(() => {
  charities = new InMemoryCharities();
  billing = new InMemoryBilling();
  gateway = new FakeGateway();
  riverside = charities.seedCharity({ name: 'Riverside' });
  charities.seedProfile(U, riverside, 1500);
  charities.seedProfile(V, null, 1000);
  billing.seedPlan({ interval: 'month', amountMinor: 1000 });
  billing.seedPlan({ interval: 'year', amountMinor: 10000 });
  service = build();
});

afterEach(() => {
  vi.restoreAllMocks();
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

describe('plans (SUB-01: a monthly plan and a DISCOUNTED yearly plan)', () => {
  it('lists the monthly and the yearly plan with integer minor-unit prices', async () => {
    const plans = await service.listPlans();
    expect(plans.map((p) => [p.interval, p.amountMinor, p.currency])).toEqual([
      ['month', 1000, 'USD'],
      ['year', 10000, 'USD'],
    ]);
    expect(plans.every((p) => Number.isInteger(p.amountMinor))).toBe(true);
    expect(plans[0]).not.toHaveProperty('stripePriceId');
  });

  it('does not offer a plan that has no Stripe price yet', async () => {
    billing = new InMemoryBilling();
    billing.seedPlan({ interval: 'month', amountMinor: 1000, stripePriceId: null });
    billing.seedPlan({ interval: 'year', amountMinor: 10000 });
    service = build();
    // No purchasable monthly plan, so the yearly discount cannot be validated: nothing is offered.
    expect(await service.listPlans()).toEqual([]);
  });

  it('does not offer a yearly plan that is NOT a discount (equal to or above 12 monthly payments)', async () => {
    for (const yearly of [12000, 15000]) {
      billing = new InMemoryBilling();
      billing.seedPlan({ interval: 'month', amountMinor: 1000 });
      billing.seedPlan({ interval: 'year', amountMinor: yearly });
      service = build();
      expect(
        (await service.listPlans()).map((p) => p.interval),
        String(yearly),
      ).toEqual(['month']);
    }
  });

  it('does not offer a yearly plan in a different currency than the monthly one', async () => {
    billing = new InMemoryBilling();
    billing.seedPlan({ interval: 'month', amountMinor: 1000, currency: 'USD' });
    billing.seedPlan({ interval: 'year', amountMinor: 500, currency: 'EUR' });
    service = build();
    expect((await service.listPlans()).map((p) => p.interval)).toEqual(['month']);
  });

  it('purchasablePlans is a pure function of the catalogue', () => {
    expect(purchasablePlans([])).toEqual([]);
  });
});

describe('the user’s subscription (SUB-04, PRD §10 renewal date)', () => {
  it('a user who never subscribed has none and nothing to manage', async () => {
    expect(await service.getSubscription(U)).toEqual({
      subscription: null,
      canManageBilling: false,
    });
  });

  it('shows status, plan, renewal date and cancellation-at-period-end', async () => {
    const plan = (await billing.listActivePlans())[0];
    billing.seedSubscription({
      userId: U,
      planId: plan?.id ?? '',
      stripeSubscriptionId: 'sub_1',
      periodEnd: new Date('2026-10-01T00:00:00Z'),
    });
    billing.seedCustomer(U, 'cus_1');
    const sub = billing.subscriptionByStripeId('sub_1');
    if (sub) sub.cancelAtPeriodEnd = true;
    expect(await service.getSubscription(U)).toEqual({
      subscription: expect.objectContaining({
        status: 'active',
        planName: 'Monthly',
        interval: 'month',
        currentPeriodEnd: '2026-10-01T00:00:00.000Z',
        cancelAtPeriodEnd: true,
        endedAt: null,
      }) as unknown,
      canManageBilling: true,
    });
  });

  it('prefers a live subscription over an older ended one', async () => {
    const [monthly, yearly] = await billing.listActivePlans();
    billing.seedSubscription({
      userId: U,
      planId: monthly?.id ?? '',
      stripeSubscriptionId: 'sub_old',
      status: 'cancelled',
    });
    billing.seedSubscription({
      userId: U,
      planId: yearly?.id ?? '',
      stripeSubscriptionId: 'sub_new',
      status: 'active',
    });
    expect((await service.getSubscription(U)).subscription?.interval).toBe('year');
  });

  it('shows the most recent ended subscription when none is live', async () => {
    const [monthly] = await billing.listActivePlans();
    billing.seedSubscription({
      userId: U,
      planId: monthly?.id ?? '',
      stripeSubscriptionId: 'sub_old',
      status: 'lapsed',
    });
    expect((await service.getSubscription(U)).subscription?.status).toBe('lapsed');
  });

  it('never shows another user’s subscription', async () => {
    const [monthly] = await billing.listActivePlans();
    billing.seedSubscription({
      userId: V,
      planId: monthly?.id ?? '',
      stripeSubscriptionId: 'sub_v',
    });
    expect((await service.getSubscription(U)).subscription).toBeNull();
  });
});

describe('starting Checkout', () => {
  const caller = { userId: U, email: 'alice@example.test' };

  it('creates a Stripe customer and a subscription-mode Checkout session, and returns its hosted URL', async () => {
    const { url } = await service.startCheckout(caller, 'month');
    expect(url).toBe('https://checkout.stripe.test/c/1');
    expect(gateway.customers).toEqual([
      { userId: U, email: 'alice@example.test', key: `customer:${U}` },
    ]);
    expect(billing.customerOf(U)).toBe('cus_0001');

    const [checkout] = gateway.checkouts;
    expect(checkout?.input).toEqual({
      customerId: 'cus_0001',
      priceId: 'price_month_test',
      userId: U,
      planId: (await billing.listActivePlans())[0]?.id,
      charityId: riverside,
      charityBps: 1500,
      successUrl: 'https://app.test/account/subscription?checkout=success',
      cancelUrl: 'https://app.test/account/subscription?checkout=cancelled',
    });
  });

  it('sells the yearly plan when it is a real discount', async () => {
    await service.startCheckout(caller, 'year');
    expect(gateway.checkouts[0]?.input.priceId).toBe('price_year_test');
  });

  it('reuses the stored Stripe customer on the next checkout', async () => {
    await service.startCheckout(caller, 'month');
    await service.startCheckout(caller, 'year');
    expect(gateway.customers).toHaveLength(1);
    expect(gateway.checkouts.map((c) => c.input.customerId)).toEqual(['cus_0001', 'cus_0001']);
  });

  it('two simultaneous checkouts still end up with ONE customer', async () => {
    await Promise.all([
      service.startCheckout(caller, 'month'),
      service.startCheckout(caller, 'month'),
    ]);
    expect(new Set(gateway.customers.map((c) => c.key)).size).toBe(1); // same idempotency key at Stripe
    expect(billing.customerOf(U)).not.toBeNull();
    expect(new Set(gateway.checkouts.map((c) => c.input.customerId)).size).toBe(1);
  });

  it('omits the email when the account has none', async () => {
    await service.startCheckout({ userId: U, email: null }, 'month');
    expect(gateway.customers[0]?.email).toBeNull();
  });

  describe('CHR-01 / D-066: the charity precondition runs BEFORE anything is created at Stripe', () => {
    it('refuses with charity_required when no charity is selected — Stripe is never called', async () => {
      const err = await rejection(service.startCheckout({ userId: V, email: null }, 'month'));
      expect(err.status).toBe(422);
      expect(err.code).toBe(CHARITY_ERROR_CODES.selectionRequired);
      expect(gateway.calls).toBe(0);
      expect(billing.customerOf(V)).toBeNull();
    });

    it('refuses with selected_charity_unavailable when the selected charity was archived — Stripe is never called', async () => {
      charities.archive(riverside);
      const err = await rejection(service.startCheckout(caller, 'month'));
      expect(err.status).toBe(422);
      expect(err.code).toBe(CHARITY_ERROR_CODES.selectedUnavailable);
      expect(gateway.calls).toBe(0);
    });

    it('checkout works again once the archived charity is replaced', async () => {
      charities.archive(riverside);
      await rejection(service.startCheckout(caller, 'month'));
      const other = charities.seedCharity({ name: 'Other' });
      await createCharityService({ repository: charities }).updatePreference(U, {
        charityId: other,
      });
      await service.startCheckout(caller, 'month');
      expect(gateway.checkouts[0]?.input.charityId).toBe(other);
    });

    it('the snapshot sent to Stripe is the user’s CURRENT choice and percentage', async () => {
      charities.seedProfile(U, riverside, 4000);
      await service.startCheckout(caller, 'month');
      expect(gateway.checkouts[0]?.input).toMatchObject({ charityId: riverside, charityBps: 4000 });
    });

    it('is called through the injected precondition, once, before the gateway (call order)', async () => {
      const order: string[] = [];
      const spy = {
        requireSubscribableCharity: vi.fn((userId: string) => {
          order.push(`charity:${userId}`);
          return Promise.resolve({ charityId: riverside, percentageBps: 1000 });
        }),
      };
      const recording = {
        ...gateway,
        createCustomer: (i: never, k: string) => {
          order.push('stripe:customer');
          return gateway.createCustomer(i, k);
        },
        createCheckoutSession: (i: never, k: string) => {
          order.push('stripe:checkout');
          return gateway.createCheckoutSession(i, k);
        },
      } as unknown as FakeGateway;
      const s = createBillingService({
        repository: billing,
        gateway: recording,
        charities: spy,
        webOrigin: WEB,
        now: () => NOW,
      });
      await s.startCheckout(caller, 'month');
      expect(spy.requireSubscribableCharity).toHaveBeenCalledTimes(1);
      expect(order).toEqual([`charity:${U}`, 'stripe:customer', 'stripe:checkout']);
    });

    it('403 profile_missing for an account with no profile', async () => {
      const err = await rejection(service.startCheckout({ userId: 'ghost', email: null }, 'month'));
      expect(err.status).toBe(403);
      expect(err.code).toBe(AUTH_ERROR_CODES.profileMissing);
      expect(gateway.calls).toBe(0);
    });

    it('a storage failure in the precondition is not read as "fine": nothing is created', async () => {
      charities.failWith = new Error('db down');
      await expect(service.startCheckout(caller, 'month')).rejects.toThrow('db down');
      expect(gateway.calls).toBe(0);
    });
  });

  describe('eligibility (D-044: one live subscription at a time)', () => {
    it.each(['active', 'pending'] as const)(
      'refuses a user with a %s subscription (409 already_subscribed)',
      async (status) => {
        const [monthly] = await billing.listActivePlans();
        billing.seedSubscription({
          userId: U,
          planId: monthly?.id ?? '',
          stripeSubscriptionId: 'sub_1',
          status,
        });
        const err = await rejection(service.startCheckout(caller, 'month'));
        expect(err.status).toBe(409);
        expect(err.code).toBe(BILLING_ERROR_CODES.alreadySubscribed);
        expect(gateway.calls).toBe(0);
      },
    );

    it('lets a user whose subscription was cancelled subscribe again', async () => {
      const [monthly] = await billing.listActivePlans();
      billing.seedSubscription({
        userId: U,
        planId: monthly?.id ?? '',
        stripeSubscriptionId: 'sub_1',
        status: 'cancelled',
      });
      await expect(service.startCheckout(caller, 'month')).resolves.toBeDefined();
    });

    it('lets a user whose lapsed subscription has really EXPIRED at Stripe subscribe again', async () => {
      const [monthly] = await billing.listActivePlans();
      billing.seedSubscription({
        userId: U,
        planId: monthly?.id ?? '',
        stripeSubscriptionId: 'sub_1',
        status: 'lapsed',
        providerStatus: 'incomplete_expired',
      });
      await expect(service.startCheckout(caller, 'month')).resolves.toBeDefined();
    });

    it.each(['past_due', 'unpaid', 'paused'])(
      'refuses a user whose subscription is lapsed but still %s at Stripe — it is retrying and could become active again, so a second one could charge them twice',
      async (providerStatus) => {
        const [monthly] = await billing.listActivePlans();
        billing.seedSubscription({
          userId: U,
          planId: monthly?.id ?? '',
          stripeSubscriptionId: 'sub_1',
          status: 'lapsed',
          providerStatus,
        });
        const err = await rejection(service.startCheckout(caller, 'month'));
        expect(err.status).toBe(409);
        expect(err.code).toBe(BILLING_ERROR_CODES.alreadySubscribed);
        expect(gateway.calls).toBe(0);
      },
    );

    it("someone else's subscription does not block this user", async () => {
      const [monthly] = await billing.listActivePlans();
      billing.seedSubscription({
        userId: V,
        planId: monthly?.id ?? '',
        stripeSubscriptionId: 'sub_v',
      });
      await expect(service.startCheckout(caller, 'month')).resolves.toBeDefined();
    });
  });

  describe('plans', () => {
    it('422 plan_unavailable when there is no plan for the interval', async () => {
      billing = new InMemoryBilling();
      billing.seedPlan({ interval: 'month', amountMinor: 1000 });
      service = build();
      const err = await rejection(service.startCheckout(caller, 'year'));
      expect(err.status).toBe(422);
      expect(err.code).toBe(BILLING_ERROR_CODES.planUnavailable);
      expect(gateway.calls).toBe(0);
    });

    it('422 plan_unavailable for a plan with no Stripe price', async () => {
      billing = new InMemoryBilling();
      billing.seedPlan({ interval: 'month', amountMinor: 1000, stripePriceId: null });
      service = build();
      expect((await rejection(service.startCheckout(caller, 'month'))).code).toBe(
        BILLING_ERROR_CODES.planUnavailable,
      );
    });

    it('422 plan_unavailable for a yearly plan that is not a discount — it is never sold at the wrong price', async () => {
      billing = new InMemoryBilling();
      billing.seedPlan({ interval: 'month', amountMinor: 1000 });
      billing.seedPlan({ interval: 'year', amountMinor: 12000 });
      service = build();
      expect((await rejection(service.startCheckout(caller, 'year'))).code).toBe(
        BILLING_ERROR_CODES.planUnavailable,
      );
      await expect(service.startCheckout(caller, 'month')).resolves.toBeDefined();
    });
  });

  describe('idempotency: a double-click must not create two sessions', () => {
    it('the same request in the same 5-minute window carries the same Stripe idempotency key', async () => {
      await service.startCheckout(caller, 'month');
      await service.startCheckout(caller, 'month');
      expect(gateway.checkouts[0]?.key).toBe(gateway.checkouts[1]?.key);
    });

    it.each([
      [
        'a different plan',
        async () => {
          await service.startCheckout(caller, 'year');
        },
      ],
      [
        'a different charity',
        async () => {
          const c = charities.seedCharity({ name: 'B' });
          charities.seedProfile(U, c, 1500);
          await service.startCheckout(caller, 'month');
        },
      ],
      [
        'a different percentage',
        async () => {
          charities.seedProfile(U, riverside, 2500);
          await service.startCheckout(caller, 'month');
        },
      ],
      [
        'a later window',
        async () => {
          service = build({ now: () => new Date(NOW.getTime() + 6 * 60_000) });
          await service.startCheckout(caller, 'month');
        },
      ],
    ])('%s gets a different key', async (_label, change) => {
      await service.startCheckout(caller, 'month');
      await change();
      expect(gateway.checkouts[0]?.key).not.toBe(gateway.checkouts[1]?.key);
    });

    it('is scoped to the user', async () => {
      charities.seedProfile(V, riverside, 1500);
      await service.startCheckout(caller, 'month');
      await service.startCheckout({ userId: V, email: null }, 'month');
      expect(gateway.checkouts[0]?.key).not.toBe(gateway.checkouts[1]?.key);
    });
  });

  it('503 when Stripe is not configured — nothing else is touched', async () => {
    const s = build({ gateway: null });
    const err = await rejection(s.startCheckout(caller, 'month'));
    expect(err.status).toBe(503);
    expect(billing.customerOf(U)).toBeNull();
  });

  it('a Stripe failure is a generic 502 with no provider detail, and is logged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    gateway.failWith = new PaymentProviderError('create checkout session', {
      cause: new Error('rate limited; key sk_test_SECRET'),
    });
    const err = await rejection(service.startCheckout(caller, 'month'));
    expect(err.status).toBe(502);
    expect(err.code).toBe('payment_provider_error');
    expect(err.message).not.toMatch(/stripe|sk_test|rate/i);
    expect(log).toHaveBeenCalled();
  });
});

describe('the Billing Portal (SUB-04: cancellation, plan changes and card updates happen at Stripe)', () => {
  it('opens a portal session for the user’s Stripe customer and returns to the account page', async () => {
    billing.seedCustomer(U, 'cus_alice');
    expect(await service.openPortal(U)).toEqual({ url: 'https://billing.stripe.test/p/1' });
    expect(gateway.portals).toEqual([
      { customerId: 'cus_alice', returnUrl: 'https://app.test/account/subscription' },
    ]);
  });

  it('409 no_billing_account when the user has never started checkout', async () => {
    const err = await rejection(service.openPortal(U));
    expect(err.status).toBe(409);
    expect(err.code).toBe(BILLING_ERROR_CODES.noBillingAccount);
    expect(gateway.calls).toBe(0);
  });

  it('only ever opens the caller’s own customer', async () => {
    billing.seedCustomer(V, 'cus_bob');
    await rejection(service.openPortal(U));
    expect(gateway.portals).toHaveLength(0);
  });

  it('503 when Stripe is not configured', async () => {
    billing.seedCustomer(U, 'cus_alice');
    expect((await rejection(build({ gateway: null }).openPortal(U))).status).toBe(503);
  });

  it('a Stripe failure is a generic 502', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    billing.seedCustomer(U, 'cus_alice');
    gateway.failWith = new PaymentProviderError('create billing portal session');
    expect((await rejection(service.openPortal(U))).status).toBe(502);
  });
});
