import {
  BILLING_ERROR_CODES,
  isYearlyDiscounted,
  type BillingInterval,
  type PlanDto,
  type RedirectResponse,
  type SubscriptionResponse,
} from '@gather/shared';
import { AppError } from '../errors.js';
import type { SubscribableCharity } from '../charities/service.js';
import { PaymentProviderError, type PaymentGateway } from './gateway.js';
import type { BillingRepository, PlanRecord } from './repository.js';

/** What the billing service needs from the charity domain: nothing but its subscription precondition. */
export interface CharityPrecondition {
  requireSubscribableCharity(userId: string): Promise<SubscribableCharity>;
}

export interface BillingService {
  /** The plans that can be bought right now (public). */
  listPlans(): Promise<PlanDto[]>;
  getSubscription(userId: string): Promise<SubscriptionResponse>;
  /** Starts Stripe Checkout for the user; returns the hosted page to redirect to. */
  startCheckout(
    caller: { userId: string; email: string | null },
    interval: BillingInterval,
  ): Promise<RedirectResponse>;
  /** Opens the Stripe Billing Portal (update card, switch plan, cancel). */
  openPortal(userId: string): Promise<RedirectResponse>;
}

export interface BillingServiceDeps {
  repository: BillingRepository;
  /** `null` when Stripe is not configured: reading works, anything that would touch Stripe answers 503. */
  gateway: PaymentGateway | null;
  charities: CharityPrecondition;
  /** The web app's origin, for Checkout's return URLs. */
  webOrigin: string;
  now?: () => Date;
}

const unavailable = () =>
  new AppError(503, 'service_unavailable', 'This service is not available right now.');
const planUnavailable = () =>
  new AppError(422, BILLING_ERROR_CODES.planUnavailable, 'That plan is not available right now.');

/** A double-click must not create two Checkout sessions: same inputs within this window share one. */
const CHECKOUT_IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000;

const toDto = (p: PlanRecord): PlanDto => ({
  id: p.id,
  name: p.name,
  interval: p.interval,
  amountMinor: p.amountMinor,
  currency: p.currency,
});

/**
 * The plans that may be sold: each needs a Stripe price, and the yearly plan must really be a DISCOUNT on the
 * monthly one (PRD §04 SUB-01) — a cross-row rule the table cannot express, so it is enforced here, in the one
 * place both the listing and checkout use. A misconfigured catalogue makes the yearly plan unavailable rather
 * than selling it at the wrong price.
 */
export function purchasablePlans(plans: PlanRecord[]): PlanRecord[] {
  const priced = plans.filter((p) => p.stripePriceId !== null);
  const monthly = priced.find((p) => p.interval === 'month');
  return priced.filter((p) => {
    if (p.interval === 'month') return true;
    return monthly !== undefined && isYearlyDiscounted(monthly, p);
  });
}

export function createBillingService({
  repository,
  gateway,
  charities,
  webOrigin,
  now = () => new Date(),
}: BillingServiceDeps): BillingService {
  const accountUrl = (query = '') => new URL(`/account/subscription${query}`, webOrigin).toString();

  /** Stripe failures are not the caller's fault and their detail is not for the caller. */
  async function viaProvider<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (error instanceof PaymentProviderError) {
        console.error(`${error.message}`, error.cause ?? '');
        throw new AppError(
          502,
          'payment_provider_error',
          'The payment provider could not be reached. Please try again.',
          {},
          { cause: error },
        );
      }
      throw error;
    }
  }

  return {
    async listPlans() {
      return purchasablePlans(await repository.listActivePlans()).map(toDto);
    },

    async getSubscription(userId) {
      const [subscription, customerId] = await Promise.all([
        repository.findCurrentSubscription(userId),
        repository.getStripeCustomerId(userId),
      ]);
      return {
        subscription: subscription && {
          id: subscription.id,
          status: subscription.status,
          planName: subscription.planName,
          interval: subscription.interval,
          currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          endedAt: subscription.endedAt?.toISOString() ?? null,
        },
        canManageBilling: customerId !== null,
      };
    },

    async startCheckout({ userId, email }, interval) {
      if (!gateway) throw unavailable();

      // One subscription at a time (D-044), and never a second while the first is still open at Stripe (it may be
      // overdue and retrying). Someone whose subscription has really ended may subscribe again.
      if (await repository.hasOpenSubscription(userId)) {
        throw new AppError(
          409,
          BILLING_ERROR_CODES.alreadySubscribed,
          'You already have a subscription. Manage it from your billing settings.',
        );
      }

      // CHR-01 (D-066): a selected, listed charity is required BEFORE any payment is created. This is the
      // money boundary — the signup form is UX only. Its snapshot travels with the subscription (D-069).
      const charity = await charities.requireSubscribableCharity(userId);

      const plan = purchasablePlans(await repository.listActivePlans()).find(
        (p) => p.interval === interval,
      );
      if (!plan?.stripePriceId) throw planUnavailable();

      const customerId = await viaProvider(async () => {
        const existing = await repository.getStripeCustomerId(userId);
        if (existing) return existing;
        const created = await gateway.createCustomer({ userId, email }, `customer:${userId}`);
        // If a concurrent request saved a customer first, that one wins.
        return repository.saveStripeCustomer(userId, created.id);
      });

      const window = Math.floor(now().getTime() / CHECKOUT_IDEMPOTENCY_WINDOW_MS);
      const session = await viaProvider(() =>
        gateway.createCheckoutSession(
          {
            customerId,
            priceId: plan.stripePriceId as string,
            userId,
            planId: plan.id,
            charityId: charity.charityId,
            charityBps: charity.percentageBps,
            successUrl: accountUrl('?checkout=success'),
            cancelUrl: accountUrl('?checkout=cancelled'),
          },
          `checkout:${userId}:${plan.id}:${charity.charityId}:${String(charity.percentageBps)}:${String(window)}`,
        ),
      );
      return { url: session.url };
    },

    async openPortal(userId) {
      if (!gateway) throw unavailable();
      const customerId = await repository.getStripeCustomerId(userId);
      if (!customerId) {
        throw new AppError(
          409,
          BILLING_ERROR_CODES.noBillingAccount,
          'There is no billing account to manage yet.',
        );
      }
      const session = await viaProvider(() =>
        gateway.createPortalSession({ customerId, returnUrl: accountUrl() }),
      );
      return { url: session.url };
    },
  };
}
