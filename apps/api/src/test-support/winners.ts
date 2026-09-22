import type { PayoutStatus, VerificationStatus } from '@gather/shared';
import {
  WinnerStateError,
  type AuditLogEntry,
  type WinnerDetailRecord,
  type WinnerProofRecord,
  type WinnerRecord,
  type WinnerRepository,
} from '../winners/repository.js';

/**
 * In-memory stand-in for `WinnerRepository`. It applies the SAME visible state machine the SQL
 * functions do (register only while awaiting_proof; reopen only from rejected; review only while
 * pending_review; pay only once approved, idempotently) so service-level scenarios read naturally —
 * it is NOT the authority for those rules; `supabase/tests/winners-function.test.ts` proves them on
 * PostgreSQL.
 */

interface StoredProof {
  id: string;
  storagePath: string;
  uploadedAt: string;
}

interface StoredWinner {
  id: string;
  drawId: string;
  userId: string;
  drawMonth: string;
  matchCount: 3 | 4 | 5;
  prizeMinor: number;
  currency: string;
  verificationStatus: VerificationStatus;
  payoutStatus: PayoutStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  paidAt: string | null;
  paidBy: string | null;
  createdAt: string;
  proofs: StoredProof[];
}

function toRecord(w: StoredWinner): WinnerRecord {
  return {
    id: w.id,
    drawId: w.drawId,
    userId: w.userId,
    drawMonth: w.drawMonth,
    matchCount: w.matchCount,
    prizeMinor: w.prizeMinor,
    currency: w.currency,
    verificationStatus: w.verificationStatus,
    payoutStatus: w.payoutStatus,
    createdAt: w.createdAt,
  };
}

function toDetailRecord(w: StoredWinner): WinnerDetailRecord {
  const proofs: WinnerProofRecord[] = w.proofs.map((p) => ({
    ...p,
    url: `signed://${p.storagePath}`,
  }));
  return {
    ...toRecord(w),
    reviewedAt: w.reviewedAt,
    reviewNote: w.reviewNote,
    paidAt: w.paidAt,
    proofs: [...proofs].reverse(), // newest first, matching the real repository's ordering
  };
}

export class InMemoryWinners implements WinnerRepository {
  private readonly winners: StoredWinner[] = [];
  private readonly uploadedObjects = new Set<string>();
  readonly auditLog: AuditLogEntry[] = [];
  private nextId = 1;
  private nextProofId = 1;
  failWith: Error | null = null;

  private id(): string {
    return `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`;
  }
  private guard(): void {
    if (this.failWith) throw this.failWith;
  }

  // ---- seeding ---------------------------------------------------------------------------------
  /** Seeds a winner (created as `publish_draw()` would: always `awaiting_proof` / `pending`). */
  seedWinner(options: {
    userId: string;
    drawId?: string;
    drawMonth?: string;
    matchCount?: 3 | 4 | 5;
    prizeMinor?: number;
    currency?: string;
    verificationStatus?: VerificationStatus;
    payoutStatus?: PayoutStatus;
  }): string {
    const id = this.id();
    this.winners.push({
      id,
      drawId: options.drawId ?? this.id(),
      userId: options.userId,
      drawMonth: options.drawMonth ?? '2027-01-01',
      matchCount: options.matchCount ?? 3,
      prizeMinor: options.prizeMinor ?? 1000,
      currency: options.currency ?? 'USD',
      verificationStatus: options.verificationStatus ?? 'awaiting_proof',
      payoutStatus: options.payoutStatus ?? 'pending',
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
      paidAt: null,
      paidBy: null,
      createdAt: '2027-01-01T00:00:00Z',
      proofs: [],
    });
    return id;
  }
  /** Marks a storage path as if the browser had already uploaded it directly (RLS-permitted). */
  seedUploadedObject(path: string): void {
    this.uploadedObjects.add(path);
  }
  winnerRow(id: string): StoredWinner | undefined {
    return this.winners.find((w) => w.id === id);
  }

  // ---- WinnerRepository --------------------------------------------------------------------------
  listForUser(userId: string): Promise<WinnerRecord[]> {
    this.guard();
    return Promise.resolve(
      this.winners
        .filter((w) => w.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(toRecord),
    );
  }

  listForAdmin(): Promise<WinnerRecord[]> {
    this.guard();
    return Promise.resolve(
      [...this.winners].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(toRecord),
    );
  }

  findOwnById(id: string, userId: string): Promise<WinnerDetailRecord | null> {
    this.guard();
    const w = this.winners.find((x) => x.id === id && x.userId === userId);
    return Promise.resolve(w ? toDetailRecord(w) : null);
  }

  findAdminById(id: string): Promise<WinnerDetailRecord | null> {
    this.guard();
    const w = this.winners.find((x) => x.id === id);
    return Promise.resolve(w ? toDetailRecord(w) : null);
  }

  registerProof(input: { winnerId: string; userId: string; storagePath: string }): Promise<void> {
    this.guard();
    const w = this.winners.find((x) => x.id === input.winnerId && x.userId === input.userId);
    if (!w) throw new Error('Winner not found');

    if (w.proofs.some((p) => p.storagePath === input.storagePath)) return Promise.resolve(); // retry

    if (w.verificationStatus !== 'awaiting_proof') throw new WinnerStateError('not_awaiting');
    if (!input.storagePath.startsWith(`${input.winnerId}/`)) {
      throw new WinnerStateError('path_invalid');
    }
    if (!this.uploadedObjects.has(input.storagePath)) throw new WinnerStateError('object_missing');

    w.proofs.push({
      id: `00000000-0000-4000-9000-${String(this.nextProofId++).padStart(12, '0')}`,
      storagePath: input.storagePath,
      uploadedAt: new Date().toISOString(),
    });
    w.verificationStatus = 'pending_review';
    return Promise.resolve();
  }

  reopenForResubmission(winnerId: string, userId: string): Promise<void> {
    this.guard();
    const w = this.winners.find((x) => x.id === winnerId && x.userId === userId);
    if (!w) throw new Error('Winner not found');
    if (w.verificationStatus !== 'rejected') throw new WinnerStateError('not_rejected');
    w.verificationStatus = 'awaiting_proof';
    w.reviewedBy = null;
    w.reviewedAt = null;
    w.reviewNote = null;
    return Promise.resolve();
  }

  review(
    winnerId: string,
    adminId: string,
    decision: 'approved' | 'rejected',
    note: string | null,
  ): Promise<void> {
    this.guard();
    const w = this.winners.find((x) => x.id === winnerId);
    if (!w) throw new Error('Winner not found');
    if (w.verificationStatus !== 'pending_review') throw new WinnerStateError('not_pending_review');
    w.verificationStatus = decision;
    w.reviewedBy = adminId;
    w.reviewedAt = new Date().toISOString();
    w.reviewNote = note;
    return Promise.resolve();
  }

  markPaid(winnerId: string, adminId: string): Promise<void> {
    this.guard();
    const w = this.winners.find((x) => x.id === winnerId);
    if (!w) throw new Error('Winner not found');
    if (w.payoutStatus === 'paid') return Promise.resolve(); // idempotent
    if (w.verificationStatus !== 'approved') throw new WinnerStateError('not_approved');
    w.payoutStatus = 'paid';
    w.paidAt = new Date().toISOString();
    w.paidBy = adminId;
    return Promise.resolve();
  }

  insertAuditLog(entry: AuditLogEntry): Promise<void> {
    this.guard();
    this.auditLog.push(entry);
    return Promise.resolve();
  }
}
