import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_MY_CHECKOUT_PATH,
  API_MY_PORTAL_PATH,
  API_MY_SUBSCRIPTION_PATH,
  API_PLANS_PATH,
  API_STRIPE_WEBHOOK_PATH,
  BILLING_ERROR_CODES,
  CHARITY_ERROR_CODES,
  type ApiErrorBody,
  type ListPlansResponse,
  type RedirectResponse,
  type SubscriptionResponse,
} from '@gather/shared';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createCharityService } from '../charities/service.js';
import { FakeGateway, FakeSelection, InMemoryBilling } from '../test-support/billing.js';
import { InMemoryCharities } from '../test-support/charities.js';
import { ALICE, BOB, createTestAuth, type TestAuth } from '../test-support/auth.js';
import { request, type TestResponse } from '../test-support/http.js';
import {
  CUSTOMER,
  PRICE_MONTH,
  PRICE_YEAR,
  SUB,
  WEBHOOK_SECRET,
  invoiceObject,
  sign,
  stripeEvent,
  stripeForTests,
  subscriptionObject,
} from '../test-support/stripe.js';
import { PaymentProviderError, createStripeGateway } from './gateway.js';
import { createBillingService } from './service.js';
import { METADATA_KEYS } from './stripe-events.js';
import { createStripeWebhookHandler, createWebhookProcessor } from './webhooks.js';

const config = loadConfig({ NODE_ENV: 'test' });

let auth: TestAuth;
let billing: InMemoryBilling;
let gateway: FakeGateway;
let charities: InMemoryCharities;
let riverside: string;
let app: ReturnType<typeof createApp>;
let aliceToken: string;
let bobToken: string;

function buildApp(opts: { stripe?: boolean; billing?: boolean } = {}) {
  const charityService = createCharityService({ repository: charities });
  const processor = createWebhookProcessor({
    repository: billing,
    gateway,
    selection: new FakeSelection(),
  });
  return createApp(config, {
    auth: auth.deps,
    ...(opts.billing !== false && {
      billing: createBillingService({
        repository: billing,
        gateway: opts.stripe === false ? null : gateway,
        charities: charityService,
        webOrigin: 'https://app.test',
      }),
    }),
    // The webhook route verifies the REAL signature (the SDK's own check); only the network is absent.
    ...(opts.stripe !== false && {
      stripeWebhook: createStripeWebhookHandler(
        createStripeGateway(stripeForTests, WEBHOOK_SECRET),
        processor,
      ),
    }),
  });
}

