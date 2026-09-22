import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import {
  WEBHOOK_SECRET,
  at,
  sign,
  stripeEvent,
  stripeForTests,
  subscriptionObject,
} from '../test-support/stripe.js';
import {
  PaymentProviderError,
  WebhookSignatureError,
  createStripeGateway,
  createStripeGatewayFromConfig,
} from './gateway.js';
import { METADATA_KEYS, parseEnvelope } from './stripe-events.js';

const USER = '11111111-1111-4111-8111-111111111111';
const CHARITY = '22222222-2222-4222-8222-222222222222';
const PLAN = '33333333-3333-4333-8333-333333333333';

/** A stand-in for the SDK that records what would be sent to Stripe. No request is ever made. */
function fakeStripe(overrides: Record<string, unknown> = {}) {
  const calls: { method: string; params: unknown; options: unknown }[] = [];
  const record = (method: string, result: unknown) =>
    vi.fn((params: unknown, options?: unknown) => {
      calls.push({ method, params, options });
      return Promise.resolve(result);
    });
  const stripe = {
    customers: { create: record('customers.create', { id: 'cus_new' }) },
    checkout: {
      sessions: {
        create: record('checkout.sessions.create', {
          id: 'cs_1',
          url: 'https://checkout.stripe.test/c/1',
        }),
      },
    },
    billingPortal: {
      sessions: {
        create: record('billingPortal.sessions.create', { url: 'https://billing.stripe.test/p/1' }),
      },
    },
    subscriptions: {
      retrieve: vi.fn((id: string) => {
        calls.push({ method: 'subscriptions.retrieve', params: id, options: undefined });
        return Promise.resolve(subscriptionObject({ id }));
      }),
    },
    webhooks: stripeForTests.webhooks,
    ...overrides,
  };
  return { stripe: stripe as unknown as Stripe, calls };
}

const checkoutInput = {
  customerId: 'cus_1',
  priceId: 'price_1',
  userId: USER,
  planId: PLAN,
  charityId: CHARITY,
  charityBps: 1500,
  successUrl: 'https://app.test/ok',
  cancelUrl: 'https://app.test/no',
};

describe('customers', () => {
  it('creates a customer carrying only our user id (and the email when known), with an idempotency key', async () => {
    const { stripe, calls } = fakeStripe();
    expect(
      await createStripeGateway(stripe, WEBHOOK_SECRET).createCustomer(
        { userId: USER, email: 'a@example.test' },
        'customer:u',
      ),
    ).toEqual({ id: 'cus_new' });
    expect(calls[0]).toEqual({
      method: 'customers.create',
      params: { email: 'a@example.test', metadata: { [METADATA_KEYS.userId]: USER } },
      options: { idempotencyKey: 'customer:u' },
    });
  });

  it('omits the email when there is none', async () => {
    const { stripe, calls } = fakeStripe();
    await createStripeGateway(stripe, WEBHOOK_SECRET).createCustomer(
      { userId: USER, email: null },
      'k',
    );
    expect(calls[0]?.params).toEqual({ metadata: { [METADATA_KEYS.userId]: USER } });
  });
});

describe('Checkout sessions', () => {
  it('creates a hosted subscription-mode session for one price, returning to our pages', async () => {
    const { stripe, calls } = fakeStripe();
    const session = await createStripeGateway(stripe, WEBHOOK_SECRET).createCheckoutSession(
      checkoutInput,
      'checkout:k',
    );
    expect(session).toEqual({ id: 'cs_1', url: 'https://checkout.stripe.test/c/1' });
    const params = calls[0]?.params as Record<string, unknown>;
    expect(params).toMatchObject({
      mode: 'subscription',
      customer: 'cus_1',
      client_reference_id: USER,
      line_items: [{ price: 'price_1', quantity: 1 }],
      success_url: 'https://app.test/ok',
      cancel_url: 'https://app.test/no',
    });
    expect(calls[0]?.options).toEqual({ idempotencyKey: 'checkout:k' });
  });

  it('carries the charity snapshot on the session AND on the subscription (so every invoice can be attributed)', async () => {
    const { stripe, calls } = fakeStripe();
    await createStripeGateway(stripe, WEBHOOK_SECRET).createCheckoutSession(checkoutInput, 'k');
    const expected = {
      [METADATA_KEYS.userId]: USER,
      [METADATA_KEYS.planId]: PLAN,
      [METADATA_KEYS.charityId]: CHARITY,
      [METADATA_KEYS.charityBps]: '1500',
    };
    const params = calls[0]?.params as {
      metadata: unknown;
      subscription_data: { metadata: unknown };
    };
    expect(params.metadata).toEqual(expected);
    expect(params.subscription_data.metadata).toEqual(expected);
  });

  it('never sends card or payment credentials — they are entered on Stripe’s page (PRD SUB-02)', async () => {
    const { stripe, calls } = fakeStripe();
    await createStripeGateway(stripe, WEBHOOK_SECRET).createCheckoutSession(checkoutInput, 'k');
    const sent = JSON.stringify(calls[0]?.params);
    expect(sent).not.toMatch(/card|payment_method|source|token|cvc|number|expir/i);
  });

  it('refuses a response with no URL to send the user to', async () => {
    const { stripe } = fakeStripe({
      checkout: { sessions: { create: vi.fn(() => Promise.resolve({ id: 'cs_1', url: null })) } },
    });
    await expect(
      createStripeGateway(stripe, WEBHOOK_SECRET).createCheckoutSession(checkoutInput, 'k'),
    ).rejects.toBeInstanceOf(PaymentProviderError);
  });
});

