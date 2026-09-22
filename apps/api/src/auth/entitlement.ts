import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Answers "does this user currently have an active subscription?" — PRD §04 requires this check on
 * every authenticated request that needs it (SUB-05), so callers ask each time and nothing is cached.
 * The rule itself lives in ONE place, the SQL function `is_active_subscriber(uuid)` (DECISIONS D-026/D-030).
 */
export interface SubscriptionGate {
  isActiveSubscriber(userId: string): Promise<boolean>;
}

/** Reads the entitlement through the service role. Anything but an explicit `true` means "not subscribed". */
export function createSupabaseSubscriptionGate(client: SupabaseClient): SubscriptionGate {
  return {
    async isActiveSubscriber(userId) {
      const response = await client.rpc('is_active_subscriber', { p_user_id: userId });
      // A failed lookup must not read as "not subscribed": it is an error, so the request fails closed.
      if (response.error) throw new Error(`Subscription lookup failed: ${response.error.message}`);
      const answer: unknown = response.data; // untyped by supabase-js: only an explicit `true` counts
      return answer === true;
    },
  };
}
