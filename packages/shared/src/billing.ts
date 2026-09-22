import { BPS_DENOMINATOR, MIN_CHARITY_BPS } from './domain.js';
import { BILLING_INTERVALS, type BillingInterval, type SubscriptionStatus } from './enums.js';
import type { FieldError } from './errors.js';
import type { Parsed } from './scores.js';

// ---- Paths ---------------------------------------------------------------------------------------

/** The active plans (monthly, discounted yearly): `GET /api/plans`. Public — visitors may "initiate subscription". */
export const API_PLANS_PATH = '/api/plans' as const;
/** The signed-in user's subscription: `GET /api/me/subscription`. */
export const API_MY_SUBSCRIPTION_PATH = '/api/me/subscription' as const;
/** Start Stripe Checkout: `POST /api/me/subscription/checkout`. */
export const API_MY_CHECKOUT_PATH = '/api/me/subscription/checkout' as const;
/** Open the Stripe Billing Portal: `POST /api/me/subscription/portal`. */
export const API_MY_PORTAL_PATH = '/api/me/subscription/portal' as const;
/** Stripe's signed webhooks: `POST /api/webhooks/stripe`. Not for browsers. */
export const API_STRIPE_WEBHOOK_PATH = '/api/webhooks/stripe' as const;

// ---- Contracts -----------------------------------------------------------------------------------

export interface PlanDto {
  id: string;
  name: string;
  interval: BillingInterval;
  /** Integer minor units of `currency` (D-003). */
  amountMinor: number;
  currency: string;
}

export interface ListPlansResponse {
  plans: PlanDto[];
}

export interface SubscriptionDto {
  id: string;
  status: SubscriptionStatus;
  planName: string;
  interval: BillingInterval;
  /** PRD §10: the dashboard shows the renewal date. */
  currentPeriodEnd: string | null;
  /** True when the user has asked to stop at the end of the paid period (access continues until then). */
  cancelAtPeriodEnd: boolean;
  endedAt: string | null;
}

export interface SubscriptionResponse {
  /** The user's current subscription, or their most recent one when none is live; `null` if they never had one. */
  subscription: SubscriptionDto | null;
  /** Whether the Billing Portal can be opened (the user has a Stripe customer). */
  canManageBilling: boolean;
}

export interface CreateCheckoutRequest {
  interval: BillingInterval;
}

/** Where to send the browser: Stripe's hosted Checkout page (or Billing Portal). No card data ever touches us. */
export interface RedirectResponse {
  url: string;
}

/** Stable `error.code` values for the billing endpoints (charity preconditions use `CHARITY_ERROR_CODES`). */
export const BILLING_ERROR_CODES = {
  /** The user already has a pending or active subscription. HTTP 409. */
  alreadySubscribed: 'already_subscribed',
  /** No purchasable plan exists for that interval (or the catalogue is misconfigured). HTTP 422. */
  planUnavailable: 'plan_unavailable',
  /** The user has no Stripe customer yet, so there is nothing to manage. HTTP 409. */
  noBillingAccount: 'no_billing_account',
} as const;

// ---- Validation ----------------------------------------------------------------------------------

/** Validates `POST /api/me/subscription/checkout`. Only `interval` is read; anything else is ignored. */
export function parseCreateCheckoutRequest(body: unknown): Parsed<CreateCheckoutRequest> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: 'body', message: 'A JSON object is required.' }] };
  }
  const { interval } = body as Record<string, unknown>;
  if (!(BILLING_INTERVALS as readonly unknown[]).includes(interval)) {
    const errors: FieldError[] = [
      { field: 'interval', message: `interval must be one of: ${BILLING_INTERVALS.join(', ')}.` },
    ];
    return { ok: false, errors };
  }
  return { ok: true, value: { interval: interval as BillingInterval } };
}

// ---- Money ---------------------------------------------------------------------------------------

/**
 * The charity's share of an amount (PRD §08 CHR-02/03; OWNER decision D-070, rounding up):
 * `percentage × basis`, **rounded UP** to a whole minor unit, so the charity never receives less than the
 * percentage the user chose (and never less than the PRD minimum of 10%). Exact integer arithmetic (BigInt), so
 * no floating-point error is possible however large the amount. The result never exceeds the basis.
 *
 * Throws for a basis that is not a positive safe integer, or a percentage that is not an integer between the PRD
 * minimum (10%) and 100%: a wrong input must never turn into a wrong amount of money.
 */
export function computeCharityContribution(basisMinor: number, percentageBps: number): number {
  if (!Number.isSafeInteger(basisMinor) || basisMinor < 1) {
    throw new RangeError('The contribution basis must be a positive whole number of minor units.');
  }
  if (
    !Number.isInteger(percentageBps) ||
    percentageBps < MIN_CHARITY_BPS ||
    percentageBps > BPS_DENOMINATOR
  ) {
    throw new RangeError(
      'The contribution percentage must be a whole number of basis points, 10%–100%.',
    );
  }
  const denominator = BigInt(BPS_DENOMINATOR);
  const exact = BigInt(basisMinor) * BigInt(percentageBps);
  return Number((exact + denominator - 1n) / denominator);
}