beforeEach(async () => {
  auth = await createTestAuth();
  auth.profiles.add(ALICE, 'user');
  auth.profiles.add(BOB, 'user');
  billing = new InMemoryBilling();
  gateway = new FakeGateway();
  charities = new InMemoryCharities();
  riverside = charities.seedCharity({ name: 'Riverside' });
  charities.seedProfile(ALICE, riverside, 1500);
  charities.seedProfile(BOB, null, 1000);
  billing.seedPlan({ interval: 'month', amountMinor: 1000, stripePriceId: PRICE_MONTH });
  billing.seedPlan({ interval: 'year', amountMinor: 10000, stripePriceId: PRICE_YEAR });
  app = buildApp();
  aliceToken = await auth.signToken(ALICE);
  bobToken = await auth.signToken(BOB);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const errorOf = (res: TestResponse) => (res.body as ApiErrorBody).error;

describe('GET /api/plans — public', () => {
  it('lists the monthly and the yearly plan without sign-in', async () => {
    const res = await request(app).get(API_PLANS_PATH);
    expect(res.status).toBe(200);
    expect((res.body as ListPlansResponse).plans.map((p) => [p.interval, p.amountMinor])).toEqual([
      ['month', 1000],
      ['year', 10000],
    ]);
  });
  it('exposes no Stripe ids', async () => {
    expect((await request(app).get(API_PLANS_PATH)).text).not.toMatch(/price_|stripe/i);
  });
  it('is still readable when Stripe is not configured', async () => {
    expect((await request(buildApp({ stripe: false })).get(API_PLANS_PATH)).status).toBe(200);
  });
  it('503 when billing is not wired at all', async () => {
    expect((await request(buildApp({ billing: false })).get(API_PLANS_PATH)).status).toBe(503);
  });
});

describe('the user endpoints need a signed-in user', () => {
  const calls = [
    ['get', API_MY_SUBSCRIPTION_PATH],
    ['post', API_MY_CHECKOUT_PATH],
    ['post', API_MY_PORTAL_PATH],
  ] as const;

  it.each(calls)('%s %s without a token → 401 and Stripe is never called', async (method, path) => {
    const res = await request(app)[method](path).send({ interval: 'month' });
    expect(res.status).toBe(401);
    expect(gateway.calls).toBe(0);
  });

  it.each(calls)('%s %s with a forged token → 401', async (method, path) => {
    const forged = await auth.signWithUntrustedKey(ALICE);
    expect(
      (await request(app)[method](path).set(bearer(forged)).send({ interval: 'month' })).status,
    ).toBe(401);
    expect(gateway.calls).toBe(0);
  });

  it.each(calls)(
    '%s %s → 503 when billing is not wired (after authentication)',
    async (method, path) => {
      const bare = buildApp({ billing: false });
      expect(
        (await request(bare)[method](path).set(bearer(aliceToken)).send({ interval: 'month' }))
          .status,
      ).toBe(503);
    },
  );
});

describe('GET /api/me/subscription', () => {
  it('a user who never subscribed', async () => {
    const res = await request(app).get(API_MY_SUBSCRIPTION_PATH).set(bearer(aliceToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ subscription: null, canManageBilling: false });
  });

  it('shows the user’s own subscription only', async () => {
    const [monthly] = await billing.listActivePlans();
    billing.seedSubscription({
      userId: ALICE,
      planId: monthly?.id ?? '',
      stripeSubscriptionId: 'sub_a',
      periodEnd: new Date('2026-10-01T00:00:00Z'),
    });
    billing.seedCustomer(ALICE, 'cus_a');
    const a = (await request(app).get(API_MY_SUBSCRIPTION_PATH).set(bearer(aliceToken)))
      .body as SubscriptionResponse;
    expect(a.subscription).toMatchObject({
      status: 'active',
      interval: 'month',
      currentPeriodEnd: '2026-10-01T00:00:00.000Z',
    });
    expect(a.canManageBilling).toBe(true);
    const b = (await request(app).get(API_MY_SUBSCRIPTION_PATH).set(bearer(bobToken)))
      .body as SubscriptionResponse;
    expect(b.subscription).toBeNull();
  });

  it('a userId in the query string is ignored', async () => {
    const [monthly] = await billing.listActivePlans();
    billing.seedSubscription({
      userId: BOB,
      planId: monthly?.id ?? '',
      stripeSubscriptionId: 'sub_b',
    });
    const res = await request(app)
      .get(`${API_MY_SUBSCRIPTION_PATH}?userId=${BOB}`)
      .set(bearer(aliceToken));
    expect((res.body as SubscriptionResponse).subscription).toBeNull();
  });
});

describe('POST /api/me/subscription/checkout', () => {
  const checkout = (token: string, body: unknown) =>
    request(app).post(API_MY_CHECKOUT_PATH).set(bearer(token)).send(body);

  it('returns the hosted Checkout URL and creates the session for the CALLER with their charity snapshot', async () => {
    const res = await checkout(aliceToken, { interval: 'month' });
    expect(res.status).toBe(200);
    expect((res.body as RedirectResponse).url).toBe('https://checkout.stripe.test/c/1');
    expect(gateway.checkouts[0]?.input).toMatchObject({
      userId: ALICE,
      priceId: PRICE_MONTH,
      charityId: riverside,
      charityBps: 1500,
    });
    expect(gateway.customers[0]).toMatchObject({
      userId: ALICE,
      email: `${ALICE.slice(0, 8)}@example.test`,
    });
  });

  it('sells the yearly plan', async () => {
    await checkout(aliceToken, { interval: 'year' });
    expect(gateway.checkouts[0]?.input.priceId).toBe(PRICE_YEAR);
  });

  it('a userId, price, amount, charity or percentage in the body is IGNORED — the server decides all of them', async () => {
    await checkout(aliceToken, {
      interval: 'month',
      userId: BOB,
      priceId: 'price_evil',
      amount: 1,
      charityId: 'x',
      charityBps: 10000,
      currency: 'EUR',
      successUrl: 'https://evil.example',
    });
    expect(gateway.checkouts).toHaveLength(1);
    expect(gateway.checkouts[0]?.input).toMatchObject({
      userId: ALICE,
      priceId: PRICE_MONTH,
      charityId: riverside,
      charityBps: 1500,
    });
    expect(gateway.checkouts[0]?.input.successUrl).toMatch(/^https:\/\/app\.test\//);
  });

  it.each([
    {},
    { interval: 'week' },
    { interval: 'MONTH' },
    { interval: 12 },
    { interval: null },
    { interval: ['month'] },
  ])('rejects the invalid body %j → 400 naming interval, Stripe untouched', async (body) => {
    const res = await checkout(aliceToken, body);
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('validation_failed');
    expect(errorOf(res).fieldErrors?.map((e) => e.field)).toContain('interval');
    expect(gateway.calls).toBe(0);
  });

  describe('CHR-01 (D-066): the charity precondition is enforced over HTTP, before anything is created', () => {
    it('no selected charity → 422 charity_required and NO Stripe call', async () => {
      const res = await checkout(bobToken, { interval: 'month' });
      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe(CHARITY_ERROR_CODES.selectionRequired);
      expect(gateway.calls).toBe(0);
    });

    it('a selected charity that was archived → 422 selected_charity_unavailable and NO Stripe call', async () => {
      charities.archive(riverside);
      const res = await checkout(aliceToken, { interval: 'month' });
      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe(CHARITY_ERROR_CODES.selectedUnavailable);
      expect(gateway.calls).toBe(0);
    });

    it('works again once the user has chosen another charity', async () => {
      charities.archive(riverside);
      const other = charities.seedCharity({ name: 'Other' });
      charities.seedProfile(ALICE, other, 1500);
      expect((await checkout(aliceToken, { interval: 'month' })).status).toBe(200);
      expect(gateway.checkouts[0]?.input.charityId).toBe(other);
    });
  });

  it('409 already_subscribed for a user with a live subscription', async () => {
    const [monthly] = await billing.listActivePlans();
    billing.seedSubscription({
      userId: ALICE,
      planId: monthly?.id ?? '',
      stripeSubscriptionId: 'sub_a',
    });
    const res = await checkout(aliceToken, { interval: 'month' });
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe(BILLING_ERROR_CODES.alreadySubscribed);
    expect(gateway.calls).toBe(0);
  });

  it('422 plan_unavailable when the plan cannot be sold', async () => {
    billing = new InMemoryBilling();
    app = buildApp();
    const res = await checkout(aliceToken, { interval: 'month' });
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe(BILLING_ERROR_CODES.planUnavailable);
  });

  it('503 when Stripe is not configured', async () => {
    const res = await request(buildApp({ stripe: false }))
      .post(API_MY_CHECKOUT_PATH)
      .set(bearer(aliceToken))
      .send({ interval: 'month' });
    expect(res.status).toBe(503);
  });

  it('a Stripe outage is a generic 502 that leaks nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    gateway.failWith = new PaymentProviderError('create checkout session', {
      cause: new Error('secret internal detail sk_test_abc'),
    });
    const res = await checkout(aliceToken, { interval: 'month' });
    expect(res.status).toBe(502);
    expect(res.text).not.toMatch(/secret|sk_test|stripe/i);
    expect(errorOf(res).code).toBe('payment_provider_error');
  });

  it('two users get their own sessions and customers', async () => {
    charities.seedProfile(BOB, riverside, 1000);
    await checkout(aliceToken, { interval: 'month' });
    await checkout(bobToken, { interval: 'month' });
    expect(gateway.checkouts.map((c) => c.input.userId)).toEqual([ALICE, BOB]);
    expect(new Set(gateway.checkouts.map((c) => c.input.customerId)).size).toBe(2);
  });
});