describe('Billing Portal and subscription lookup', () => {
  it('creates a portal session for the customer that returns to our page', async () => {
    const { stripe, calls } = fakeStripe();
    expect(
      await createStripeGateway(stripe, WEBHOOK_SECRET).createPortalSession({
        customerId: 'cus_1',
        returnUrl: 'https://app.test/account/subscription',
      }),
    ).toEqual({ url: 'https://billing.stripe.test/p/1' });
    expect(calls[0]?.params).toEqual({
      customer: 'cus_1',
      return_url: 'https://app.test/account/subscription',
    });
  });

  it('retrieves a subscription by id (raw; parsed elsewhere)', async () => {
    const { stripe, calls } = fakeStripe();
    const raw = await createStripeGateway(stripe, WEBHOOK_SECRET).retrieveSubscription('sub_9');
    expect(calls[0]).toMatchObject({ method: 'subscriptions.retrieve', params: 'sub_9' });
    expect(raw).toMatchObject({ id: 'sub_9' });
  });
});

describe('price lookup (read-only, for the readiness check)', () => {
  it('normalises a Stripe price', async () => {
    const { stripe } = fakeStripe({
      prices: {
        retrieve: vi.fn((id: string) =>
          Promise.resolve({
            id,
            active: true,
            livemode: false,
            currency: 'usd',
            unit_amount: 1000,
            type: 'recurring',
            recurring: { interval: 'month', interval_count: 1 },
          }),
        ),
      },
    });
    expect(await createStripeGateway(stripe, WEBHOOK_SECRET).retrievePrice('price_1')).toEqual({
      id: 'price_1',
      active: true,
      livemode: false,
      currency: 'USD',
      unitAmount: 1000,
      type: 'recurring',
      interval: 'month',
      intervalCount: 1,
    });
  });

  it('a one-time price has no interval', async () => {
    const { stripe } = fakeStripe({
      prices: {
        retrieve: vi.fn(() =>
          Promise.resolve({
            id: 'p',
            active: true,
            livemode: true,
            currency: 'eur',
            unit_amount: null,
            type: 'one_time',
            recurring: null,
          }),
        ),
      },
    });
    expect(await createStripeGateway(stripe, WEBHOOK_SECRET).retrievePrice('p')).toMatchObject({
      currency: 'EUR',
      unitAmount: null,
      interval: null,
      intervalCount: null,
      livemode: true,
    });
  });

  it('wraps an SDK error', async () => {
    const { stripe } = fakeStripe({
      prices: { retrieve: vi.fn(() => Promise.reject(new Error('No such price'))) },
    });
    await expect(
      createStripeGateway(stripe, WEBHOOK_SECRET).retrievePrice('price_x'),
    ).rejects.toBeInstanceOf(PaymentProviderError);
  });
});