export interface InvoiceContribution {
  /** The basis recorded with the contribution: the amount collected, before tax, in whole minor units. */
  basisMinor: number;
  /** The charity's share, in whole minor units. Never more than `basisMinor`. */
  amountMinor: number;
}

/**
 * The charity's share of ONE collected invoice (OWNER decision D-070, building on CHR-02):
 *
 *   share = percentage × (the amount actually collected, BEFORE TAX, after discounts/coupons, gross of Stripe's fees)
 *
 * rounded UP to the smallest currency unit. Concretely, from an invoice's own figures:
 *  - `amountPaidMinor`     what was actually collected (a coupon has already reduced it);
 *  - `totalMinor`          the invoice total, including tax;
 *  - `totalExcludingTaxMinor`  the total before tax, or null when Stripe reports none.
 *
 * The tax is taken out of what was collected in proportion: `collected × excludingTax ÷ total`. A fully paid invoice
 * therefore has exactly its pre-tax total as the basis, and one only PART paid (a credit balance covered the rest)
 * counts only its pre-tax part — never any tax. Stripe's own processing fees are the platform's cost and are NOT
 * deducted. Everything is exact integer (BigInt) arithmetic with a single rounding, so no floating-point error is
 * possible; the recorded basis is rounded up too, which keeps `amount ≤ basis` (the database enforces it).
 *
 * Throws RangeError for inputs that cannot yield a contribution (nothing collected, nothing before tax, a percentage
 * outside 10%–100%): a wrong input must never turn into a wrong amount of money.
 */
export function computeInvoiceContribution(input: {
  amountPaidMinor: number;
  totalMinor: number;
  totalExcludingTaxMinor: number | null;
  percentageBps: number;
}): InvoiceContribution {
  const { amountPaidMinor, totalMinor, totalExcludingTaxMinor, percentageBps } = input;
  for (const [name, value] of [
    ['amount paid', amountPaidMinor],
    ['total', totalMinor],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(
        `The invoice ${name} must be a non-negative whole number of minor units.`,
      );
    }
  }
  if (
    totalExcludingTaxMinor !== null &&
    (!Number.isSafeInteger(totalExcludingTaxMinor) || totalExcludingTaxMinor < 0)
  ) {
    throw new RangeError(
      'The invoice total before tax must be a non-negative whole number of minor units.',
    );
  }
  if (amountPaidMinor < 1)
    throw new RangeError('Nothing was collected, so there is no contribution basis.');
  if (
    !Number.isInteger(percentageBps) ||
    percentageBps < MIN_CHARITY_BPS ||
    percentageBps > BPS_DENOMINATOR
  ) {
    throw new RangeError(
      'The contribution percentage must be a whole number of basis points, 10%–100%.',
    );
  }

  // Tax is present only when the pre-tax total is below the total. Otherwise everything collected is the basis.
  const taxed =
    totalExcludingTaxMinor !== null && totalMinor > 0 && totalExcludingTaxMinor < totalMinor;
  const numerator = BigInt(amountPaidMinor) * (taxed ? BigInt(totalExcludingTaxMinor) : 1n);
  const denominator = taxed ? BigInt(totalMinor) : 1n;
  if (numerator === 0n)
    throw new RangeError('There is no amount before tax to base a contribution on.');

  const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d;
  return {
    basisMinor: Number(ceilDiv(numerator, denominator)),
    amountMinor: Number(
      ceilDiv(numerator * BigInt(percentageBps), denominator * BigInt(BPS_DENOMINATOR)),
    ),
  };
}

/**
 * Whether a yearly plan really is a "discounted rate" (PRD §04, SUB-01): the same currency and strictly cheaper
 * than twelve months at the monthly price. Cross-row rules cannot be a table CHECK, so plans are validated here.
 */
export function isYearlyDiscounted(
  monthly: { amountMinor: number; currency: string },
  yearly: { amountMinor: number; currency: string },
): boolean {
  return monthly.currency === yearly.currency && yearly.amountMinor < monthly.amountMinor * 12;
}

/**
 * Formats integer minor units for display ("1250", "USD" → "$12.50"). The decimal string is built from the
 * integer with string arithmetic, so no floating-point division is involved.
 */
export function formatMinorUnits(amountMinor: number, currency: string, locale?: string): string {
  const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  const negative = amountMinor < 0;
  const scale = 10n ** BigInt(digits);
  const absolute = BigInt(Math.abs(amountMinor));
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(digits, '0');
  const text = `${negative ? '-' : ''}${whole.toString()}${digits > 0 ? `.${fraction}` : ''}`;
  return formatter.format(text as unknown as number);
}
