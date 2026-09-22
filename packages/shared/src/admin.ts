import { API_ADMIN_BASE_PATH } from './auth.js';
import type { PayoutStatus, VerificationStatus } from './enums.js';
import type { Parsed } from './scores.js';

// ---- Paths -----------------------------------------------------------------------------------

/** Admin user management (PRD §11 ADM-01). */
export const API_ADMIN_USERS_PATH = `${API_ADMIN_BASE_PATH}/users` as const;
/** Admin reports and analytics (PRD §11 ADM-07). */
export const API_ADMIN_REPORTS_PATH = `${API_ADMIN_BASE_PATH}/reports` as const;

// ---- Users (ADM-01: "view and edit user profiles; edit golf scores; manage subscriptions") ----

/** One row of the admin user list — enough to triage without opening the detail view. */
export interface AdminUserSummaryDto {
  id: string;
  /** From Supabase Auth (the service role reads it; never stored in `profiles`). */
  email: string | null;
  displayName: string | null;
  role: 'user' | 'admin';
  /** `is_active_subscriber(uuid)`'s own definition (D-070) — exactly what access is gated on. */
  hasActiveSubscription: boolean;
  /** The user's currently selected charity, or `null` if they have not chosen one. */
  charityName: string | null;
  /** How many of the user's (at most five) scores are currently on file. */
  scoreCount: number;
  createdAt: string;
}

/** The full admin view of one user, composed from the same repositories the user's own pages use. */
export interface AdminUserDetailDto extends AdminUserSummaryDto {
  subscription: {
    status: string;
    planName: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  charity: { id: string; name: string; isArchived: boolean } | null;
  percentageBps: number;
  /** Newest first (mirrors `GET /api/scores`). */
  scores: { id: string; playedOn: string; stablefordScore: number }[];
  /** Newest first (mirrors `GET /api/admin/winners`, filtered to this user). */
  winners: {
    id: string;
    drawMonth: string;
    matchCount: 3 | 4 | 5;
    prizeMinor: number;
    currency: string;
    verificationStatus: VerificationStatus;
    payoutStatus: PayoutStatus;
  }[];
}

export interface ListAdminUsersResponse {
  users: AdminUserSummaryDto[];
}

export interface AdminUserResponse {
  user: AdminUserDetailDto;
}

/**
 * `PATCH /api/admin/users/:id` — the one profile field an admin may edit directly. Role changes stay
 * a service-role/SQL-only operation (DECISIONS D-059); a user's own charity/percentage are their own
 * financial choice, not overridden here (unaffected by this endpoint).
 */
export interface UpdateAdminUserRequest {
  displayName: string;
}

const MAX_DISPLAY_NAME_LENGTH = 200;

export function parseUpdateAdminUserRequest(body: unknown): Parsed<UpdateAdminUserRequest> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: 'body', message: 'A JSON object is required.' }] };
  }
  const { displayName } = body as Record<string, unknown>;
  if (
    typeof displayName !== 'string' ||
    displayName.trim().length === 0 ||
    displayName.length > MAX_DISPLAY_NAME_LENGTH
  ) {
    return {
      ok: false,
      errors: [
        {
          field: 'displayName',
          message: `displayName must be a non-empty string of at most ${String(MAX_DISPLAY_NAME_LENGTH)} characters.`,
        },
      ],
    };
  }
  return { ok: true, value: { displayName: displayName.trim() } };
}

/** Stable `error.code` values specific to admin user management. */
export const ADMIN_USER_ERROR_CODES = {
  validation: 'validation_failed',
  /** No user exists with that id. HTTP 404. */
  notFound: 'admin_user_not_found',
} as const;

// ---- Reports (ADM-07: "total users; total prize pool; charity contribution totals; draw statistics")

/**
 * Every figure here is derived directly from already-stored facts — nothing is estimated or
 * fabricated. Exact definitions were left open by the PRD (DECISIONS D-029); the ones chosen here are
 * documented in DECISIONS D-074 and are deliberately the most literal reading of each term.
 */
export interface AdminReportsDto {
  /** Every row in `profiles` — every account that ever completed signup, regardless of subscription state. */
  totalUsers: number;
  /** Exactly `is_active_subscriber(uuid)`'s definition, counted (D-070). */
  activeSubscribers: number;
  draws: {
    total: number;
    draft: number;
    simulated: number;
    published: number;
  };
  /** Sum of `prize_pool_minor` across PUBLISHED draws only, one row per currency (never summed across currencies). */
  prizePoolByCurrency: { currency: string; amountMinor: number }[];
  /** Sum of `charity_contributions.amount_minor` (both subscription shares and donations), by currency. */
  charityContributionsByCurrency: { currency: string; amountMinor: number }[];
  winners: {
    total: number;
    awaitingProof: number;
    pendingReview: number;
    approved: number;
    rejected: number;
    paid: number;
  };
  /** When this snapshot was computed — these are live counts, not a stored/cached report. */
  generatedAt: string;
}

export interface AdminReportsResponse {
  reports: AdminReportsDto;
}
