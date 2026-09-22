import { API_ADMIN_BASE_PATH, API_ME_PATH } from './auth.js';
import { DRAW_MODES, type DrawMode, type DrawStatus } from './enums.js';
import type { FieldError } from './errors.js';
import type { Parsed } from './scores.js';

// ---- Paths -----------------------------------------------------------------------------------

/** Every draw-management endpoint: admin only (PRD §11 ADM-02/03/04). */
export const API_ADMIN_DRAWS_PATH = `${API_ADMIN_BASE_PATH}/draws` as const;

/** The signed-in user's own draw participation (PRD §10 DSH-04). */
export const API_MY_DRAWS_PATH = `${API_ME_PATH}/draws` as const;

// ---- Contracts --------------------------------------------------------------------------------

/** A draw's per-tier outcome, whether still candidate (simulated) or frozen (published). */
export interface DrawTierResultDto {
  matchCount: 3 | 4 | 5;
  /** Basis points of the pool this tier received when the draw was (last) simulated (PRD §07: 40/35/25). */
  shareBps: number;
  /** Only the 5-match jackpot rolls over (PRD §07, DECISIONS D-035/D-071). */
  rollsOver: boolean;
  /** This draw's own share of the pool for the tier, in integer minor units. */
  basePoolMinor: number;
  /** Carried in from an earlier draw's unclaimed jackpot (only ever nonzero for the 5-match tier). */
  rolloverInMinor: number;
  winnersCount: number;
  /** Equal share per winner (floor division; PRD §07 "split equally", DECISIONS D-071). */
  prizePerWinnerMinor: number;
  /** Left over from the equal split; never paid to anyone (DECISIONS D-071). */
  remainderMinor: number;
  /** Carried into the next draw's `rolloverInMinor` when this tier had zero winners (jackpot only). */
  rolloverOutMinor: number;
}

export interface DrawSummaryDto {
  id: string;
  /** First day of the calendar month this draw belongs to, `YYYY-MM-DD` (PRD §06: monthly cadence). */
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

export interface DrawDetailDto extends DrawSummaryDto {
  /** The drawn numbers, or `null` for a draw that has never been simulated. */
  winningNumbers: number[] | null;
  tierResults: DrawTierResultDto[];
}

export interface ListDrawsResponse {
  draws: DrawSummaryDto[];
}

export interface DrawResponse {
  draw: DrawDetailDto;
}

/**
 * `GET /api/me/draws` — one row per PUBLISHED draw the caller was entered in (PRD §10 DSH-04:
 * "draws entered"). Draft and simulated draws never appear here, whether or not the caller has a
 * candidate entry in one — candidate results must never leak (DECISIONS D-050), matching exactly what
 * the `draw_entries_select_own_published` RLS policy already restricts a direct read to. The winning
 * numbers are safe to include because the draw is published.
 */
export interface MyDrawParticipationDto {
  drawId: string;
  /** First day of the calendar month this draw belongs to, `YYYY-MM-DD`. */
  drawMonth: string;
  mode: DrawMode;
  winningNumbers: number[];
  /** How many of the caller's numbers matched this draw (0-5). */
  matchCount: number;
}

export interface ListMyDrawParticipationResponse {
  draws: MyDrawParticipationDto[];
}

/** `POST /api/admin/draws` — creates a new draft draw for a month that has none yet. */
export interface CreateDrawRequest {
  /** First day of the calendar month, `YYYY-MM-DD` (PRD §06: monthly cadence; DECISIONS D-041). */
  drawMonth: string;
  mode: DrawMode;
}

/** Stable `error.code` values specific to draws (in addition to the shared auth codes). */
export const DRAW_ERROR_CODES = {
  /** The request body/parameters are invalid. HTTP 400, with `fieldErrors`. */
  validation: 'validation_failed',
  /** No draw exists with that id. HTTP 404. */
  notFound: 'draw_not_found',
  /** A draw already exists for that calendar month (DECISIONS D-041: one draw per month). HTTP 409. */
  duplicateMonth: 'draw_month_exists',
  /**
   * Neither `platform_settings.prize_pool_bps` nor `prize_pool_per_subscription_minor` is configured
   * (DECISIONS D-014, D-071): the prize pool genuinely cannot be computed yet. HTTP 422.
   */
  poolNotConfigured: 'prize_pool_not_configured',
  /**
   * The payments funding the pool this month are not all in the same currency, so they cannot be
   * summed into one pool without an assumption this system does not make. HTTP 422.
   */
  mixedCurrency: 'prize_pool_mixed_currency',
  /** Publishing needs a simulated draw first (DECISIONS D-018/D-071: DRAFT → SIMULATED → PUBLISHED). HTTP 422. */
  notSimulated: 'draw_not_simulated',
} as const;

export type DrawErrorCode = (typeof DRAW_ERROR_CODES)[keyof typeof DRAW_ERROR_CODES];

// ---- Validation (pure; used by the API) ------------------------------------------------------

const bodyError = (): FieldError[] => [{ field: 'body', message: 'A JSON object is required.' }];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for `YYYY-MM-01` — the exact shape `draws.draw_month` requires (DECISIONS D-041). */
function isFirstOfMonth(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-01$/.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return false;
  // Reject an impossible calendar month such as 2026-13 having already failed above; nothing further
  // to check for day "01", which always exists.
  return true;
}

/** Validates `POST /api/admin/draws`. Only `drawMonth` and `mode` are read; anything else is ignored. */
export function parseCreateDrawRequest(body: unknown): Parsed<CreateDrawRequest> {
  if (!isPlainObject(body)) return { ok: false, errors: bodyError() };
  const errors: FieldError[] = [];

  if (!isFirstOfMonth(body.drawMonth)) {
    errors.push({
      field: 'drawMonth',
      message: 'drawMonth must be the first day of a calendar month, as YYYY-MM-01.',
    });
  }
  if (!(DRAW_MODES as readonly unknown[]).includes(body.mode)) {
    errors.push({ field: 'mode', message: `mode must be one of: ${DRAW_MODES.join(', ')}.` });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { drawMonth: body.drawMonth as string, mode: body.mode as DrawMode },
  };
}
