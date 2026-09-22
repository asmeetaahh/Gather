import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  BILLING_ERROR_CODES,
  CHARITY_ERROR_CODES,
  formatMinorUnits,
  type BillingInterval,
  type PlanDto,
  type SubscriptionResponse,
} from '@gather/shared';
import { fetchMySubscription, fetchPlans, openBillingPortal, startCheckout } from '../api/billing';
import { ApiRequestError } from '../api/client';
import { useAuth } from '../auth/context';
import { goTo } from '../lib/navigation';

type Outcome =
  | { key: number; error: true }
  | { key: number; error?: false; plans: PlanDto[]; mine: SubscriptionResponse };

interface Problem {
  message: string;
  /** Some problems are fixed on the charity page: offer the way there. */
  chooseCharity?: boolean;
}

/** Turns an API failure into something a person can act on. The server's codes are stable; its wording is not relied on. */
function describe(error: unknown): Problem {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case CHARITY_ERROR_CODES.selectionRequired:
        return { message: 'Choose a charity before you subscribe.', chooseCharity: true };
      case CHARITY_ERROR_CODES.selectedUnavailable:
        return {
          message:
            'Your selected charity is no longer available. Choose another charity before you subscribe.',
          chooseCharity: true,
        };
      case BILLING_ERROR_CODES.alreadySubscribed:
        return {
          message: 'You already have a subscription. Use “Manage billing” to change or cancel it.',
        };
      case BILLING_ERROR_CODES.planUnavailable:
        return { message: 'That plan is not available right now.' };
      case BILLING_ERROR_CODES.noBillingAccount:
        return { message: 'There is no billing account to manage yet.' };
    }
    if (error.status === 503)
      return { message: 'Payments are not available right now. Please try again later.' };
  }
  return { message: 'Something went wrong. Please try again.' };
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString();
const PER: Record<BillingInterval, string> = { month: 'per month', year: 'per year' };

/**
 * The user's subscription (PRD §04, §10): the plans, Stripe Checkout, the current status and renewal date, and the
 * Billing Portal. Card details are entered on Stripe's own pages; this page only ever sends the browser there. What
 * the user may do is decided by the server — this page shows what it says.
 */
export function SubscriptionPage() {
  const { getAccessToken } = useAuth();
  const [search] = useSearchParams();
  const returned = search.get('checkout');
  const [reload, setReload] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const load = outcome?.key === reload ? outcome : null;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const token = await getAccessToken();
        if (!token) throw new ApiRequestError(401, null);
        const [{ plans }, mine] = await Promise.all([fetchPlans(), fetchMySubscription(token)]);
        if (!cancelled) setOutcome({ key: reload, plans, mine });
      } catch {
        if (!cancelled) setOutcome({ key: reload, error: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getAccessToken, reload]);

  async function run(action: (token: string) => Promise<{ url: string }>) {
    setProblem(null);
    setBusy(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new ApiRequestError(401, null);
      goTo((await action(token)).url);
    } catch (error) {
      setProblem(describe(error));
      setBusy(false);
    }
  }

  if (!load) return <p role="status">Loading your subscription…</p>;
  if (load.error)
    return <p role="alert">Your subscription could not be loaded. Please try again.</p>;

  const { plans, mine } = load;
  const sub = mine.subscription;
  const isLive = sub?.status === 'active' || sub?.status === 'pending';
  const monthly = plans.find((p) => p.interval === 'month');

  return (
    <section>
      <h1>Subscription</h1>

      {returned === 'success' && (
        <p role="status">
          Thank you! Your payment is being confirmed — this can take a few moments.{' '}
          <button
            type="button"
            onClick={() => {
              setOutcome(null);
              setReload((n) => n + 1);
            }}
          >
            Refresh status
          </button>
        </p>
      )}
      {returned === 'cancelled' && (
        <p role="status">Checkout was cancelled. You have not been charged.</p>
      )}

      {sub && (
        <div aria-label="Current subscription">
          <p>
            {sub.planName} ({sub.interval === 'month' ? 'monthly' : 'yearly'}) —{' '}
            <strong>{sub.status}</strong>
          </p>
          {sub.status === 'active' && sub.currentPeriodEnd && (
            <p>
              {sub.cancelAtPeriodEnd ? 'Ends on ' : 'Renews on '}
              {formatDate(sub.currentPeriodEnd)}
              {sub.cancelAtPeriodEnd && ' — you keep access until then.'}
            </p>
          )}
          {sub.status === 'pending' && <p>Waiting for the first payment to be confirmed.</p>}
          {sub.status === 'lapsed' && (
            <p role="alert">Your last payment did not go through. Update your payment details.</p>
          )}
          {sub.status === 'cancelled' && sub.endedAt && <p>Ended on {formatDate(sub.endedAt)}.</p>}
        </div>
      )}

      {mine.canManageBilling && (
        <p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void run(openBillingPortal);
            }}
          >
            Manage billing
          </button>
        </p>
      )}

      {!isLive && (
        <>
          <h2>Choose a plan</h2>
          {plans.length === 0 ? (
            <p role="status">No plans are available right now.</p>
          ) : (
            <ul aria-label="Plans">
              {plans.map((plan) => {
                const saving =
                  plan.interval === 'year' && monthly?.currency === plan.currency
                    ? monthly.amountMinor * 12 - plan.amountMinor
                    : 0;
                return (
                  <li key={plan.id}>
                    <h3>{plan.name}</h3>
                    <p>
                      {formatMinorUnits(plan.amountMinor, plan.currency)} {PER[plan.interval]}
                    </p>
                    {saving > 0 && (
                      <p>
                        Saves {formatMinorUnits(saving, plan.currency)} compared with 12 monthly
                        payments.
                      </p>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        void run((token) => startCheckout(token, plan.interval));
                      }}
                    >
                      Subscribe {plan.interval === 'month' ? 'monthly' : 'yearly'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p>
            Your contribution goes to the charity you selected.{' '}
            <Link to="/account/charity">Change it</Link>.
          </p>
        </>
      )}

      {problem && (
        <p role="alert">
          {problem.message}
          {problem.chooseCharity && (
            <>
              {' '}
              <Link to="/account/charity">Choose a charity</Link>
            </>
          )}
        </p>
      )}
    </section>
  );
}
