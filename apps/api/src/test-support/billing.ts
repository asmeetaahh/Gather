import { MIN_CHARITY_BPS, type BillingInterval, type SubscriptionStatus } from '@gather/shared';
import {
  PaymentProviderError,
  type CheckoutInput,
  type PaymentGateway,
  type ProviderPrice,
} from '../billing/gateway.js';
import type {
  ApplyResult,
  ApplySubscriptionInput,
  BillingRepository,
  ClaimResult,
  PlanRecord,
  RecordPaymentInput,
  SubscriptionRecord,
} from '../billing/repository.js';
import { UnprocessableEventError } from '../billing/stripe-events.js';
import type { SelectionReader } from '../billing/webhooks.js';

/**
 * In-memory stand-ins for the billing boundaries. `InMemoryBilling` applies the SAME rules the SQL functions do
 * (older events ignored, one live subscription per user, idempotent payments keyed by invoice, a succeeded payment
 * always carries its contribution, money is never downgraded) so webhook scenarios read naturally. It is NOT the
 * authority: supabase/tests/billing.test.ts proves those rules on PostgreSQL.
 */

interface StoredSubscription {
  id: string;
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
  eventAt: Date;
  createdAt: number;
}

export interface StoredPayment {
  id: string;
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
}

export interface StoredContribution {
  paymentId: string;
  userId: string;
  charityId: string;
  percentageBps: number;
  basisMinor: number;
  amountMinor: number;
  currency: string;
}

export interface LedgerRow {
  id: string;
  type: string;
  status: 'received' | 'processed' | 'failed';
  error: string | null;
  summary: unknown;
}

export class InMemoryBilling implements BillingRepository {
  private readonly plans: PlanRecord[] = [];
  private readonly customers = new Map<string, string>(); // userId → customerId
  readonly subscriptions: StoredSubscription[] = [];
  readonly payments: StoredPayment[] = [];
  readonly contributions: StoredContribution[] = [];
  readonly ledger = new Map<string, LedgerRow>();
  private nextId = 1;
  failWith: Error | null = null;
  /** Make the next `n` calls of the named method throw (simulates a transient outage). */
  private failures = new Map<string, number>();
  readonly calls = { recordPayment: 0, applySubscription: 0, saveStripeCustomer: 0 };

  private id(prefix: string): string {
    return `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`.replace(
      '00000000',
      prefix.padEnd(8, '0'),
    );
  }

  failNext(method: string, times = 1): void {
    this.failures.set(method, times);
  }
  private maybeFail(method: string): void {
    if (this.failWith) throw this.failWith;
    const left = this.failures.get(method) ?? 0;
    if (left > 0) {
      this.failures.set(method, left - 1);
      throw new Error(`${method}: simulated database outage`);
    }
  }

  // ---- seeding / inspection -------------------------------------------------------------------
  seedPlan(p: {
    interval: BillingInterval;
    amountMinor: number;
    stripePriceId?: string | null;
    currency?: string;
    name?: string;
  }): PlanRecord {
    const plan: PlanRecord = {
      id: this.id('11111111'),
      name: p.name ?? (p.interval === 'month' ? 'Monthly' : 'Yearly'),
      interval: p.interval,
      amountMinor: p.amountMinor,
      currency: p.currency ?? 'USD',
      stripePriceId: p.stripePriceId === undefined ? `price_${p.interval}_test` : p.stripePriceId,
    };
    this.plans.push(plan);
    return plan;
  }
  seedCustomer(userId: string, customerId: string): void {
    this.customers.set(userId, customerId);
  }
  seedSubscription(s: {
    userId: string;
    planId: string;
    stripeSubscriptionId: string;
    status?: SubscriptionStatus;
    /** Stripe's raw status. Defaults from `status` (a lapsed one defaults to overdue: `past_due`). */
    providerStatus?: string;
    periodEnd?: Date | null;
  }): string {
    const sub: StoredSubscription = {
      id: this.id('22222222'),
      userId: s.userId,
      planId: s.planId,
      stripeSubscriptionId: s.stripeSubscriptionId,
      status: s.status ?? 'active',
      providerStatus:
        s.providerStatus ??
        (s.status === 'cancelled'
          ? 'canceled'
          : s.status === 'lapsed'
            ? 'past_due'
            : s.status === 'pending'
              ? 'incomplete'
              : 'active'),
      periodStart: null,
      periodEnd: s.periodEnd === undefined ? new Date('2099-01-01T00:00:00Z') : s.periodEnd,
      cancelAtPeriodEnd: false,
      cancelledAt: null,
      endedAt: null,
      eventAt: new Date(0),
      createdAt: this.nextId,
    };
    this.subscriptions.push(sub);
    return sub.id;
  }
  subscriptionByStripeId(stripeId: string) {
    return this.subscriptions.find((s) => s.stripeSubscriptionId === stripeId);
  }
  paymentsOf(userId: string) {
    return this.payments.filter((p) => p.userId === userId);
  }
  contributionsOf(userId: string) {
    return this.contributions.filter((c) => c.userId === userId);
  }
  customerOf(userId: string) {
    return this.customers.get(userId) ?? null;
  }

