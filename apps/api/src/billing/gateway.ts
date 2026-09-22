import Stripe from 'stripe';
import type { StripeConfig } from '../config.js';
import { METADATA_KEYS } from './stripe-events.js';

/**
 * The ONLY place that talks to Stripe. Everything else in the API depends on the `PaymentGateway` interface below,
 * so the SDK (and its version-to-version churn) is contained here and the billing logic is tested without a
 * network. Card entry happens on Stripe-hosted pages (Checkout, Billing Portal): card numbers and other payment
 * credentials never reach this server, and nothing here asks for or stores them (PRD §04 SUB-02).
 */

/** The `Stripe-Signature` header did not verify, or was missing: the request is not from Stripe. */
export class WebhookSignatureError extends Error {
  constructor() {
    super('Invalid Stripe webhook signature');
    this.name = 'WebhookSignatureError';
  }
}

/** A call to Stripe failed (network, rate limit, invalid request…). The message is safe to log, not to show. */
export class PaymentProviderError extends Error {
  constructor(operation: string, options?: { cause?: unknown }) {
    super(`Stripe request failed: ${operation}`, options);
    this.name = 'PaymentProviderError';
  }
}

/** A Stripe price as far as the readiness check needs it (normalised; nothing secret). */
export interface ProviderPrice {
  id: string;
  active: boolean;
  livemode: boolean;
  /** Upper-case ISO 4217 code. */
  currency: string;
  /** Integer minor units; null for a price with no fixed amount (tiered/custom). */
  unitAmount: number | null;
  /** `recurring` for a subscription price. */
  type: string;
  interval: string | null;
  intervalCount: number | null;
}

export interface CheckoutInput {
  customerId: string;
  /** The Stripe price of the plan being bought. Prices live in Stripe and in `plans` (data, not code — ASM-07). */
  priceId: string;
  userId: string;
  planId: string;
  /** The charity and percentage the user agreed to: a snapshot carried with the subscription (D-069). */
  charityId: string;
  charityBps: number;
  successUrl: string;
  cancelUrl: string;
}

export interface PaymentGateway {
  createCustomer(
    input: { userId: string; email: string | null },
    idempotencyKey: string,
  ): Promise<{ id: string }>;
  createCheckoutSession(
    input: CheckoutInput,
    idempotencyKey: string,
  ): Promise<{ id: string; url: string }>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** The subscription as Stripe reports it now (raw; parse with `parseSubscription`). */
  retrieveSubscription(subscriptionId: string): Promise<unknown>;
  /** A price, read-only — used by the readiness check to compare `plans` with what Stripe will actually charge. */
  retrievePrice(priceId: string): Promise<ProviderPrice>;
  /** Verifies the signature over the RAW body and returns the event. Throws `WebhookSignatureError`. */
  constructWebhookEvent(rawBody: Buffer | string, signatureHeader: string | undefined): unknown;
}

async function call<T>(operation: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    throw new PaymentProviderError(operation, { cause: error });
  }
}

export function createStripeGateway(stripe: Stripe, webhookSecret: string): PaymentGateway {
  return {
    async createCustomer({ userId, email }, idempotencyKey) {
      const customer = await call('create customer', () =>
        stripe.customers.create(
          { ...(email && { email }), metadata: { [METADATA_KEYS.userId]: userId } },
          { idempotencyKey },
        ),
      );
      return { id: customer.id };
    },

    async createCheckoutSession(input, idempotencyKey) {
      const metadata = {
        [METADATA_KEYS.userId]: input.userId,
        [METADATA_KEYS.planId]: input.planId,
        [METADATA_KEYS.charityId]: input.charityId,
        [METADATA_KEYS.charityBps]: String(input.charityBps),
      };
      const session = await call('create checkout session', () =>
        stripe.checkout.sessions.create(
          {
            mode: 'subscription',
            customer: input.customerId,
            client_reference_id: input.userId,
            line_items: [{ price: input.priceId, quantity: 1 }],
            success_url: input.successUrl,
            cancel_url: input.cancelUrl,
            metadata,
            // Carried onto the subscription and its invoices, so every payment can be attributed to the
            // charity and percentage the user agreed to at checkout (D-069).
            subscription_data: { metadata },
          },
          { idempotencyKey },
        ),
      );
      if (!session.url) throw new PaymentProviderError('create checkout session (no url returned)');
      return { id: session.id, url: session.url };
    },

    async createPortalSession({ customerId, returnUrl }) {
      const session = await call('create billing portal session', () =>
        stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl }),
      );
      return { url: session.url };
    },

    retrieveSubscription(subscriptionId) {
      return call('retrieve subscription', () => stripe.subscriptions.retrieve(subscriptionId));
    },

    async retrievePrice(priceId) {
      const price = await call('retrieve price', () => stripe.prices.retrieve(priceId));
      return {
        id: price.id,
        active: price.active,
        livemode: price.livemode,
        currency: price.currency.toUpperCase(),
        unitAmount: price.unit_amount,
        type: price.type,
        interval: price.recurring?.interval ?? null,
        intervalCount: price.recurring?.interval_count ?? null,
      };
    },

    constructWebhookEvent(rawBody, signatureHeader) {
      if (!signatureHeader) throw new WebhookSignatureError();
      try {
        return stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
      } catch {
        // Deliberately no detail: which check failed is not something to tell the sender.
        throw new WebhookSignatureError();
      }
    },
  };
}

/**
 * The production gateway: the official SDK pinned to the API version it was built against (so the payload shapes
 * the parsers accept do not change under us), with a bounded timeout and a couple of automatic retries for
 * network errors. Retries are safe because every write carries an idempotency key.
 */
export function createStripeGatewayFromConfig(config: StripeConfig): PaymentGateway {
  const stripe = new Stripe(config.secretKey, {
    apiVersion: Stripe.API_VERSION,
    maxNetworkRetries: 2,
    timeout: 20_000,
  });
  return createStripeGateway(stripe, config.webhookSecret);
}
