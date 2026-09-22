import type { SupabaseClient } from '@supabase/supabase-js';
import type { BillingInterval, SubscriptionStatus } from '@gather/shared';
import { UnprocessableEventError } from './stripe-events.js';

/** A plan row (`plans`): prices are DATA, not code (ASM-07, D-067). */
export interface PlanRecord {
  id: string;
  name: string;
  interval: BillingInterval;
  amountMinor: number;
  currency: string;
  /** The Stripe price; a plan without one cannot be bought yet. */
  stripePriceId: string | null;
}

export interface SubscriptionRecord {
  id: string;
  userId: string;
  planName: string;
  interval: BillingInterval;
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  endedAt: Date | null;
}

export type ApplyResult = 'applied' | 'stale' | 'conflict';

export interface ApplySubscriptionInput {
  userId: string;
  planId: string;
  stripeSubscriptionId: string;
  status: SubscriptionStatus;
  providerStatus: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  cancelledAt: Date | null;
  endedAt: Date | null;
  /** The Stripe event's `created` time: an older event never overwrites a newer one. */
  eventAt: Date;
}

export interface RecordPaymentInput {
  userId: string;
  subscriptionId: string;
  stripeInvoiceId: string;
  stripePaymentIntentId: string | null;
  amountMinor: number;
  currency: string;
  state: 'succeeded' | 'failed';
  paidAt: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  /** The contribution snapshot — required for a succeeded payment (money is never left unattributed). */
  contribution: {
    charityId: string;
    percentageBps: number;
    basisMinor: number;
    amountMinor: number;
  } | null;
}

export type ClaimResult = 'new' | 'duplicate' | 'retry';

/**
 * Persistence for billing. Every method that writes money-related state goes through a service-role-only SQL
 * function (migration …140000) so it is atomic and safe to replay.
 */
export interface BillingRepository {
  listActivePlans(): Promise<PlanRecord[]>;
  findPlanByStripePriceId(priceId: string): Promise<PlanRecord | null>;
  /** The user's live (pending/active) subscription, else their most recent one, else null. */
  findCurrentSubscription(userId: string): Promise<SubscriptionRecord | null>;
  /**
   * CHECKOUT ELIGIBILITY — not access. Whether the user still has a subscription Stripe could bill or bring back
   * (pending, active, or lapsed-but-overdue: `past_due`, `unpaid`, `paused`), so a second one must not be started: it
   * could charge them twice. Only a subscription that is really over (`canceled`, `incomplete_expired`) is not open.
   * The rule lives in SQL as `has_open_subscription()`, beside `is_active_subscriber()` (access), and the two differ
   * on purpose (D-068).
   */
  hasOpenSubscription(userId: string): Promise<boolean>;
  getStripeCustomerId(userId: string): Promise<string | null>;
  findUserIdByStripeCustomer(customerId: string): Promise<string | null>;
  /** Stores the user ↔ customer mapping. An existing mapping wins; returns the id now stored. */
  saveStripeCustomer(userId: string, customerId: string): Promise<string>;
  findSubscriptionByStripeId(
    stripeSubscriptionId: string,
  ): Promise<{ id: string; userId: string } | null>;
  applySubscription(input: ApplySubscriptionInput): Promise<ApplyResult>;
  recordPayment(
    input: RecordPaymentInput,
  ): Promise<{ paymentCreated: boolean; contributionCreated: boolean }>;
  /** Idempotency ledger: 'new' → process it; 'duplicate' → already done; 'retry' → an earlier attempt did not finish. */
  claimEvent(event: {
    id: string;
    type: string;
    livemode: boolean;
    summary: unknown;
  }): Promise<ClaimResult>;
  markEvent(
    id: string,
    outcome: { status: 'processed' } | { status: 'failed'; error: string },
  ): Promise<void>;
}

// ---- parsing of rows (an untyped boundary) -------------------------------------------------------

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
function malformed(what: string): never {
  throw new Error(`Malformed ${what} row`);
}
const str = (v: unknown, what: string): string => (typeof v === 'string' ? v : malformed(what));
const int = (v: unknown, what: string): number =>
  typeof v === 'number' && Number.isSafeInteger(v) ? v : malformed(what);
const date = (v: unknown, what: string): Date | null => {
  if (v === null || v === undefined) return null;
  const d = new Date(str(v, what));
  return Number.isNaN(d.getTime()) ? malformed(what) : d;
};
function interval(v: unknown, what: string): BillingInterval {
  return v === 'month' || v === 'year' ? v : malformed(what);
}
function status(v: unknown, what: string): SubscriptionStatus {
  return v === 'pending' || v === 'active' || v === 'cancelled' || v === 'lapsed'
    ? v
    : malformed(what);
}

