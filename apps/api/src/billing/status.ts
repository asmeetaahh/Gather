import type { SubscriptionStatus } from '@gather/shared';
import { UnprocessableEventError } from './stripe-events.js';

/**
 * Maps Stripe's subscription status to the four local states (PRD §04 SUB-04: renewal, cancellation, lapsed).
 * IMPLEMENTATION DECISION, provisional (DECISIONS D-068, pending D-026): the PRD names the states, not this mapping.
 * The raw Stripe status is always kept in `provider_status`, so the mapping can change without losing information.
 *
 * Two DIFFERENT questions are answered from this state, on purpose and side by side in SQL
 * (`is_active_subscriber()` for access, `has_open_subscription()` for checkout eligibility):
 *
 *   Stripe status         local status   ACCESS now?                 does it block a NEW checkout?
 *   active, trialing      active         yes, while the recorded     yes
 *                                        period has not ended
 *   incomplete            pending        no                          yes  (first payment unconfirmed)
 *   past_due              lapsed         NO — at once, before any    YES  (Stripe is retrying it; a second
 *                                        retry succeeds              subscription could charge twice)
 *   unpaid, paused        lapsed         no                          yes  (can be reactivated)
 *   incomplete_expired    lapsed         no                          no   (never became active: over)
 *   canceled              cancelled      no                          no   (over)
 *
 * Access has no tolerance for a late webhook: it is exactly the recorded paid period. "Blocks a new checkout" is
 * defined by what is OVER at Stripe (`canceled`, `incomplete_expired`), so a status Stripe adds later blocks too —
 * failing safe against a double charge.
 *
 * Cancelling "at period end" leaves Stripe's status `active` until then, so the user keeps what they paid for; that is
 * expressed by `cancel_at_period_end`, not by a status.
 */
export function mapProviderStatus(providerStatus: string): SubscriptionStatus {
  switch (providerStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'incomplete':
      return 'pending';
    case 'past_due':
    case 'unpaid':
    case 'paused':
    case 'incomplete_expired':
      return 'lapsed';
    case 'canceled':
      return 'cancelled';
    default:
      // A status we have never seen must not silently become access or no access.
      throw new UnprocessableEventError(`Unknown Stripe subscription status "${providerStatus}"`);
  }
}