describe('provider failures', () => {
  it.each([
    [
      'createCustomer',
      (g: ReturnType<typeof createStripeGateway>) =>
        g.createCustomer({ userId: USER, email: null }, 'k'),
      { customers: { create: vi.fn(() => Promise.reject(new Error('boom'))) } },
    ],
    [
      'createCheckoutSession',
      (g: ReturnType<typeof createStripeGateway>) => g.createCheckoutSession(checkoutInput, 'k'),
      { checkout: { sessions: { create: vi.fn(() => Promise.reject(new Error('boom'))) } } },
    ],
    [
      'createPortalSession',
      (g: ReturnType<typeof createStripeGateway>) =>
        g.createPortalSession({ customerId: 'c', returnUrl: 'u' }),
      { billingPortal: { sessions: { create: vi.fn(() => Promise.reject(new Error('boom'))) } } },
    ],
    [
      'retrieveSubscription',
      (g: ReturnType<typeof createStripeGateway>) => g.retrieveSubscription('sub_1'),
      { subscriptions: { retrieve: vi.fn(() => Promise.reject(new Error('boom'))) } },
    ],
  ])(
    '%s wraps an SDK error in PaymentProviderError, keeping the cause for the logs only',
    async (_name, call, override) => {
      const { stripe } = fakeStripe(override);
      const error = await call(createStripeGateway(stripe, WEBHOOK_SECRET)).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(PaymentProviderError);
      expect((error as PaymentProviderError).cause).toEqual(new Error('boom'));
      expect((error as PaymentProviderError).message).not.toContain('boom');
    },
  );
});

describe('webhook signature verification — the REAL SDK check, no mocks', () => {
  const gateway = createStripeGateway(stripeForTests, WEBHOOK_SECRET);
  const event = stripeEvent('customer.subscription.updated', subscriptionObject(), {
    id: 'evt_sig',
  });

  it('accepts an event signed with the endpoint secret and returns it', () => {
    const { body, header } = sign(event);
    const verified = gateway.constructWebhookEvent(Buffer.from(body), header);
    expect(parseEnvelope(verified)).toMatchObject({
      id: 'evt_sig',
      type: 'customer.subscription.updated',
    });
  });

  it('accepts the body as a string too', () => {
    const { body, header } = sign(event);
    expect(() => gateway.constructWebhookEvent(body, header)).not.toThrow();
  });

  it('rejects a body altered by a single byte after signing', () => {
    const { body, header } = sign(event);
    expect(() =>
      gateway.constructWebhookEvent(Buffer.from(body.replace('evt_sig', 'evt_sih')), header),
    ).toThrow(WebhookSignatureError);
    expect(() => gateway.constructWebhookEvent(Buffer.from(`${body} `), header)).toThrow(
      WebhookSignatureError,
    );
  });

  it('rejects a body that was re-serialised (whitespace changed) — which is why the route needs the RAW bytes', () => {
    const { body, header } = sign(event);
    expect(() =>
      gateway.constructWebhookEvent(JSON.stringify(JSON.parse(body), null, 2), header),
    ).toThrow(WebhookSignatureError);
  });

  it('rejects a signature made with a different secret', () => {
    const { body, header } = sign(event, 'whsec_someoneelse');
    expect(() => gateway.constructWebhookEvent(Buffer.from(body), header)).toThrow(
      WebhookSignatureError,
    );
  });

  it.each([undefined, '', 'garbage', 't=1,v1=abc', 'v1=abc', 't=abc,v1=def'])(
    'rejects the header %j',
    (header) => {
      const { body } = sign(event);
      expect(() => gateway.constructWebhookEvent(Buffer.from(body), header)).toThrow(
        WebhookSignatureError,
      );
    },
  );

  it('rejects an old, replayed signature (outside the 5-minute tolerance)', () => {
    const body = JSON.stringify(event);
    const header = stripeForTests.webhooks.generateTestHeaderString({
      payload: body,
      secret: WEBHOOK_SECRET,
      timestamp: at('2020-01-01T00:00:00Z'),
    });
    expect(() => gateway.constructWebhookEvent(Buffer.from(body), header)).toThrow(
      WebhookSignatureError,
    );
  });

  it('a signature for one payload never verifies another', () => {
    const a = sign(event);
    const b = sign(stripeEvent('invoice.paid', {}, { id: 'evt_other' }));
    expect(() => gateway.constructWebhookEvent(Buffer.from(b.body), a.header)).toThrow(
      WebhookSignatureError,
    );
  });

  it('the error says nothing about WHICH check failed', () => {
    const { body } = sign(event);
    for (const header of [undefined, 'garbage']) {
      try {
        gateway.constructWebhookEvent(Buffer.from(body), header);
        throw new Error('expected a signature error');
      } catch (error) {
        expect(error).toBeInstanceOf(WebhookSignatureError);
        expect((error as Error).message).toBe('Invalid Stripe webhook signature');
      }
    }
  });
});

describe('createStripeGatewayFromConfig', () => {
  it('builds a gateway from a test-mode config without making any request', () => {
    const gateway = createStripeGatewayFromConfig({
      secretKey: 'sk_test_abc123',
      webhookSecret: WEBHOOK_SECRET,
    });
    const { body, header } = sign(stripeEvent('x', {}));
    expect(() => gateway.constructWebhookEvent(body, header)).not.toThrow();
  });
});