export function parsePlanRow(raw: unknown): PlanRecord {
  if (!isRow(raw)) return malformed('plan');
  return {
    id: str(raw.id, 'plan'),
    name: str(raw.name, 'plan'),
    interval: interval(raw.billing_interval, 'plan'),
    amountMinor: int(raw.amount_minor, 'plan'),
    currency: str(raw.currency, 'plan'),
    stripePriceId: typeof raw.stripe_price_id === 'string' ? raw.stripe_price_id : null,
  };
}

export function parseSubscriptionRow(raw: unknown): SubscriptionRecord {
  if (!isRow(raw) || !isRow(raw.plans)) return malformed('subscription');
  return {
    id: str(raw.id, 'subscription'),
    userId: str(raw.user_id, 'subscription'),
    planName: str(raw.plans.name, 'subscription'),
    interval: interval(raw.plans.billing_interval, 'subscription'),
    status: status(raw.status, 'subscription'),
    currentPeriodEnd: date(raw.current_period_end, 'subscription'),
    cancelAtPeriodEnd: raw.cancel_at_period_end === true,
    endedAt: date(raw.ended_at, 'subscription'),
  };
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** The SQL functions raise these SQLSTATEs for data that can never be applied (see the migration). */
function unprocessable(error: { code?: string; message: string }): never {
  throw new UnprocessableEventError(error.message);
}
const UNPROCESSABLE_CODES = new Set(['GS003', 'GS004', '23503', '23514', '23505']);

const SUBSCRIPTION_SELECT =
  'id, user_id, status, current_period_end, cancel_at_period_end, ended_at, created_at, plans(name, billing_interval)';

export function createSupabaseBillingRepository(client: SupabaseClient): BillingRepository {
  return {
    async listActivePlans() {
      const { data, error } = await client
        .from('plans')
        .select('id, name, billing_interval, amount_minor, currency, stripe_price_id')
        .eq('is_active', true)
        .order('billing_interval', { ascending: true });
      if (error) throw new Error(`Plan lookup failed: ${error.message}`);
      return (data as unknown[]).map(parsePlanRow);
    },

    async findPlanByStripePriceId(priceId) {
      // Retired plans included: a subscription may still be on a price that is no longer sold.
      const { data, error } = await client
        .from('plans')
        .select('id, name, billing_interval, amount_minor, currency, stripe_price_id')
        .eq('stripe_price_id', priceId)
        .maybeSingle();
      if (error) throw new Error(`Plan lookup failed: ${error.message}`);
      return data ? parsePlanRow(data) : null;
    },

    async findCurrentSubscription(userId) {
      const { data, error } = await client
        .from('subscriptions')
        .select(SUBSCRIPTION_SELECT)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw new Error(`Subscription lookup failed: ${error.message}`);
      const rows = (data as unknown[]).map(parseSubscriptionRow);
      return rows.find((r) => r.status === 'active' || r.status === 'pending') ?? rows[0] ?? null;
    },

    async hasOpenSubscription(userId) {
      const response = await client.rpc('has_open_subscription', { p_user_id: userId });
      // A failed lookup must not read as "nothing open": it fails the request, so no checkout is created.
      if (response.error) throw new Error(`Subscription lookup failed: ${response.error.message}`);
      const answer: unknown = response.data; // untyped by supabase-js
      if (typeof answer !== 'boolean')
        throw new Error('Subscription lookup returned an unexpected result');
      return answer;
    },

    async getStripeCustomerId(userId) {
      const { data, error } = await client
        .from('billing_customers')
        .select('stripe_customer_id')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw new Error(`Customer lookup failed: ${error.message}`);
      return isRow(data) && typeof data.stripe_customer_id === 'string'
        ? data.stripe_customer_id
        : null;
    },

    async findUserIdByStripeCustomer(customerId) {
      const { data, error } = await client
        .from('billing_customers')
        .select('user_id')
        .eq('stripe_customer_id', customerId)
        .maybeSingle();
      if (error) throw new Error(`Customer lookup failed: ${error.message}`);
      return isRow(data) && typeof data.user_id === 'string' ? data.user_id : null;
    },

    async saveStripeCustomer(userId, customerId) {
      const { error } = await client
        .from('billing_customers')
        .upsert(
          { user_id: userId, stripe_customer_id: customerId },
          { onConflict: 'user_id', ignoreDuplicates: true },
        );
      // 23505: this Stripe customer already belongs to a DIFFERENT user — never re-assign it.
      if (error) {
        if (error.code && UNPROCESSABLE_CODES.has(error.code)) unprocessable(error);
        throw new Error(`Customer save failed: ${error.message}`);
      }
      const { data, error: readError } = await client
        .from('billing_customers')
        .select('stripe_customer_id')
        .eq('user_id', userId)
        .single();
      if (readError) throw new Error(`Customer lookup failed: ${readError.message}`);
      return str((data as Row).stripe_customer_id, 'billing customer');
    },

    async findSubscriptionByStripeId(stripeSubscriptionId) {
      const { data, error } = await client
        .from('subscriptions')
        .select('id, user_id')
        .eq('stripe_subscription_id', stripeSubscriptionId)
        .maybeSingle();
      if (error) throw new Error(`Subscription lookup failed: ${error.message}`);
      return isRow(data)
        ? { id: str(data.id, 'subscription'), userId: str(data.user_id, 'subscription') }
        : null;
    },

    async applySubscription(input) {
      const response = await client.rpc('apply_provider_subscription', {
        p_user_id: input.userId,
        p_plan_id: input.planId,
        p_stripe_subscription_id: input.stripeSubscriptionId,
        p_status: input.status,
        p_provider_status: input.providerStatus,
        p_period_start: iso(input.periodStart),
        p_period_end: iso(input.periodEnd),
        p_cancel_at_period_end: input.cancelAtPeriodEnd,
        p_cancelled_at: iso(input.cancelledAt),
        p_ended_at: iso(input.endedAt),
        p_event_at: input.eventAt.toISOString(),
      });
      if (response.error) {
        if (response.error.code && UNPROCESSABLE_CODES.has(response.error.code))
          unprocessable(response.error);
        throw new Error(`Subscription update failed: ${response.error.message}`);
      }
      const result: unknown = response.data; // untyped by supabase-js
      if (result === 'applied' || result === 'stale' || result === 'conflict') return result;
      throw new Error('Subscription update returned an unexpected result');
    },

    async recordPayment(input) {
      const response = await client.rpc('record_subscription_payment', {
        p_user_id: input.userId,
        p_subscription_id: input.subscriptionId,
        p_stripe_invoice_id: input.stripeInvoiceId,
        p_stripe_payment_intent_id: input.stripePaymentIntentId,
        p_amount_minor: input.amountMinor,
        p_currency: input.currency,
        p_state: input.state,
        p_paid_at: iso(input.paidAt),
        p_period_start: iso(input.periodStart),
        p_period_end: iso(input.periodEnd),
        p_charity_id: input.contribution?.charityId ?? null,
        p_percentage_bps: input.contribution?.percentageBps ?? null,
        p_basis_minor: input.contribution?.basisMinor ?? null,
        p_contribution_minor: input.contribution?.amountMinor ?? null,
      });
      if (response.error) {
        if (response.error.code && UNPROCESSABLE_CODES.has(response.error.code))
          unprocessable(response.error);
        throw new Error(`Payment record failed: ${response.error.message}`);
      }
      const result: unknown = response.data; // untyped by supabase-js
      if (
        !isRow(result) ||
        typeof result.payment_created !== 'boolean' ||
        typeof result.contribution_created !== 'boolean'
      ) {
        throw new Error('Payment record returned an unexpected result');
      }
      return {
        paymentCreated: result.payment_created,
        contributionCreated: result.contribution_created,
      };
    },

    async claimEvent(event) {
      // The event id is the primary key: only the first delivery inserts a row (D-068).
      const inserted = await client
        .from('stripe_events')
        .upsert(
          { id: event.id, type: event.type, livemode: event.livemode, payload: event.summary },
          { onConflict: 'id', ignoreDuplicates: true },
        )
        .select('id');
      if (inserted.error) throw new Error(`Event ledger failed: ${inserted.error.message}`);
      if ((inserted.data as unknown[]).length > 0) return 'new';

      const existing = await client
        .from('stripe_events')
        .select('status')
        .eq('id', event.id)
        .single();
      if (existing.error) throw new Error(`Event ledger failed: ${existing.error.message}`);
      return isRow(existing.data) && existing.data.status === 'processed' ? 'duplicate' : 'retry';
    },

    async markEvent(id, outcome) {
      const patch =
        outcome.status === 'processed'
          ? { status: 'processed', processed_at: new Date().toISOString(), error: null }
          : { status: 'failed', processed_at: null, error: outcome.error.slice(0, 500) };
      const { error } = await client.from('stripe_events').update(patch).eq('id', id);
      if (error) throw new Error(`Event ledger failed: ${error.message}`);
    },
  };
}
