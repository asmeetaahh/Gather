import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  DrawMode,
  DrawStatus,
  DrawTierResultDto,
  MyDrawParticipationDto,
} from '@gather/shared';
import type { NumberRange, PaymentBasis } from './domain.js';

/**
 * The database refused a simulate/publish call because the draw's status had already moved on
 * (SQLSTATE GS005/GS006 from migration …150000) — a genuine race, not a transient failure. The service
 * decides what each `kind` means for its own flow (report a conflict, or simply re-read).
 */
export class DrawStateConflictError extends Error {
  constructor(readonly kind: 'already_published' | 'not_simulated') {
    super(
      kind === 'already_published'
        ? 'This draw has already been published.'
        : 'This draw has not been simulated yet.',
    );
    this.name = 'DrawStateConflictError';
  }
}

// ---- Records ------------------------------------------------------------------------------------

export interface DrawRecord {
  id: string;
  drawMonth: string;
  mode: DrawMode;
  status: DrawStatus;
  scheduledAt: string | null;
  simulatedAt: string | null;
  publishedAt: string | null;
  currency: string | null;
  prizePoolMinor: number | null;
  activeSubscriberCount: number | null;
}

export interface DrawDetailRecord extends DrawRecord {
  winningNumbers: number[] | null;
  tierResults: DrawTierResultDto[];
}

/** Neither field configured means neither is; at most one of `bps`/`fixedMinor` is present (D-014). */
export type PoolConfig = { kind: 'bps'; bps: number } | { kind: 'fixed'; fixedMinor: number };

export interface Settings {
  numberRange: NumberRange | null;
  pool: PoolConfig | null;
}

export type CreateDrawResult = { kind: 'created'; draw: DrawRecord } | { kind: 'duplicate_month' };

export interface SimulateInput {
  drawId: string;
  winningNumbers: number[];
  activeSubscriberCount: number;
  currency: string;
  prizePoolMinor: number;
  poolContributionBps: number | null;
  poolContributionFixedMinor: number | null;
  entries: { userId: string; entryNumbers: number[]; matchCount: number }[];
  tierResults: {
    matchCount: 3 | 4 | 5;
    shareBps: number;
    rollsOver: boolean;
    basePoolMinor: number;
    rolloverInMinor: number;
    winnersCount: number;
    prizePerWinnerMinor: number;
    remainderMinor: number;
    rolloverOutMinor: number;
  }[];
}

export type PublishResult = 'published' | 'already_published';

/**
 * Persistence for the draw engine. Every WRITE that must be atomic (a candidate snapshot; publishing)
 * goes through a service-role-only SQL function (migration …150000) so a reader can never observe a
 * half-written draw. All matching/weighting/pool/tier MATHS happens in `domain.ts`; this module only
 * reads inputs and applies already-computed outputs.
 */
export interface DrawRepository {
  getSettings(): Promise<Settings>;
  findByMonth(drawMonth: string): Promise<DrawRecord | null>;
  findById(id: string): Promise<DrawDetailRecord | null>;
  list(): Promise<DrawRecord[]>;
  create(input: {
    drawMonth: string;
    mode: DrawMode;
    createdBy: string;
  }): Promise<CreateDrawResult>;

  /** Active subscribers' tickets: their (up to five) latest Stableford scores, newest first. */
  listEligibleTickets(): Promise<Map<string, number[]>>;
  /** Succeeded subscription payments whose period could fund `drawMonth`'s pool (D-070/D-071). */
  listPaymentBasesFunding(drawMonth: string): Promise<PaymentBasis[]>;
  /** The currently active monthly plan's currency — used as the platform currency in fixed-pool mode. */
  getActiveMonthlyPlanCurrency(): Promise<string | null>;
  /** The 5-match jackpot rollover carried out of the most recent published draw before `drawMonth`. */
  getPriorJackpotRollover(drawMonth: string): Promise<number>;

  simulate(input: SimulateInput): Promise<void>;
  publish(drawId: string, publishedBy: string): Promise<PublishResult>;

  /**
   * One row per PUBLISHED draw `userId` was entered in, newest first (PRD §10 DSH-04). Explicitly
   * filtered to `status = 'published'` here — the service role bypasses RLS, so this mirrors what the
   * `draw_entries_select_own_published` policy already restricts a direct browser read to (D-050:
   * candidate results must never leak), the same "the repository re-applies the filter RLS would have
   * applied" pattern already used for charities (listed-only) and winners (owner-only).
   */
  listMyParticipation(userId: string): Promise<MyDrawParticipationDto[]>;
}