  // ---- BillingRepository ----------------------------------------------------------------------
  listActivePlans(): Promise<PlanRecord[]> {
    this.maybeFail('listActivePlans');
    return Promise.resolve([...this.plans]);
  }
  findPlanByStripePriceId(priceId: string): Promise<PlanRecord | null> {
    return Promise.resolve(this.plans.find((p) => p.stripePriceId === priceId) ?? null);
  }
  findCurrentSubscription(userId: string): Promise<SubscriptionRecord | null> {
    this.maybeFail('findCurrentSubscription');
    const mine = this.subscriptions
      .filter((s) => s.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
    const row = mine.find((s) => s.status === 'active' || s.status === 'pending') ?? mine[0];
    if (!row) return Promise.resolve(null);
    const plan = this.plans.find((p) => p.id === row.planId);
    return Promise.resolve({
      id: row.id,
      userId: row.userId,
      planName: plan?.name ?? 'Plan',
      interval: plan?.interval ?? 'month',
      status: row.status,
      currentPeriodEnd: row.periodEnd,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      endedAt: row.endedAt,
    });
  }
  /** Mirrors `has_open_subscription()`: everything except what is OVER at Stripe (fails safe for new statuses). */
  hasOpenSubscription(userId: string): Promise<boolean> {
    this.maybeFail('hasOpenSubscription');
    return Promise.resolve(
      this.subscriptions.some(
        (s) =>
          s.userId === userId &&
          (s.status === 'active' ||
            s.status === 'pending' ||
            (s.providerStatus !== '' &&
              !['canceled', 'incomplete_expired'].includes(s.providerStatus))),
      ),
    );
  }

  /** Mirrors `is_active_subscriber()`: status `active` and the recorded period not yet ended. No tolerance. */
  hasAccess(userId: string, at: Date): boolean {
    return this.subscriptions.some(
      (s) =>
        s.userId === userId && s.status === 'active' && s.periodEnd !== null && s.periodEnd > at,
    );
  }

  getStripeCustomerId(userId: string): Promise<string | null> {
    return Promise.resolve(this.customers.get(userId) ?? null);
  }
  findUserIdByStripeCustomer(customerId: string): Promise<string | null> {
    for (const [userId, id] of this.customers)
      if (id === customerId) return Promise.resolve(userId);
    return Promise.resolve(null);
  }
  saveStripeCustomer(userId: string, customerId: string): Promise<string> {
    this.calls.saveStripeCustomer++;
    this.maybeFail('saveStripeCustomer');
    for (const [owner, id] of this.customers) {
      if (id === customerId && owner !== userId) {
        return Promise.reject(
          new UnprocessableEventError('This Stripe customer already belongs to a different user'),
        );
      }
    }
    if (!this.customers.has(userId)) this.customers.set(userId, customerId);
    return Promise.resolve(this.customers.get(userId) as string);
  }
  findSubscriptionByStripeId(stripeSubscriptionId: string) {
    const s = this.subscriptionByStripeId(stripeSubscriptionId);
    return Promise.resolve(s ? { id: s.id, userId: s.userId } : null);
  }

  applySubscription(input: ApplySubscriptionInput): Promise<ApplyResult> {
    this.calls.applySubscription++;
    this.maybeFail('applySubscription');
    const existing = this.subscriptionByStripeId(input.stripeSubscriptionId);
    const live = (status: SubscriptionStatus) => status === 'active' || status === 'pending';
    if (existing) {
      if (existing.userId !== input.userId) {
        return Promise.reject(
          new UnprocessableEventError('Stripe subscription belongs to another user'),
        );
      }
      if (existing.eventAt > input.eventAt) return Promise.resolve('stale');
      if (
        live(input.status) &&
        this.subscriptions.some(
          (s) => s !== existing && s.userId === input.userId && live(s.status),
        )
      ) {
        return Promise.resolve('conflict');
      }
      Object.assign(existing, this.fields(input));
      return Promise.resolve('applied');
    }
    if (
      live(input.status) &&
      this.subscriptions.some((s) => s.userId === input.userId && live(s.status))
    ) {
      return Promise.resolve('conflict');
    }
    this.subscriptions.push({
      id: this.id('22222222'),
      userId: input.userId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      createdAt: this.nextId,
      ...this.fields(input),
    });
    return Promise.resolve('applied');
  }
  private fields(i: ApplySubscriptionInput) {
    return {
      planId: i.planId,
      status: i.status,
      providerStatus: i.providerStatus,
      periodStart: i.periodStart,
      periodEnd: i.periodEnd,
      cancelAtPeriodEnd: i.cancelAtPeriodEnd,
      cancelledAt: i.cancelledAt,
      endedAt: i.endedAt,
      eventAt: i.eventAt,
    };
  }

  recordPayment(
    input: RecordPaymentInput,
  ): Promise<{ paymentCreated: boolean; contributionCreated: boolean }> {
    this.calls.recordPayment++;
    this.maybeFail('recordPayment');
    const sub = this.subscriptions.find((s) => s.id === input.subscriptionId);
    if (sub?.userId !== input.userId)
      return Promise.reject(
        new UnprocessableEventError('Subscription does not belong to the user'),
      );
    if (input.state === 'succeeded' && !input.contribution) {
      return Promise.reject(
        new UnprocessableEventError('A succeeded payment must carry its contribution'),
      );
    }
    if (input.amountMinor < 1)
      return Promise.reject(new UnprocessableEventError('Amount must be positive'));
    const c = input.contribution;
    if (
      c &&
      (c.percentageBps < MIN_CHARITY_BPS || c.amountMinor > c.basisMinor || c.amountMinor < 1)
    ) {
      return Promise.reject(new UnprocessableEventError('Contribution violates its constraints'));
    }

    let payment = this.payments.find((p) => p.stripeInvoiceId === input.stripeInvoiceId);
    let paymentCreated = false;
    if (!payment) {
      payment = {
        id: this.id('33333333'),
        userId: input.userId,
        subscriptionId: input.subscriptionId,
        stripeInvoiceId: input.stripeInvoiceId,
        stripePaymentIntentId: input.stripePaymentIntentId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        state: input.state,
        paidAt: input.paidAt,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      };
      this.payments.push(payment);
      paymentCreated = true;
    } else {
      if (payment.userId !== input.userId)
        return Promise.reject(new UnprocessableEventError('Invoice recorded for another user'));
      if (payment.state !== 'succeeded') {
        Object.assign(payment, {
          state: input.state,
          amountMinor: input.amountMinor,
          stripePaymentIntentId: input.stripePaymentIntentId ?? payment.stripePaymentIntentId,
          paidAt: input.paidAt,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
        });
      }
    }

    let contributionCreated = false;
    if (
      payment.state === 'succeeded' &&
      c &&
      !this.contributions.some((x) => x.paymentId === payment.id)
    ) {
      this.contributions.push({
        paymentId: payment.id,
        userId: input.userId,
        charityId: c.charityId,
        percentageBps: c.percentageBps,
        basisMinor: c.basisMinor,
        amountMinor: c.amountMinor,
        currency: input.currency,
      });
      contributionCreated = true;
    }
    return Promise.resolve({ paymentCreated, contributionCreated });
  }

  claimEvent(event: { id: string; type: string; summary: unknown }): Promise<ClaimResult> {
    this.maybeFail('claimEvent');
    const existing = this.ledger.get(event.id);
    if (!existing) {
      this.ledger.set(event.id, {
        id: event.id,
        type: event.type,
        status: 'received',
        error: null,
        summary: event.summary,
      });
      return Promise.resolve('new');
    }
    return Promise.resolve(existing.status === 'processed' ? 'duplicate' : 'retry');
  }
  markEvent(
    id: string,
    outcome: { status: 'processed' } | { status: 'failed'; error: string },
  ): Promise<void> {
    const row = this.ledger.get(id);
    if (row) {
      row.status = outcome.status;
      row.error = outcome.status === 'failed' ? outcome.error : null;
    }
    return Promise.resolve();
  }
}

/** Records every call so tests can assert what would have been sent to Stripe (and what was NOT). */
export class FakeGateway implements PaymentGateway {
  readonly customers: { userId: string; email: string | null; key: string }[] = [];
  readonly checkouts: { input: CheckoutInput; key: string }[] = [];
  readonly portals: { customerId: string; returnUrl: string }[] = [];
  readonly retrieved: string[] = [];
  /** What `retrieveSubscription` returns, by Stripe subscription id. */
  readonly remoteSubscriptions = new Map<string, unknown>();
  /** What `retrievePrice` returns, by Stripe price id. */
  readonly remotePrices = new Map<string, ProviderPrice>();
  failWith: PaymentProviderError | null = null;

