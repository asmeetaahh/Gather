import { API_ADMIN_BASE_PATH, API_ME_PATH } from './auth.js';
import type { PayoutStatus, VerificationStatus } from './enums.js';
import type { FieldError } from './errors.js';
import type { Parsed } from './scores.js';

// ---- Paths -----------------------------------------------------------------------------------

/** A signed-in user's own winnings (PRD §09/§10 DSH-05; ROL-03 "upload winner proof"). */
export const API_MY_WINNERS_PATH = `${API_ME_PATH}/winners` as const;

/** Admin winners management: verify submissions, mark payouts (PRD §11 ADM-06). */
export const API_ADMIN_WINNERS_PATH = `${API_ADMIN_BASE_PATH}/winners` as const;

// ---- Storage limits (DEVELOPMENT DEFAULTS, not PRD values — DECISIONS D-021/D-051) -----------
// Mirrors the `winner-proofs` bucket configuration in supabase/migrations/…100800_storage.sql, so the
// web form can reject an obviously-too-big or wrong-type file before ever attempting an upload. The
// bucket itself is the actual authority; this is a convenience, not a second source of truth for size.

export const WINNER_PROOF_MAX_BYTES = 10_485_760;
export const WINNER_PROOF_ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

// ---- Contracts --------------------------------------------------------------------------------

export interface WinnerProofDto {
  id: string;
  /** Object path inside the private `winner-proofs` bucket: `<winnerId>/<file>`. */
  storagePath: string;
  uploadedAt: string;
  /**
   * A short-lived signed URL to view this proof (never a public bucket URL, PRD §09 — proof stays
   * private). `null` if a signed URL could not be issued (e.g. the underlying object is missing).
   */
  url: string | null;
}

/** A prize won (PRD §09 winner verification; §10 DSH-05 winnings overview). */
export interface WinnerSummaryDto {
  id: string;
  drawId: string;
  /** First day of the calendar month the draw belongs to, `YYYY-MM-DD` (context for "which draw"). */
  drawMonth: string;
  matchCount: 3 | 4 | 5;
  prizeMinor: number;
  currency: string;
  verificationStatus: VerificationStatus;
  payoutStatus: PayoutStatus;
  createdAt: string;
}

export interface WinnerDetailDto extends WinnerSummaryDto {
  reviewedAt: string | null;
  reviewNote: string | null;
  paidAt: string | null;
  /** Newest first. Multiple rows accumulate across resubmissions (DECISIONS D-021/D-037). */
  proofs: WinnerProofDto[];
}

export interface ListWinnersResponse {
  winners: WinnerSummaryDto[];
}

export interface WinnerResponse {
  winner: WinnerDetailDto;
}

/**
 * `POST /api/me/winners/:id/proof` — records a screenshot the winner has ALREADY uploaded directly to
 * the private `winner-proofs` bucket (browser → Supabase Storage, gated by RLS on the winner's own,
 * currently-`awaiting_proof` record — see ARCHITECTURE.md §10). This call only registers the metadata
 * and moves verification to `pending_review`; it never carries file bytes.
 */
export interface RegisterWinnerProofRequest {
  /** The exact object path just uploaded, `<winnerId>/<file>`. */
  storagePath: string;
}

/** `POST /api/admin/winners/:id/review` — an admin's approve/reject decision (PRD §09 DRW-11). */
export interface ReviewWinnerRequest {
  decision: 'approved' | 'rejected';
  /** Optional note shown to the winner, e.g. why a submission was rejected. */
  note?: string;
}

/** Stable `error.code` values specific to winners (in addition to the shared auth codes). */
export const WINNER_ERROR_CODES = {
  /** The request body is invalid. HTTP 400, with `fieldErrors`. */
  validation: 'validation_failed',
  /** No winner exists with that id (or it is not the caller's own). HTTP 404. */
  notFound: 'winner_not_found',
  /**
   * Proof can only be registered while the winner is `awaiting_proof` (a first submission, or after an
   * explicit reopen following rejection — DECISIONS D-021/D-037). HTTP 409.
   */
  proofNotAwaiting: 'winner_proof_not_awaiting',
  /** The referenced storage object does not exist yet — upload it first. HTTP 422. */
  proofObjectMissing: 'winner_proof_object_missing',
  /** The storage path is not inside this winner's own folder. HTTP 422. */
  proofPathInvalid: 'winner_proof_path_invalid',
  /** Resubmission can only be opened from `rejected` (DECISIONS D-021/D-037). HTTP 409. */
  notRejected: 'winner_not_rejected',
  /** A decision can only be recorded while a submission is `pending_review`. HTTP 409. */
  notPendingReview: 'winner_not_pending_review',
  /** A payout can only be marked paid once verification is `approved` (DECISIONS D-022/D-037). HTTP 409. */
  notApproved: 'winner_not_approved_for_payout',
} as const;

export type WinnerErrorCode = (typeof WINNER_ERROR_CODES)[keyof typeof WINNER_ERROR_CODES];

// ---- Validation (pure; used by the API) ------------------------------------------------------

const bodyError = (): FieldError[] => [{ field: 'body', message: 'A JSON object is required.' }];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAX_STORAGE_PATH_LENGTH = 512;

/** Validates `POST /api/me/winners/:id/proof`. Only `storagePath` is read; anything else is ignored. */
export function parseRegisterWinnerProofRequest(body: unknown): Parsed<RegisterWinnerProofRequest> {
  if (!isPlainObject(body)) return { ok: false, errors: bodyError() };
  const { storagePath } = body;
  if (
    typeof storagePath !== 'string' ||
    storagePath.length === 0 ||
    storagePath.length > MAX_STORAGE_PATH_LENGTH
  ) {
    return {
      ok: false,
      errors: [{ field: 'storagePath', message: 'storagePath must be a non-empty string.' }],
    };
  }
  return { ok: true, value: { storagePath } };
}

const MAX_NOTE_LENGTH = 2000;

/** Validates `POST /api/admin/winners/:id/review`. */
export function parseReviewWinnerRequest(body: unknown): Parsed<ReviewWinnerRequest> {
  if (!isPlainObject(body)) return { ok: false, errors: bodyError() };
  const errors: FieldError[] = [];

  if (body.decision !== 'approved' && body.decision !== 'rejected') {
    errors.push({ field: 'decision', message: 'decision must be "approved" or "rejected".' });
  }
  let note: string | undefined;
  if (body.note !== undefined) {
    if (typeof body.note !== 'string' || body.note.length > MAX_NOTE_LENGTH) {
      errors.push({
        field: 'note',
        message: `note must be a string of at most ${String(MAX_NOTE_LENGTH)} characters.`,
      });
    } else {
      note = body.note;
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      decision: body.decision as 'approved' | 'rejected',
      ...(note !== undefined && { note }),
    },
  };
}