// ---- Row parsing (an untyped boundary) -----------------------------------------------------------

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
function malformed(what: string): never {
  throw new Error(`Malformed ${what} row`);
}
const str = (v: unknown, what: string): string => (typeof v === 'string' ? v : malformed(what));
const int = (v: unknown, what: string): number =>
  typeof v === 'number' && Number.isSafeInteger(v) ? v : malformed(what);
const bool = (v: unknown, what: string): boolean => (typeof v === 'boolean' ? v : malformed(what));
function mode(v: unknown, what: string): DrawMode {
  return v === 'random' || v === 'algorithmic' ? v : malformed(what);
}
function status(v: unknown, what: string): DrawStatus {
  return v === 'draft' || v === 'simulated' || v === 'published' ? v : malformed(what);
}
function matchCountOf(v: unknown, what: string): 3 | 4 | 5 {
  return v === 3 || v === 4 || v === 5 ? v : malformed(what);
}
function numbers(v: unknown, what: string): number[] {
  if (!Array.isArray(v)) return malformed(what);
  return v.map((x) => int(x, what));
}

export function parseDrawRow(raw: unknown): DrawRecord {
  if (!isRow(raw)) return malformed('draw');
  return {
    id: str(raw.id, 'draw'),
    drawMonth: str(raw.draw_month, 'draw'),
    mode: mode(raw.mode, 'draw'),
    status: status(raw.status, 'draw'),
    scheduledAt: raw.scheduled_at === null ? null : str(raw.scheduled_at, 'draw'),
    simulatedAt: raw.simulated_at === null ? null : str(raw.simulated_at, 'draw'),
    publishedAt: raw.published_at === null ? null : str(raw.published_at, 'draw'),
    currency: raw.currency === null ? null : str(raw.currency, 'draw'),
    prizePoolMinor: raw.prize_pool_minor === null ? null : int(raw.prize_pool_minor, 'draw'),
    activeSubscriberCount:
      raw.active_subscriber_count === null ? null : int(raw.active_subscriber_count, 'draw'),
  };
}

function parseTierResultRow(raw: unknown): DrawTierResultDto {
  if (!isRow(raw)) return malformed('tier result');
  return {
    matchCount: matchCountOf(raw.match_count, 'tier result'),
    shareBps: int(raw.share_bps, 'tier result'),
    rollsOver: bool(raw.rolls_over, 'tier result'),
    basePoolMinor: int(raw.base_pool_minor, 'tier result'),
    rolloverInMinor: int(raw.rollover_in_minor, 'tier result'),
    winnersCount: int(raw.winners_count, 'tier result'),
    prizePerWinnerMinor: int(raw.prize_per_winner_minor, 'tier result'),
    remainderMinor: int(raw.remainder_minor, 'tier result'),
    rolloverOutMinor: int(raw.rollover_out_minor, 'tier result'),
  };
}

function parseDrawDetailRow(raw: unknown): DrawDetailRecord {
  if (!isRow(raw)) return malformed('draw');
  const tierResults = Array.isArray(raw.draw_tier_results)
    ? raw.draw_tier_results.map(parseTierResultRow)
    : malformed('draw');
  return {
    ...parseDrawRow(raw),
    winningNumbers: raw.winning_numbers === null ? null : numbers(raw.winning_numbers, 'draw'),
    tierResults: tierResults.sort((a, b) => b.matchCount - a.matchCount),
  };
}

const SETTINGS_SELECT =
  'draw_number_min, draw_number_max, prize_pool_bps, prize_pool_per_subscription_minor';
const DRAW_COLUMNS =
  'id, draw_month, mode, status, scheduled_at, simulated_at, published_at, currency, prize_pool_minor, active_subscriber_count';

const DUPLICATE_MONTH = '23505';

