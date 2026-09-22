import {
  MIN_CHARITY_BPS,
  BPS_DENOMINATOR,
  computeInvoiceContribution,
  isUuid,
} from '@gather/shared';
import type { PaymentGateway } from './gateway.js';
import type { BillingRepository } from './repository.js';
import { mapProviderStatus } from './status.js';
import {
  InvalidStripeEventError,
  UnprocessableEventError,
  parseCheckoutSession,
  parseEnvelope,
  parseInvoice,
  parseSubscription,
  type GatherMetadata,
  type ProviderInvoice,
  type ProviderSubscription,
  type StripeEnvelope,
} from './stripe-events.js';

/**
 * Turns verified Stripe events into local state (D-068). Stripe is the source of truth for subscription and payment
 * state and the webhook is how we learn it (ASM-06); this module never decides what happened, it records it.
 *
 * SAFE TO REPLAY, IN ANY ORDER — because Stripe retries and does not order its events:
 *  - the `stripe_events` ledger records each event id, so a redelivered event is acknowledged and skipped;
 *  - every step is itself idempotent (`apply_provider_subscription` ignores older events, `record_subscription_payment`
 *    is keyed by the invoice id), so a crash half-way, a concurrent duplicate, or a retry cannot double-count money;
 *  - a payment that arrives before its subscription pulls the subscription from Stripe instead of guessing.
 *
 * Only the events below are acted on; everything else is acknowledged and ignored. Refunds and chargebacks are NOT
 * handled in Phase 5 (D-026 is still open on them).
 */

/** The user's current charity choice, read when a renewal is paid (D-069). */
export interface SelectionReader {
  /** The selected charity (even if it has since been archived) and percentage, or null if none is selected. */
  current(userId: string): Promise<{ charityId: string; percentageBps: number } | null>;
}

/**
 * The event types the webhook acts on — the ones to enable on the Stripe endpoint (or pass to `stripe listen --events`).
 * Every other type is acknowledged and ignored. Refunds and chargebacks are NOT handled (D-026 is still open on them).
 */
export const HANDLED_EVENT_TYPES = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
] as const;

export type WebhookOutcome =
  /** Recognised and applied. */
  | 'processed'
  /** Already handled (Stripe redelivered it). */
  | 'duplicate'
  /** A type we do not act on. */
  | 'ignored'
  /** Well-formed but cannot be applied; kept in the ledger as failed, and acknowledged (retrying cannot help). */
  | 'unprocessable';

export interface WebhookProcessor {
  /** `rawEvent` is the SIGNATURE-VERIFIED event. Throws `InvalidStripeEventError` if it is not interpretable. */
  process(rawEvent: unknown): Promise<WebhookOutcome>;
}

export interface WebhookProcessorDeps {
  repository: BillingRepository;
  gateway: Pick<PaymentGateway, 'retrieveSubscription'>;
  selection: SelectionReader;
}

interface Snapshot {
  charityId: string;
  percentageBps: number;
}

/** Our own checkout snapshot, usable only if it is complete and within the PRD's range. */
function validSnapshot(metadata: GatherMetadata): Snapshot | null {
  const { charityId, charityBps } = metadata;
  if (charityId === null || charityBps === null) return null;
  if (charityBps < MIN_CHARITY_BPS || charityBps > BPS_DENOMINATOR) return null;
  return { charityId, percentageBps: charityBps };
}

