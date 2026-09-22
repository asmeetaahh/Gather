import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Creates the browser Supabase client, or `null` when it is not configured (the app then shows an
 * "authentication unavailable" notice instead of crashing).
 *
 * Only the PUBLIC anon key is ever used here. The service-role key must never reach the browser
 * (DECISIONS D-004). supabase-js persists the session in localStorage and refreshes tokens itself,
 * which is what makes session restoration work after a reload.
 */
export function createBrowserSupabase(env: {
  url: string | undefined;
  anonKey: string | undefined;
}): SupabaseClient | null {
  if (!env.url || !env.anonKey) return null;
  return createClient(env.url, env.anonKey);
}
