import type { SupabaseClient } from '@supabase/supabase-js';
import type { PayoutStatus, VerificationStatus } from '@gather/shared';

/**
 * The database refused a state-changing call because the winner's status had already moved on
 * (SQLSTATE GS007-GS012 from migration …160000) — a genuine conflict, not a transient failure. The
 * service decides what each `kind` means for its own flow.
 */
export class WinnerStateError extends Error {
  constructor(
    readonly kind:
      | 'not_awaiting'
      | 'object_missing'
      | 'path_invalid'
      | 'not_rejected'
      | 'not_pending_review'
      | 'not_approved',
  ) {
    super(`Winner state conflict: ${kind}`);
    this.name = 'WinnerStateError';
  }
}

// ---- Records --------------------------------------------------------------------------------

export interface WinnerProofRecord {
  id: string;
  storagePath: string;
  uploadedAt: string;
  /** A freshly-issued short-lived signed URL, or `null` if one could not be issued right now. */
  url: string | null;
}

export interface WinnerRecord {
  id: string;
  drawId: string;
  userId: string;
  /** First day of the calendar month the draw belongs to, `YYYY-MM-DD`. */
  drawMonth: string;
  matchCount: 3 | 4 | 5;
  prizeMinor: number;
  currency: string;
  verificationStatus: VerificationStatus;
  payoutStatus: PayoutStatus;
  createdAt: string;
}

export interface WinnerDetailRecord extends WinnerRecord {
  reviewedAt: string | null;
  reviewNote: string | null;
  paidAt: string | null;
  /** Newest first. */
  proofs: WinnerProofRecord[];
}

export interface AuditLogEntry {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
}

/**
 * Persistence for winner verification and payout tracking (PRD §09/§11). Every state-changing
 * write goes through a service-role-only SQL function (migration …160000) so a reader can never
 * observe a half-written winner. Owner-scoped methods take the user id explicitly and scope every
 * query by it, exactly like `scores/repository.ts` — a caller can never reach another user's winner
 * by guessing an id.
 */
export interface WinnerRepository {
  listForUser(userId: string): Promise<WinnerRecord[]>;
  listForAdmin(): Promise<WinnerRecord[]>;
  /** `null` if no such winner exists, or it exists but is not this user's own (indistinguishable). */
  findOwnById(id: string, userId: string): Promise<WinnerDetailRecord | null>;
  findAdminById(id: string): Promise<WinnerDetailRecord | null>;

  /** Records a proof the winner has already uploaded directly to storage; throws `WinnerStateError`. */
  registerProof(input: { winnerId: string; userId: string; storagePath: string }): Promise<void>;
  /** Re-opens a rejected winner for resubmission; throws `WinnerStateError`. */
  reopenForResubmission(winnerId: string, userId: string): Promise<void>;
  /** An admin's approve/reject decision; throws `WinnerStateError`. */
  review(
    winnerId: string,
    adminId: string,
    decision: 'approved' | 'rejected',
    note: string | null,
  ): Promise<void>;
  /** Marks an approved winner's payout paid; idempotent; throws `WinnerStateError`. */
  markPaid(winnerId: string, adminId: string): Promise<void>;

  /** Appends one admin_audit_log row (D-052; ARCHITECTURE §13: "each admin action... in the same request"). */
  insertAuditLog(entry: AuditLogEntry): Promise<void>;
}

// ---- Row parsing (an untyped boundary) -----------------------------------------------------------

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
function malformed(what: string): never {
  throw new Error(`Malformed ${what} row`);
}
const str = (v: unknown, what: string): string => (typeof v === 'string' ? v : malformed(what));
const strOrNull = (v: unknown, what: string): string | null => (v === null ? null : str(v, what));
const int = (v: unknown, what: string): number =>
  typeof v === 'number' && Number.isSafeInteger(v) ? v : malformed(what);
function matchCountOf(v: unknown, what: string): 3 | 4 | 5 {
  return v === 3 || v === 4 || v === 5 ? v : malformed(what);
}
function verificationStatusOf(v: unknown, what: string): VerificationStatus {
  return v === 'awaiting_proof' || v === 'pending_review' || v === 'approved' || v === 'rejected'
    ? v
    : malformed(what);
}
function payoutStatusOf(v: unknown, what: string): PayoutStatus {
  return v === 'pending' || v === 'paid' ? v : malformed(what);
}

function parseWinnerRow(raw: unknown): WinnerRecord {
  if (!isRow(raw)) return malformed('winner');
  const draw = raw.draws;
  const drawMonth = isRow(draw) ? str(draw.draw_month, 'winner') : malformed('winner');
  return {
    id: str(raw.id, 'winner'),
    drawId: str(raw.draw_id, 'winner'),
    userId: str(raw.user_id, 'winner'),
    drawMonth,
    matchCount: matchCountOf(raw.match_count, 'winner'),
    prizeMinor: int(raw.prize_minor, 'winner'),
    currency: str(raw.currency, 'winner'),
    verificationStatus: verificationStatusOf(raw.verification_status, 'winner'),
    payoutStatus: payoutStatusOf(raw.payout_status, 'winner'),
    createdAt: str(raw.created_at, 'winner'),
  };
}