export function createWebhookProcessor({
  repository,
  gateway,
  selection,
}: WebhookProcessorDeps): WebhookProcessor {
  /** Which of OUR users does this Stripe customer belong to? Learns the mapping the first time it is seen. */
  async function resolveUser(customerId: string, metadataUserId: string | null): Promise<string> {
    const mapped = await repository.findUserIdByStripeCustomer(customerId);
    if (mapped) {
      if (metadataUserId && metadataUserId !== mapped) {
        throw new UnprocessableEventError(
          'The Stripe customer and the user named in its metadata disagree',
        );
      }
      return mapped;
    }
    if (!metadataUserId) throw new UnprocessableEventError('Unknown Stripe customer');
    const stored = await repository.saveStripeCustomer(metadataUserId, customerId);
    if (stored !== customerId) {
      throw new UnprocessableEventError('The user already has a different Stripe customer');
    }
    return metadataUserId;
  }

  async function syncSubscription(sub: ProviderSubscription, eventAt: Date): Promise<string> {
    const userId = await resolveUser(sub.customerId, sub.metadata.userId);
    const plan = await repository.findPlanByStripePriceId(sub.priceId);
    if (!plan)
      throw new UnprocessableEventError(`No plan is configured for Stripe price ${sub.priceId}`);

    const status = mapProviderStatus(sub.status);
    if (status === 'active' && sub.periodEnd === null) {
      throw new UnprocessableEventError('An active subscription must have a period end');
    }
    const result = await repository.applySubscription({
      userId,
      planId: plan.id,
      stripeSubscriptionId: sub.id,
      status,
      providerStatus: sub.status,
      periodStart: sub.periodStart,
      periodEnd: sub.periodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      cancelledAt: sub.canceledAt,
      endedAt: sub.endedAt,
      eventAt,
    });
    if (result === 'conflict') {
      // A second Stripe subscription for a user who already has one (two Checkout sessions completed). Not applied;
      // a person must resolve it — refunding/cancelling money automatically is not a decision to take silently.
      throw new UnprocessableEventError('The user already has another live subscription (D-044)');
    }
    return userId;
  }

  /** The local subscription an invoice belongs to; if it is not recorded yet, ask Stripe rather than guess. */
  async function localSubscriptionFor(stripeSubscriptionId: string, env: StripeEnvelope) {
    let local = await repository.findSubscriptionByStripeId(stripeSubscriptionId);
    if (!local) {
      const fetched = parseSubscription(await gateway.retrieveSubscription(stripeSubscriptionId));
      await syncSubscription(fetched, env.created);
      local = await repository.findSubscriptionByStripeId(stripeSubscriptionId);
    }
    if (!local)
      throw new UnprocessableEventError('The invoice’s subscription could not be recorded');
    return local;
  }

  /**
   * WHICH charity and percentage a payment is attributed to (D-069). The first payment uses the snapshot taken at
   * Checkout — what the user agreed to — even if that charity was archived afterwards (archiving hides a charity, it
   * does not erase it, D-043: the money was paid on the user's instruction). A renewal uses the user's CURRENT
   * choice, again even if it has since been archived; the checkout snapshot is the fallback. Each payment stores
   * its own snapshot, so later changes never rewrite history.
   */
  async function chooseAttribution(invoice: ProviderInvoice, userId: string): Promise<Snapshot> {
    const atCheckout = validSnapshot(invoice.metadata);
    if (invoice.billingReason === 'subscription_create' && atCheckout) return atCheckout;
    const current = await selection.current(userId);
    if (current) return current;
    if (atCheckout) return atCheckout;
    throw new UnprocessableEventError('No charity to attribute this payment to');
  }

  async function onSubscriptionEvent(env: StripeEnvelope): Promise<boolean> {
    await syncSubscription(parseSubscription(env.object), env.created);
    return true;
  }

  async function onCheckoutCompleted(env: StripeEnvelope): Promise<boolean> {
    const session = parseCheckoutSession(env.object);
    if (session.mode !== 'subscription') return false;
    if (!session.customerId)
      throw new UnprocessableEventError('The checkout session has no customer');
    await resolveUser(
      session.customerId,
      session.clientReferenceId && isUuid(session.clientReferenceId)
        ? session.clientReferenceId
        : null,
    );
    // Make the new subscription visible straight away instead of waiting for its own event.
    if (session.subscriptionId) {
      await syncSubscription(
        parseSubscription(await gateway.retrieveSubscription(session.subscriptionId)),
        env.created,
      );
    }
    return true;
  }

  async function onInvoicePaid(env: StripeEnvelope): Promise<boolean> {
    const invoice = parseInvoice(env.object);
    if (!invoice.subscriptionId) return false; // not a subscription invoice: not ours to record
    if (invoice.amountPaid <= 0) return false; // nothing was collected (credit, 100% coupon): no payment, no share

    const local = await localSubscriptionFor(invoice.subscriptionId, env);
    const owner = await repository.findUserIdByStripeCustomer(invoice.customerId);
    if (owner && owner !== local.userId) {
      throw new UnprocessableEventError('The invoice’s customer is not the subscription’s user');
    }

    const attribution = await chooseAttribution(invoice, local.userId);
    // OWNER decision D-070: the share of the amount actually collected, BEFORE tax, after discounts, gross of
    // Stripe's fees, rounded up. One rule in one place (shared), so the amount recorded here is what was decided.
    let share;
    try {
      share = computeInvoiceContribution({
        amountPaidMinor: invoice.amountPaid,
        totalMinor: invoice.total,
        totalExcludingTaxMinor: invoice.totalExcludingTax,
        percentageBps: attribution.percentageBps,
      });
    } catch (error) {
      // An invoice whose figures cannot yield a contribution can never be applied: do not retry it forever.
      if (error instanceof RangeError) throw new UnprocessableEventError(error.message);
      throw error;
    }

    await repository.recordPayment({
      userId: local.userId,
      subscriptionId: local.id,
      stripeInvoiceId: invoice.id,
      stripePaymentIntentId: invoice.paymentIntentId,
      amountMinor: invoice.amountPaid,
      currency: invoice.currency,
      state: 'succeeded',
      paidAt: invoice.paidAt ?? env.created,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      contribution: {
        charityId: attribution.charityId,
        percentageBps: attribution.percentageBps,
        basisMinor: share.basisMinor,
        amountMinor: share.amountMinor,
      },
    });
    return true;
  }

  async function onInvoiceFailed(env: StripeEnvelope): Promise<boolean> {
    const invoice = parseInvoice(env.object);
    if (!invoice.subscriptionId || invoice.amountDue <= 0) return false;
    const local = await localSubscriptionFor(invoice.subscriptionId, env);
    await repository.recordPayment({
      userId: local.userId,
      subscriptionId: local.id,
      stripeInvoiceId: invoice.id,
      stripePaymentIntentId: invoice.paymentIntentId,
      amountMinor: invoice.amountDue,
      currency: invoice.currency,
      state: 'failed',
      paidAt: null,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      contribution: null,
    });
    return true;
  }

  async function handle(env: StripeEnvelope): Promise<boolean> {
    switch (env.type) {
      case 'checkout.session.completed':
        return onCheckoutCompleted(env);
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        return onSubscriptionEvent(env);
      case 'invoice.paid':
      case 'invoice.payment_succeeded':
        return onInvoicePaid(env);
      case 'invoice.payment_failed':
        return onInvoiceFailed(env);
      default:
        return false;
    }
  }

  return {
    async process(rawEvent) {
      const env = parseEnvelope(rawEvent);
      // This integration is built and verified in test mode only (ASM-11): a live event is never applied.
      if (env.livemode) throw new InvalidStripeEventError('Live-mode events are not accepted');

      const claim = await repository.claimEvent({
        id: env.id,
        type: env.type,
        livemode: env.livemode,
        // Only what identifies the event. The full payload carries customer names, emails and addresses that the
        // ledger has no need to keep.
        summary: { id: env.id, type: env.type, created: env.created.toISOString() },
      });
      if (claim === 'duplicate') return 'duplicate';

      try {
        const acted = await handle(env);
        await repository.markEvent(env.id, { status: 'processed' });
        return acted ? 'processed' : 'ignored';
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        // Something we can never apply (or an object we cannot read): record it and acknowledge — a retry would
        // fail the same way. Anything else (the database or Stripe being unavailable) is transient: fail the
        // request so Stripe redelivers, and the ledger keeps the event as failed until it succeeds.
        const permanent =
          error instanceof UnprocessableEventError || error instanceof InvalidStripeEventError;
        await repository
          .markEvent(env.id, { status: 'failed', error: message })
          .catch(() => undefined);
        if (permanent) return 'unprocessable';
        throw error;
      }
    },
  };
}

/** What the webhook route calls: verify the signature over the raw body, then process the event. */
export interface StripeWebhookHandler {
  handle(rawBody: Buffer, signatureHeader: string | undefined): Promise<WebhookOutcome>;
}

export function createStripeWebhookHandler(
  gateway: Pick<PaymentGateway, 'constructWebhookEvent'>,
  processor: WebhookProcessor,
): StripeWebhookHandler {
  return {
    handle(rawBody, signatureHeader) {
      return processor.process(gateway.constructWebhookEvent(rawBody, signatureHeader));
    },
  };
}