describe('POST /api/me/subscription/portal', () => {
  it('opens the portal for the caller’s own Stripe customer', async () => {
    billing.seedCustomer(ALICE, 'cus_alice');
    billing.seedCustomer(BOB, 'cus_bob');
    const res = await request(app).post(API_MY_PORTAL_PATH).set(bearer(aliceToken));
    expect(res.status).toBe(200);
    expect((res.body as RedirectResponse).url).toBe('https://billing.stripe.test/p/1');
    expect(gateway.portals).toEqual([
      { customerId: 'cus_alice', returnUrl: 'https://app.test/account/subscription' },
    ]);
  });
  it('a customerId in the body cannot open someone else’s portal', async () => {
    billing.seedCustomer(ALICE, 'cus_alice');
    await request(app)
      .post(API_MY_PORTAL_PATH)
      .set(bearer(aliceToken))
      .send({ customerId: 'cus_bob', userId: BOB });
    expect(gateway.portals.map((p) => p.customerId)).toEqual(['cus_alice']);
  });
  it('409 no_billing_account before any checkout', async () => {
    const res = await request(app).post(API_MY_PORTAL_PATH).set(bearer(aliceToken));
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe(BILLING_ERROR_CODES.noBillingAccount);
  });
});

describe('POST /api/webhooks/stripe — verified, idempotent', () => {
  const subEvent = (id = 'evt_w1') =>
    stripeEvent(
      'customer.subscription.created',
      subscriptionObject({
        metadata: {
          [METADATA_KEYS.userId]: ALICE,
          [METADATA_KEYS.charityId]: riverside,
          [METADATA_KEYS.charityBps]: '1500',
        },
      }),
      { id },
    );
  const deliver = (body: string, header: string | undefined, contentType = 'application/json') =>
    request(app)
      .post(API_STRIPE_WEBHOOK_PATH)
      .set({ ...(header && { 'stripe-signature': header }), 'content-type': contentType })
      .send(body);
  const signedDelivery = (event: unknown) => {
    const { body, header } = sign(event);
    return deliver(body, header);
  };

  it('applies a correctly signed event, with NO user session', async () => {
    const res = await signedDelivery(subEvent());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, outcome: 'processed' });
    expect(billing.subscriptionByStripeId(SUB)).toMatchObject({ userId: ALICE, status: 'active' });
    expect(billing.customerOf(ALICE)).toBe(CUSTOMER);
  });

  it('a session / cookie / bearer token is neither needed nor honoured — the signature is the authentication', async () => {
    const { body, header } = sign(subEvent());
    const res = await request(app)
      .post(API_STRIPE_WEBHOOK_PATH)
      .set({
        'stripe-signature': header,
        'content-type': 'application/json',
        Authorization: `Bearer ${aliceToken}`,
      })
      .send(body);
    expect(res.status).toBe(200);
    // …and a valid bearer token does NOT make an unsigned request acceptable:
    const unsigned = await request(app)
      .post(API_STRIPE_WEBHOOK_PATH)
      .set({ 'content-type': 'application/json', Authorization: `Bearer ${aliceToken}` })
      .send(body);
    expect(unsigned.status).toBe(400);
  });

  it('a redelivery is acknowledged as a duplicate and changes nothing', async () => {
    const event = subEvent('evt_dup');
    await signedDelivery(event);
    const before = JSON.stringify(billing.subscriptions);
    const again = await signedDelivery(event);
    expect(again.status).toBe(200);
    expect((again.body as { outcome: string }).outcome).toBe('duplicate');
    expect(JSON.stringify(billing.subscriptions)).toBe(before);
  });

  it('a paid invoice is recorded once even if Stripe sends it several times', async () => {
    await signedDelivery(subEvent());
    const paid = stripeEvent(
      'invoice.paid',
      invoiceObject({
        metadata: { [METADATA_KEYS.charityId]: riverside, [METADATA_KEYS.charityBps]: '1500' },
      }),
      { id: 'evt_paid' },
    );
    await Promise.all([signedDelivery(paid), signedDelivery(paid), signedDelivery(paid)]);
    expect(billing.paymentsOf(ALICE)).toHaveLength(1);
    expect(billing.contributionsOf(ALICE)).toHaveLength(1);
  });

  describe('invalid signatures are refused (400, generic) and nothing is applied', () => {
    const untouched = () => {
      expect(billing.subscriptions).toHaveLength(0);
      expect(billing.ledger.size).toBe(0);
    };
    const generic = (res: TestResponse) => {
      expect(res.status).toBe(400);
      expect(errorOf(res)).toEqual({
        code: 'invalid_webhook',
        message: 'The request could not be processed.',
      });
    };

    it('no Stripe-Signature header', async () => {
      generic(await deliver(sign(subEvent()).body, undefined));
      untouched();
    });
    it('a signature made with the wrong secret', async () => {
      const { body, header } = sign(subEvent(), 'whsec_attacker');
      generic(await deliver(body, header));
      untouched();
    });
    it('a body altered after signing', async () => {
      const { body, header } = sign(subEvent());
      generic(await deliver(body.replace('"active"', '"trialing"'), header));
      untouched();
    });
    it('a body RE-SERIALISED after signing (proves the RAW bytes are verified, not parsed-and-rewritten JSON)', async () => {
      const { body, header } = sign(subEvent());
      generic(await deliver(JSON.stringify(JSON.parse(body), null, 2), header));
      untouched();
    });
    it('the same content with different whitespace verifies only if the signature was made over THOSE bytes', async () => {
      const pretty = JSON.stringify(subEvent(), null, 2);
      const { body, header } = sign(pretty);
      expect((await deliver(body, header)).status).toBe(200);
    });
    it('a garbage or replayed (old timestamp) header', async () => {
      const { body } = sign(subEvent());
      generic(await deliver(body, 'garbage'));
      const old = stripeForTests.webhooks.generateTestHeaderString({
        payload: body,
        secret: WEBHOOK_SECRET,
        timestamp: 1_600_000_000,
      });
      generic(await deliver(body, old));
      untouched();
    });
    it('an empty body', async () => {
      generic(await deliver('', sign('x').header));
      untouched();
    });
    it('a validly signed body that is not JSON', async () => {
      const { body, header } = sign('this is not json');
      generic(await deliver(body, header));
      untouched();
    });
    it('the error never reveals which check failed', async () => {
      const results = await Promise.all([
        deliver(sign(subEvent()).body, undefined),
        deliver(sign(subEvent(), 'whsec_x').body, sign(subEvent(), 'whsec_x').header),
      ]);
      expect(new Set(results.map((r) => r.text)).size).toBe(1);
    });
  });

  it('a signed but unreadable event is refused (400)', async () => {
    const res = await signedDelivery({ id: 'evt_bad', type: 'x' });
    expect(res.status).toBe(400);
  });

  it('a signed LIVE-mode event is refused and not applied (test mode only)', async () => {
    const res = await signedDelivery(
      stripeEvent(
        'customer.subscription.created',
        subscriptionObject({ metadata: { [METADATA_KEYS.userId]: ALICE } }),
        { livemode: true },
      ),
    );
    expect(res.status).toBe(400);
    expect(billing.subscriptions).toHaveLength(0);
  });

  it('an event type we do not handle is acknowledged (200) and ignored', async () => {
    const res = await signedDelivery(stripeEvent('customer.created', { id: 'cus_1' }));
    expect(res.status).toBe(200);
    expect((res.body as { outcome: string }).outcome).toBe('ignored');
  });

  it('a well-formed event we can never apply is acknowledged (200) so Stripe stops retrying', async () => {
    const res = await signedDelivery(
      stripeEvent(
        'customer.subscription.created',
        subscriptionObject({
          priceId: 'price_unknown',
          metadata: { [METADATA_KEYS.userId]: ALICE },
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect((res.body as { outcome: string }).outcome).toBe('unprocessable');
  });

  it('a transient failure is a generic 500 (Stripe redelivers), then the redelivery succeeds exactly once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await signedDelivery(subEvent('evt_setup'));
    const paid = stripeEvent(
      'invoice.paid',
      invoiceObject({
        metadata: { [METADATA_KEYS.charityId]: riverside, [METADATA_KEYS.charityBps]: '1500' },
      }),
      { id: 'evt_flaky' },
    );
    billing.failNext('recordPayment');
    const first = await signedDelivery(paid);
    expect(first.status).toBe(500);
    expect(errorOf(first).code).toBe('internal_error');
    expect(first.text).not.toMatch(/simulated|database|outage/i);
    const second = await signedDelivery(paid);
    expect(second.status).toBe(200);
    expect(billing.paymentsOf(ALICE)).toHaveLength(1);
  });

  it('is accepted whatever Content-Type Stripe uses (the body is always read raw)', async () => {
    const { body, header } = sign(subEvent('evt_ct'));
    expect((await deliver(body, header, 'text/plain')).status).toBe(200);
  });

  it('is POST-only', async () => {
    expect((await request(app).get(API_STRIPE_WEBHOOK_PATH)).status).toBe(404);
    expect((await request(app).put(API_STRIPE_WEBHOOK_PATH).send('x')).status).toBe(404);
  });

  it('503 when Stripe is not configured — and it never reaches the database', async () => {
    const bare = buildApp({ stripe: false });
    const { body, header } = sign(subEvent());
    const res = await request(bare)
      .post(API_STRIPE_WEBHOOK_PATH)
      .set({ 'stripe-signature': header, 'content-type': 'application/json' })
      .send(body);
    expect(res.status).toBe(503);
    expect(billing.ledger.size).toBe(0);
  });

  it('an over-large body is refused before it is read into memory', async () => {
    const res = await deliver('x'.repeat(1_100_000), sign('x').header);
    expect(res.status).toBe(413);
  });

  it('the webhook is exempt from the JSON parser but the rest of the API still rejects malformed JSON', async () => {
    const res = await request(app)
      .post(API_MY_CHECKOUT_PATH)
      .set({ ...bearer(aliceToken), 'content-type': 'application/json' })
      .send('{"broken":');
    expect(res.status).toBe(400);
  });
});