function parseWinnerDetailRow(raw: unknown, proofs: WinnerProofRecord[]): WinnerDetailRecord {
  if (!isRow(raw)) return malformed('winner');
  return {
    ...parseWinnerRow(raw),
    reviewedAt: strOrNull(raw.reviewed_at, 'winner'),
    reviewNote: strOrNull(raw.review_note, 'winner'),
    paidAt: strOrNull(raw.paid_at, 'winner'),
    proofs,
  };
}

const WINNER_COLUMNS =
  'id, draw_id, user_id, match_count, prize_minor, currency, verification_status, payout_status, created_at, draws(draw_month)';
const WINNER_DETAIL_COLUMNS = `${WINNER_COLUMNS}, reviewed_at, review_note, paid_at`;

/** Short-lived: proof stays private (ARCHITECTURE.md §10), a fresh URL is issued on every read. */
const SIGNED_URL_TTL_SECONDS = 300;

export function createSupabaseWinnerRepository(client: SupabaseClient): WinnerRepository {
  async function signedProofUrl(storagePath: string): Promise<string | null> {
    const { data, error } = await client.storage
      .from('winner-proofs')
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
    return error ? null : (data.signedUrl ?? null);
  }

  async function loadProofs(winnerId: string): Promise<WinnerProofRecord[]> {
    const { data, error } = await client
      .from('winner_proofs')
      .select('id, storage_path, uploaded_at')
      .eq('winner_id', winnerId)
      .order('uploaded_at', { ascending: false });
    if (error) throw new Error(`Proof lookup failed: ${error.message}`);
    return Promise.all(
      (data as unknown[]).map(async (raw): Promise<WinnerProofRecord> => {
        if (!isRow(raw)) return malformed('winner proof');
        const storagePath = str(raw.storage_path, 'winner proof');
        return {
          id: str(raw.id, 'winner proof'),
          storagePath,
          uploadedAt: str(raw.uploaded_at, 'winner proof'),
          url: await signedProofUrl(storagePath),
        };
      }),
    );
  }

  async function toDetail(data: unknown): Promise<WinnerDetailRecord | null> {
    if (!data) return null;
    const winnerId = isRow(data) ? str(data.id, 'winner') : malformed('winner');
    return parseWinnerDetailRow(data, await loadProofs(winnerId));
  }

  return {
    async listForUser(userId) {
      const { data, error } = await client
        .from('winners')
        .select(WINNER_COLUMNS)
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw new Error(`Winner list failed: ${error.message}`);
      return (data as unknown[]).map(parseWinnerRow);
    },

    async listForAdmin() {
      const { data, error } = await client
        .from('winners')
        .select(WINNER_COLUMNS)
        .order('created_at', { ascending: false });
      if (error) throw new Error(`Winner list failed: ${error.message}`);
      return (data as unknown[]).map(parseWinnerRow);
    },

    async findOwnById(id, userId) {
      const { data, error } = await client
        .from('winners')
        .select(WINNER_DETAIL_COLUMNS)
        .eq('id', id)
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw new Error(`Winner lookup failed: ${error.message}`);
      return toDetail(data);
    },

    async findAdminById(id) {
      const { data, error } = await client
        .from('winners')
        .select(WINNER_DETAIL_COLUMNS)
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(`Winner lookup failed: ${error.message}`);
      return toDetail(data);
    },

    async registerProof({ winnerId, userId, storagePath }) {
      const { error } = await client.rpc('register_winner_proof', {
        p_winner_id: winnerId,
        p_user_id: userId,
        p_storage_path: storagePath,
      });
      if (error) {
        if (error.code === '23503') throw new Error('Winner not found'); // mapped to 404 by the service
        if (error.code === 'GS007') throw new WinnerStateError('not_awaiting');
        if (error.code === 'GS008') throw new WinnerStateError('object_missing');
        if (error.code === 'GS009') throw new WinnerStateError('path_invalid');
        throw new Error(`Proof registration failed: ${error.message}`);
      }
    },

    async reopenForResubmission(winnerId, userId) {
      const { error } = await client.rpc('reopen_winner_proof', {
        p_winner_id: winnerId,
        p_user_id: userId,
      });
      if (error) {
        if (error.code === '23503') throw new Error('Winner not found');
        if (error.code === 'GS010') throw new WinnerStateError('not_rejected');
        throw new Error(`Reopen failed: ${error.message}`);
      }
    },

    async review(winnerId, adminId, decision, note) {
      const { error } = await client.rpc('review_winner', {
        p_winner_id: winnerId,
        p_admin_id: adminId,
        p_decision: decision,
        p_note: note,
      });
      if (error) {
        if (error.code === '23503') throw new Error('Winner not found');
        if (error.code === 'GS011') throw new WinnerStateError('not_pending_review');
        throw new Error(`Review failed: ${error.message}`);
      }
    },

    async markPaid(winnerId, adminId) {
      const { error } = await client.rpc('mark_winner_paid', {
        p_winner_id: winnerId,
        p_admin_id: adminId,
      });
      if (error) {
        if (error.code === '23503') throw new Error('Winner not found');
        if (error.code === 'GS012') throw new WinnerStateError('not_approved');
        throw new Error(`Mark-paid failed: ${error.message}`);
      }
    },

    async insertAuditLog(entry) {
      const { error } = await client.from('admin_audit_log').insert({
        actor_id: entry.actorId,
        action: entry.action,
        entity_type: entry.entityType,
        entity_id: entry.entityId,
        details: entry.details ?? {},
      });
      if (error) throw new Error(`Audit log write failed: ${error.message}`);
    },
  };
}