export function createSupabaseDrawRepository(client: SupabaseClient): DrawRepository {
  return {
    async getSettings() {
      const response = await client
        .from('platform_settings')
        .select(SETTINGS_SELECT)
        .eq('id', true)
        .maybeSingle();
      if (response.error) throw new Error(`Settings lookup failed: ${response.error.message}`);
      const data: unknown = response.data; // untyped by supabase-js
      if (!isRow(data)) return { numberRange: null, pool: null };
      const min = data.draw_number_min;
      const max = data.draw_number_max;
      const numberRange =
        min === null || max === null
          ? null
          : { min: int(min, 'settings'), max: int(max, 'settings') };
      let pool: PoolConfig | null = null;
      if (data.prize_pool_bps !== null)
        pool = { kind: 'bps', bps: int(data.prize_pool_bps, 'settings') };
      else if (data.prize_pool_per_subscription_minor !== null) {
        pool = {
          kind: 'fixed',
          fixedMinor: int(data.prize_pool_per_subscription_minor, 'settings'),
        };
      }
      return { numberRange, pool };
    },

    async findByMonth(drawMonth) {
      const { data, error } = await client
        .from('draws')
        .select(DRAW_COLUMNS)
        .eq('draw_month', drawMonth)
        .maybeSingle();
      if (error) throw new Error(`Draw lookup failed: ${error.message}`);
      return data ? parseDrawRow(data) : null;
    },

    async findById(id) {
      const { data, error } = await client
        .from('draws')
        .select(`${DRAW_COLUMNS}, winning_numbers, draw_tier_results(*)`)
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(`Draw lookup failed: ${error.message}`);
      return data ? parseDrawDetailRow(data) : null;
    },

    async list() {
      const { data, error } = await client
        .from('draws')
        .select(DRAW_COLUMNS)
        .order('draw_month', { ascending: false });
      if (error) throw new Error(`Draw list failed: ${error.message}`);
      return (data as unknown[]).map(parseDrawRow);
    },

    async create({ drawMonth, mode: drawMode, createdBy }) {
      const { data, error } = await client
        .from('draws')
        .insert({ draw_month: drawMonth, mode: drawMode, created_by: createdBy })
        .select(DRAW_COLUMNS)
        .single();
      if (error) {
        if (error.code === DUPLICATE_MONTH) return { kind: 'duplicate_month' };
        throw new Error(`Draw creation failed: ${error.message}`);
      }
      return { kind: 'created', draw: parseDrawRow(data) };
    },

    async listEligibleTickets() {
      const idResponse = await client.rpc('active_subscriber_ids');
      if (idResponse.error)
        throw new Error(`Eligibility lookup failed: ${idResponse.error.message}`);
      const idRows: unknown = idResponse.data; // untyped by supabase-js
      const ids = (idRows as unknown[]).map((r) =>
        str(isRow(r) ? r.user_id : r, 'active subscriber id'),
      );
      if (ids.length === 0) return new Map();

      const { data, error } = await client
        .from('scores')
        .select('user_id, stableford_score')
        .in('user_id', ids)
        .order('user_id', { ascending: true })
        .order('played_on', { ascending: false });
      if (error) throw new Error(`Score lookup failed: ${error.message}`);

      const tickets = new Map<string, number[]>();
      for (const id of ids) tickets.set(id, []); // every active subscriber gets an entry, even with 0 scores
      for (const raw of data as unknown[]) {
        if (!isRow(raw)) malformed('score');
        const userId = str(raw.user_id, 'score');
        const scoreValue = int(raw.stableford_score, 'score');
        const list = tickets.get(userId);
        if (list && list.length < 5) list.push(scoreValue); // already ordered newest-first per user
      }
      return tickets;
    },

    async listPaymentBasesFunding(drawMonth) {
      const [year, month] = drawMonth.split('-').map(Number);
      const upper = new Date(Date.UTC(year as number, (month as number) - 1, 1));
      const lower = new Date(Date.UTC(year as number, (month as number) - 1 - 11, 1));

      const { data, error } = await client
        .from('payments')
        .select(
          'currency, period_start, subscriptions(plans(billing_interval)), charity_contributions(basis_minor)',
        )
        .eq('kind', 'subscription')
        .eq('state', 'succeeded')
        .gte('period_start', lower.toISOString())
        .lte('period_start', upper.toISOString());
      if (error) throw new Error(`Payment lookup failed: ${error.message}`);

      return (data as unknown[]).map((raw): PaymentBasis => {
        if (!isRow(raw)) return malformed('payment');
        const sub = raw.subscriptions;
        const plan = isRow(sub) ? sub.plans : null;
        const billingInterval = isRow(plan) ? plan.billing_interval : null;
        const contributions = raw.charity_contributions;
        const contribution: unknown = Array.isArray(contributions) ? contributions[0] : null;
        if (!isRow(contribution)) return malformed('payment (no charity contribution)');
        const periodStart = new Date(str(raw.period_start, 'payment'));
        return {
          basisMinor: int(contribution.basis_minor, 'payment'),
          currency: str(raw.currency, 'payment'),
          intervalMonths:
            billingInterval === 'year'
              ? 12
              : billingInterval === 'month'
                ? 1
                : malformed('payment'),
          periodStartMonth: `${String(periodStart.getUTCFullYear())}-${String(periodStart.getUTCMonth() + 1).padStart(2, '0')}-01`,
        };
      });
    },

    async getActiveMonthlyPlanCurrency() {
      const { data, error } = await client
        .from('plans')
        .select('currency')
        .eq('billing_interval', 'month')
        .eq('is_active', true)
        .maybeSingle();
      if (error) throw new Error(`Plan lookup failed: ${error.message}`);
      return isRow(data) ? str(data.currency, 'plan') : null;
    },

    async getPriorJackpotRollover(drawMonth) {
      const { data: prior, error: priorError } = await client
        .from('draws')
        .select('id')
        .eq('status', 'published')
        .lt('draw_month', drawMonth)
        .order('draw_month', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (priorError) throw new Error(`Draw lookup failed: ${priorError.message}`);
      if (!isRow(prior)) return 0;

      const { data: tier, error: tierError } = await client
        .from('draw_tier_results')
        .select('rollover_out_minor')
        .eq('draw_id', str(prior.id, 'draw'))
        .eq('match_count', 5)
        .maybeSingle();
      if (tierError) throw new Error(`Tier result lookup failed: ${tierError.message}`);
      return isRow(tier) ? int(tier.rollover_out_minor, 'tier result') : 0;
    },

    async simulate(input) {
      const { error } = await client.rpc('simulate_draw', {
        p_draw_id: input.drawId,
        p_winning_numbers: input.winningNumbers,
        p_active_subscriber_count: input.activeSubscriberCount,
        p_currency: input.currency,
        p_prize_pool_minor: input.prizePoolMinor,
        p_pool_contribution_bps: input.poolContributionBps,
        p_pool_contribution_fixed_minor: input.poolContributionFixedMinor,
        p_entries: input.entries.map((e) => ({
          user_id: e.userId,
          entry_numbers: e.entryNumbers,
          match_count: e.matchCount,
        })),
        p_tier_results: input.tierResults.map((t) => ({
          match_count: t.matchCount,
          share_bps: t.shareBps,
          rolls_over: t.rollsOver,
          base_pool_minor: t.basePoolMinor,
          rollover_in_minor: t.rolloverInMinor,
          winners_count: t.winnersCount,
          prize_per_winner_minor: t.prizePerWinnerMinor,
          remainder_minor: t.remainderMinor,
          rollover_out_minor: t.rolloverOutMinor,
        })),
      });
      if (error) {
        if (error.code === 'GS005') throw new DrawStateConflictError('already_published');
        throw new Error(`Simulation failed: ${error.message}`);
      }
    },

    async publish(drawId, publishedBy) {
      const response = await client.rpc('publish_draw', {
        p_draw_id: drawId,
        p_published_by: publishedBy,
      });
      if (response.error) {
        if (response.error.code === 'GS006') throw new DrawStateConflictError('not_simulated');
        throw new Error(`Publish failed: ${response.error.message}`);
      }
      const data: unknown = response.data; // untyped by supabase-js
      if (data !== 'published' && data !== 'already_published') {
        throw new Error('Publish returned an unexpected result');
      }
      return data;
    },

    async listMyParticipation(userId) {
      const { data, error } = await client
        .from('draw_entries')
        .select('match_count, draws!inner(id, draw_month, mode, status, winning_numbers)')
        .eq('user_id', userId)
        .eq('draws.status', 'published');
      if (error) throw new Error(`Draw participation lookup failed: ${error.message}`);
      const parsed = (data as unknown[]).map((raw): MyDrawParticipationDto => {
        if (!isRow(raw)) return malformed('draw entry');
        const draw = raw.draws;
        if (!isRow(draw)) return malformed('draw entry');
        return {
          drawId: str(draw.id, 'draw entry'),
          drawMonth: str(draw.draw_month, 'draw entry'),
          mode: mode(draw.mode, 'draw entry'),
          winningNumbers: numbers(draw.winning_numbers, 'draw entry'),
          matchCount: int(raw.match_count, 'draw entry'),
        };
      });
      // Newest month first (PRD §10 DSH-04); sorted here rather than via a cross-table PostgREST
      // order, mirroring findById()'s own tierResults sort above.
      return parsed.sort((a, b) => b.drawMonth.localeCompare(a.drawMonth));
    },
  };
}