  get calls(): number {
    return (
      this.customers.length + this.checkouts.length + this.portals.length + this.retrieved.length
    );
  }

  createCustomer(input: { userId: string; email: string | null }, key: string) {
    if (this.failWith) return Promise.reject(this.failWith);
    this.customers.push({ ...input, key });
    return Promise.resolve({ id: `cus_${String(this.customers.length).padStart(4, '0')}` });
  }
  createCheckoutSession(input: CheckoutInput, key: string) {
    if (this.failWith) return Promise.reject(this.failWith);
    this.checkouts.push({ input, key });
    return Promise.resolve({
      id: `cs_${String(this.checkouts.length)}`,
      url: `https://checkout.stripe.test/c/${String(this.checkouts.length)}`,
    });
  }
  createPortalSession(input: { customerId: string; returnUrl: string }) {
    if (this.failWith) return Promise.reject(this.failWith);
    this.portals.push(input);
    return Promise.resolve({ url: 'https://billing.stripe.test/p/1' });
  }
  retrieveSubscription(id: string) {
    this.retrieved.push(id);
    if (!this.remoteSubscriptions.has(id))
      return Promise.reject(new PaymentProviderError('retrieve subscription'));
    return Promise.resolve(this.remoteSubscriptions.get(id));
  }
  retrievePrice(id: string) {
    this.retrieved.push(id);
    const price = this.remotePrices.get(id);
    return price
      ? Promise.resolve(price)
      : Promise.reject(new PaymentProviderError('retrieve price'));
  }
  constructWebhookEvent(): unknown {
    throw new Error('FakeGateway does not verify signatures; use createStripeGateway for that');
  }
}

/** The user's current charity choice as the webhook processor reads it. */
export class FakeSelection implements SelectionReader {
  private readonly choices = new Map<string, { charityId: string; percentageBps: number } | null>();
  set(userId: string, choice: { charityId: string; percentageBps: number } | null): void {
    this.choices.set(userId, choice);
  }
  current(userId: string) {
    return Promise.resolve(this.choices.get(userId) ?? null);
  }
}
