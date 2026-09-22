import { isUuid } from '@gather/shared';

/**
 * The trust boundary for everything Stripe sends. A webhook is signature-verified before it gets here, but its
 * SHAPE is still untrusted input from another system (and Stripe's API versions move fields around: in the
 * `2025-…basil` line the invoice's subscription and a subscription's period moved, for example). Every parser takes
 * `unknown`, accepts both the current and the older shape where they differ, checks each field it uses, and throws
 * `InvalidStripeEventError` for anything unusable — so the rest of the billing code only ever sees clean values.
 *
 * Money is read as integers of minor units and rejected otherwise (D-003). Nothing here reads card data: the
 * events we handle do not carry it, and it is never requested.
 */

/** The payload is not something we can interpret at all. The webhook answers 400. */
export class InvalidStripeEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStripeEventError';
  }
}

/**
 * The payload is well-formed but cannot be applied (an unknown customer or price, a duplicate live subscription…).
 * Retrying cannot help, so the webhook acknowledges it (200) and the event is kept in the ledger as failed for a
 * person to look at; answering an error would only make Stripe retry it for days.
 */
export class UnprocessableEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnprocessableEventError';
  }
}

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

function rec(value: unknown, what: string): Rec {
  if (!isRec(value)) throw new InvalidStripeEventError(`${what} must be an object`);
  return value;
}
function str(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '')
    throw new InvalidStripeEventError(`${what} must be a non-empty string`);
  return value;
}
function optStr(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
/** A Stripe id that is either a plain string or an expanded object with an `id`. */
function refId(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  if (isRec(value)) return optStr(value.id);
  return null;
}
function bool(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new InvalidStripeEventError(`${what} must be a boolean`);
  return value;
}
/** A whole number of minor units (or seconds): a safe, non-negative integer. */
function nonNegInt(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidStripeEventError(`${what} must be a non-negative whole number`);
  }
  return value;
}
function optSeconds(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return new Date(nonNegInt(value, 'a timestamp') * 1000);
}

// ---- The event envelope -----------------------------------------------------------------------

export interface StripeEnvelope {
  id: string;
  type: string;
  /** Unix seconds: when Stripe created the event. Orders events (D-068). */
  created: Date;
  livemode: boolean;
  /** `data.object`, still untrusted. */
  object: unknown;
}

export function parseEnvelope(raw: unknown): StripeEnvelope {
  const event = rec(raw, 'the event');
  const data = rec(event.data, 'event.data');
  return {
    id: str(event.id, 'event.id'),
    type: str(event.type, 'event.type'),
    created: new Date(nonNegInt(event.created, 'event.created') * 1000),
    livemode: bool(event.livemode, 'event.livemode'),
    object: rec(data.object, 'event.data.object'),
  };
}

// ---- Our own metadata (set when Checkout is created) --------------------------------------------

/** Keys we write into Stripe metadata at checkout. They are a SNAPSHOT of what the user agreed to (D-069). */
export const METADATA_KEYS = {
  userId: 'gather_user_id',
  planId: 'gather_plan_id',
  charityId: 'gather_charity_id',
  charityBps: 'gather_charity_bps',
} as const;

export interface GatherMetadata {
  userId: string | null;
  planId: string | null;
  charityId: string | null;
  charityBps: number | null;
}

/** Reads our metadata; anything malformed is treated as absent rather than trusted. */
export function parseMetadata(value: unknown): GatherMetadata {
  const m = isRec(value) ? value : {};
  const uuid = (v: unknown) => (typeof v === 'string' && isUuid(v) ? v : null);
  const bpsText = m[METADATA_KEYS.charityBps];
  const bps = typeof bpsText === 'string' && /^\d{1,5}$/.test(bpsText) ? Number(bpsText) : null;
  return {
    userId: uuid(m[METADATA_KEYS.userId]),
    planId: uuid(m[METADATA_KEYS.planId]),
    charityId: uuid(m[METADATA_KEYS.charityId]),
    charityBps: bps,
  };
}

// ---- Subscription -----------------------------------------------------------------------------

