import type { SupabaseClient } from '@supabase/supabase-js';

export interface CurrencyTotal {
  currency: string;
  amountMinor: number;
}

/**
 * The two facts no existing repository already exposes. Everything else in a report (draw counts,
 * prize pools, winner counts, the active-subscriber count) is read from the SAME repositories/RPCs
 * their own domains already use — composed by `AdminReportsService`, not duplicated here.
 */
export interface AdminReportsRepository {
  /** Every row in `profiles` — every account that ever completed signup (ADM-07 "total users"). */
  countUsers(): Promise<number>;
  /** Sum of `charity_contributions.amount_minor`, by currency (subscription shares AND donations). */
  charityContributionsByCurrency(): Promise<CurrencyTotal[]>;
  /** `active_subscriber_ids()` (migration …150000) — the exact same set the draw engine reads, counted. */
  countActiveSubscribers(): Promise<number>;
}

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

export function createSupabaseAdminReportsRepository(
  client: SupabaseClient,
): AdminReportsRepository {
  return {
    async countUsers() {
      const { count, error } = await client
        .from('profiles')
        .select('id', { count: 'exact', head: true });
      if (error) throw new Error(`User count failed: ${error.message}`);
      return count ?? 0;
    },

    async charityContributionsByCurrency() {
      const { data, error } = await client
        .from('charity_contributions')
        .select('currency, amount_minor');
      if (error) throw new Error(`Contribution totals failed: ${error.message}`);
      const totals = new Map<string, number>();
      for (const raw of data as unknown[]) {
        if (!isRow(raw)) throw new Error('Malformed contribution row');
        const currency = raw.currency;
        const amount = raw.amount_minor;
        if (typeof currency !== 'string' || typeof amount !== 'number') {
          throw new Error('Malformed contribution row');
        }
        const sum = (totals.get(currency) ?? 0) + amount;
        if (!Number.isSafeInteger(sum)) throw new Error('Contribution total exceeds safe range');
        totals.set(currency, sum);
      }
      return [...totals]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, amountMinor]) => ({ currency, amountMinor }));
    },

    async countActiveSubscribers() {
      const response = await client.rpc('active_subscriber_ids');
      if (response.error)
        throw new Error(`Active subscriber count failed: ${response.error.message}`);
      const data: unknown = response.data; // untyped by supabase-js
      return (data as unknown[]).length;
    },
  };
}
