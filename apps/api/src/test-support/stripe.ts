import Stripe from 'stripe';

/**
 * Builders for Stripe payloads in the shape Stripe sends, plus REAL webhook signing. The signature is computed
 * with the official SDK's own helper and verified by the production code path, so a webhook test proves the
 * actual HMAC check — only the network is absent (the signer never makes a request).
 */

export const WEBHOOK_SECRET = 'whsec_testsecret123';
export const PRICE_MONTH = 'price_month_test';
export const PRICE_YEAR = 'price_year_test';
export const CUSTOMER = 'cus_test_alice';
export const SUB = 'sub_test_1';

/** Unix seconds for readable dates. */
export const at = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

export const PERIOD_1 = { start: at('2026-09-01T00:00:00Z'), end: at('2026-10-01T00:00:00Z') };
export const PERIOD_2 = { start: at('2026-10-01T00:00:00Z'), end: at('2026-11-01T00:00:00Z') };

export interface SubscriptionOptions {
  id?: string;
  customer?: string;
  status?: string;
  priceId?: string;
  period?: { start: number; end: number };
  cancelAtPeriodEnd?: boolean;
  canceledAt?: number | null;
  endedAt?: number | null;
  metadata?: Record<string, string>;
  /** Older API versions carry the period on the subscription itself, newer ones on its items. */
  legacyPeriod?: boolean;
  items?: number;
}

export function subscriptionObject(o: SubscriptionOptions = {}): Record<string, unknown> {
  const period = o.period ?? PERIOD_1;
  const item = {
    id: 'si_1',
    price: { id: o.priceId ?? PRICE_MONTH },
    ...(o.legacyPeriod
      ? {}
      : { current_period_start: period.start, current_period_end: period.end }),
  };
  return {
    id: o.id ?? SUB,
    object: 'subscription',
    customer: o.customer ?? CUSTOMER,
    status: o.status ?? 'active',
    cancel_at_period_end: o.cancelAtPeriodEnd ?? false,
    canceled_at: o.canceledAt ?? null,
    ended_at: o.endedAt ?? null,
    metadata: o.metadata ?? {},
    ...(o.legacyPeriod && { current_period_start: period.start, current_period_end: period.end }),
    items: { data: Array.from({ length: o.items ?? 1 }, () => item) },
  };
}

export interface InvoiceOptions {
  id?: string;
  customer?: string;
  subscription?: string | null;
  currency?: string;
  amountPaid?: number;
  amountDue?: number;
  /** The invoice total including tax. Defaults to the largest of what was paid, due and pre-tax. */
  total?: number;
  totalExcludingTax?: number | null;
  billingReason?: string;
  paidAt?: number | null;
  period?: { start: number; end: number };
  metadata?: Record<string, string>;
  paymentIntent?: string | null;
  /** Older API versions put the subscription directly on the invoice. */
  legacy?: boolean;
}

export function invoiceObject(o: InvoiceOptions = {}): Record<string, unknown> {
  const subscription = o.subscription === undefined ? SUB : o.subscription;
  const period = o.period ?? PERIOD_1;
  const amountPaid = o.amountPaid ?? 1000;
  return {
    id: o.id ?? 'in_test_1',
    object: 'invoice',
    customer: o.customer ?? CUSTOMER,
    currency: o.currency ?? 'usd',
    amount_paid: amountPaid,
    amount_due: o.amountDue ?? amountPaid,
    total: o.total ?? Math.max(amountPaid, o.amountDue ?? amountPaid, o.totalExcludingTax ?? 0),
    total_excluding_tax: o.totalExcludingTax === undefined ? amountPaid : o.totalExcludingTax,
    billing_reason: o.billingReason ?? 'subscription_create',
    status_transitions: { paid_at: o.paidAt === undefined ? at('2026-09-01T00:00:05Z') : o.paidAt },
    lines: { data: [{ period: { start: period.start, end: period.end } }] },
    ...(o.legacy
      ? {
          subscription,
          subscription_details: { metadata: o.metadata ?? {} },
          payment_intent: o.paymentIntent === undefined ? 'pi_test_1' : o.paymentIntent,
        }
      : {
          parent: {
            type: 'subscription_details',
            subscription_details:
              subscription === null ? null : { subscription, metadata: o.metadata ?? {} },
          },
        }),
  };
}

export function checkoutSessionObject(
  o: {
    id?: string;
    mode?: string;
    customer?: string | null;
    subscription?: string | null;
    clientReferenceId?: string | null;
  } = {},
): Record<string, unknown> {
  return {
    id: o.id ?? 'cs_test_1',
    object: 'checkout.session',
    mode: o.mode ?? 'subscription',
    customer: o.customer === undefined ? CUSTOMER : o.customer,
    subscription: o.subscription === undefined ? SUB : o.subscription,
    client_reference_id: o.clientReferenceId === undefined ? null : o.clientReferenceId,
  };
}

let eventCounter = 0;
export function stripeEvent(
  type: string,
  object: unknown,
  o: { id?: string; created?: number; livemode?: boolean } = {},
): Record<string, unknown> {
  eventCounter += 1;
  return {
    id: o.id ?? `evt_test_${String(eventCounter).padStart(4, '0')}`,
    object: 'event',
    type,
    created: o.created ?? at('2026-09-01T00:00:10Z'),
    livemode: o.livemode ?? false,
    data: { object },
  };
}

const signer = new Stripe('sk_test_signer_only', { apiVersion: Stripe.API_VERSION });

/** The exact bytes and a genuine `Stripe-Signature` header for them. */
export function sign(payload: unknown, secret = WEBHOOK_SECRET): { body: string; header: string } {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { body, header: signer.webhooks.generateTestHeaderString({ payload: body, secret }) };
}

export { signer as stripeForTests };