export interface ProviderSubscription {
  id: string;
  customerId: string;
  /** Stripe's raw status, kept verbatim in `subscriptions.provider_status`. */
  status: string;
  priceId: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** When cancellation was requested (Stripe's `canceled_at`), not necessarily when access ends. */
  canceledAt: Date | null;
  endedAt: Date | null;
  metadata: GatherMetadata;
}

export function parseSubscription(raw: unknown): ProviderSubscription {
  const sub = rec(raw, 'the subscription');
  const items = isRec(sub.items) && Array.isArray(sub.items.data) ? sub.items.data : [];
  // One plan per subscription (PRD §04): more or fewer items is not something we created.
  if (items.length !== 1)
    throw new InvalidStripeEventError('the subscription must have exactly one item');
  const item = rec(items[0], 'the subscription item');
  const price = rec(item.price, 'the subscription item price');

  // The period moved from the subscription to its items in newer API versions: accept either.
  const start = sub.current_period_start ?? item.current_period_start;
  const end = sub.current_period_end ?? item.current_period_end;

  return {
    id: str(sub.id, 'subscription.id'),
    customerId:
      refId(sub.customer) ??
      (() => {
        throw new InvalidStripeEventError('subscription.customer is missing');
      })(),
    status: str(sub.status, 'subscription.status'),
    priceId: str(price.id, 'the subscription item price id'),
    periodStart: optSeconds(start),
    periodEnd: optSeconds(end),
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    canceledAt: optSeconds(sub.canceled_at),
    endedAt: optSeconds(sub.ended_at),
    metadata: parseMetadata(sub.metadata),
  };
}

// ---- Invoice ----------------------------------------------------------------------------------

export interface ProviderInvoice {
  id: string;
  customerId: string;
  /** Null for an invoice that does not belong to a subscription (not ours to record). */
  subscriptionId: string | null;
  paymentIntentId: string | null;
  /** Upper-case ISO 4217 code. */
  currency: string;
  /** Integer minor units actually collected. */
  amountPaid: number;
  amountDue: number;
  /** The invoice total, including any tax. */
  total: number;
  /** Total before tax (after discounts), when Stripe reports it. */
  totalExcludingTax: number | null;
  billingReason: string | null;
  paidAt: Date | null;
  /** The period the invoice pays for, from its lines (earliest start, latest end). */
  periodStart: Date | null;
  periodEnd: Date | null;
  /** Our snapshot from the subscription's metadata, as carried on the invoice. */
  metadata: GatherMetadata;
}

export function parseInvoice(raw: unknown): ProviderInvoice {
  const inv = rec(raw, 'the invoice');

  // The subscription link moved under `parent.subscription_details` in newer API versions: accept either.
  const parent =
    isRec(inv.parent) && isRec(inv.parent.subscription_details)
      ? inv.parent.subscription_details
      : null;
  const legacyDetails = isRec(inv.subscription_details) ? inv.subscription_details : null;
  const subscriptionId =
    refId(inv.subscription) ?? refId(parent?.subscription) ?? refId(legacyDetails?.subscription);
  const metadata = parseMetadata(parent?.metadata ?? legacyDetails?.metadata);

  const lines = isRec(inv.lines) && Array.isArray(inv.lines.data) ? inv.lines.data : [];
  let periodStart: Date | null = null;
  let periodEnd: Date | null = null;
  for (const line of lines) {
    if (!isRec(line) || !isRec(line.period)) continue;
    const s = optSeconds(line.period.start);
    const e = optSeconds(line.period.end);
    if (s && (!periodStart || s < periodStart)) periodStart = s;
    if (e && (!periodEnd || e > periodEnd)) periodEnd = e;
  }

  const currency = str(inv.currency, 'invoice.currency').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency))
    throw new InvalidStripeEventError('invoice.currency must be a 3-letter code');

  const transitions = isRec(inv.status_transitions) ? inv.status_transitions : {};
  const excl = inv.total_excluding_tax;
  return {
    id: str(inv.id, 'invoice.id'),
    customerId:
      refId(inv.customer) ??
      (() => {
        throw new InvalidStripeEventError('invoice.customer is missing');
      })(),
    subscriptionId,
    paymentIntentId: refId(inv.payment_intent),
    currency,
    amountPaid: nonNegInt(inv.amount_paid, 'invoice.amount_paid'),
    amountDue: nonNegInt(inv.amount_due, 'invoice.amount_due'),
    total: nonNegInt(inv.total, 'invoice.total'),
    totalExcludingTax:
      excl === null || excl === undefined ? null : nonNegInt(excl, 'invoice.total_excluding_tax'),
    billingReason: optStr(inv.billing_reason),
    paidAt: optSeconds(transitions.paid_at),
    periodStart,
    periodEnd,
    metadata,
  };
}

// ---- Checkout session -------------------------------------------------------------------------

export interface ProviderCheckoutSession {
  id: string;
  mode: string;
  customerId: string | null;
  subscriptionId: string | null;
  /** Our user id, set server-side when the session was created. */
  clientReferenceId: string | null;
}

export function parseCheckoutSession(raw: unknown): ProviderCheckoutSession {
  const s = rec(raw, 'the checkout session');
  return {
    id: str(s.id, 'session.id'),
    mode: str(s.mode, 'session.mode'),
    customerId: refId(s.customer),
    subscriptionId: refId(s.subscription),
    clientReferenceId: optStr(s.client_reference_id),
  };
}
