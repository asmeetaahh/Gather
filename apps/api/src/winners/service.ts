import {
  WINNER_ERROR_CODES,
  type ListWinnersResponse,
  type RegisterWinnerProofRequest,
  type ReviewWinnerRequest,
  type WinnerDetailDto,
  type WinnerSummaryDto,
} from '@gather/shared';
import { AppError } from '../errors.js';
import {
  WinnerStateError,
  type WinnerDetailRecord,
  type WinnerRecord,
  type WinnerRepository,
} from './repository.js';

export interface WinnerService {
  /** The signed-in user's own winnings (PRD §10 DSH-05). */
  listMine(userId: string): Promise<ListWinnersResponse>;
  getMine(id: string, userId: string): Promise<WinnerDetailDto>;
  /** Records a proof already uploaded directly to storage; moves verification to `pending_review`. */
  registerProof(
    id: string,
    userId: string,
    request: RegisterWinnerProofRequest,
  ): Promise<WinnerDetailDto>;
  /** Re-opens a rejected winner for resubmission (PRD §09; DECISIONS D-021/D-037). */
  reopenForResubmission(id: string, userId: string): Promise<WinnerDetailDto>;

  /** Every winner, for the admin queue (PRD §11 ADM-06). */
  listAll(): Promise<ListWinnersResponse>;
  getAdmin(id: string): Promise<WinnerDetailDto>;
  /** An admin's approve/reject decision (PRD §09 DRW-11). */
  review(id: string, adminId: string, request: ReviewWinnerRequest): Promise<WinnerDetailDto>;
  /** Marks an approved winner's payout paid (PRD §09 DRW-12, §11 ADM-06). */
  markPaid(id: string, adminId: string): Promise<WinnerDetailDto>;
}

export interface WinnerServiceDeps {
  repository: WinnerRepository;
}

const notFound = () => new AppError(404, WINNER_ERROR_CODES.notFound, 'No such winner exists.');

function toSummaryDto(record: WinnerRecord): WinnerSummaryDto {
  return { ...record };
}

function toDetailDto(record: WinnerDetailRecord): WinnerDetailDto {
  return { ...record };
}

/** Turns a `WinnerStateError` into the matching `AppError`; anything else propagates unchanged. */
function mapStateError(error: unknown): never {
  if (error instanceof WinnerStateError) {
    switch (error.kind) {
      case 'not_awaiting':
        throw new AppError(
          409,
          WINNER_ERROR_CODES.proofNotAwaiting,
          'This winner is not currently awaiting proof.',
        );
      case 'object_missing':
        throw new AppError(
          422,
          WINNER_ERROR_CODES.proofObjectMissing,
          'Upload the file to storage before registering it.',
        );
      case 'path_invalid':
        throw new AppError(
          422,
          WINNER_ERROR_CODES.proofPathInvalid,
          "The storage path must be inside this winner's own folder.",
        );
      case 'not_rejected':
        throw new AppError(
          409,
          WINNER_ERROR_CODES.notRejected,
          'Only a rejected submission can be reopened for resubmission.',
        );
      case 'not_pending_review':
        throw new AppError(
          409,
          WINNER_ERROR_CODES.notPendingReview,
          'This winner is not currently pending review.',
        );
      case 'not_approved':
        throw new AppError(
          409,
          WINNER_ERROR_CODES.notApproved,
          'A payout can only be marked paid once verification is approved.',
        );
    }
  }
  throw error;
}

/**
 * Winner verification and payout use-cases (PRD §09, §11 ADM-06).
 *
 * OWNERSHIP. Every user-scoped method is scoped by the caller's OWN id, exactly like
 * `scores/service.ts` — a winner belonging to someone else is reported as 404, never 403, so a
 * caller cannot learn that a winner id they guessed exists at all.
 *
 * PROOF BYTES never pass through this service — they go straight from the browser to the private
 * `winner-proofs` bucket, gated by storage RLS (ARCHITECTURE.md §10). This service only records
 * metadata and drives the state machine once the bytes are already there.
 */
export function createWinnerService({ repository }: WinnerServiceDeps): WinnerService {
  return {
    async listMine(userId) {
      return { winners: (await repository.listForUser(userId)).map(toSummaryDto) };
    },

    async getMine(id, userId) {
      const record = await repository.findOwnById(id, userId);
      if (!record) throw notFound();
      return toDetailDto(record);
    },

    async registerProof(id, userId, request) {
      try {
        await repository.registerProof({
          winnerId: id,
          userId,
          storagePath: request.storagePath,
        });
      } catch (error) {
        if (error instanceof WinnerStateError) mapStateError(error);
        if (error instanceof Error && error.message === 'Winner not found') throw notFound();
        throw error;
      }
      const record = await repository.findOwnById(id, userId);
      if (!record) throw notFound();
      return toDetailDto(record);
    },

    async reopenForResubmission(id, userId) {
      try {
        await repository.reopenForResubmission(id, userId);
      } catch (error) {
        if (error instanceof WinnerStateError) mapStateError(error);
        if (error instanceof Error && error.message === 'Winner not found') throw notFound();
        throw error;
      }
      const record = await repository.findOwnById(id, userId);
      if (!record) throw notFound();
      return toDetailDto(record);
    },

    async listAll() {
      return { winners: (await repository.listForAdmin()).map(toSummaryDto) };
    },

    async getAdmin(id) {
      const record = await repository.findAdminById(id);
      if (!record) throw notFound();
      return toDetailDto(record);
    },

    async review(id, adminId, request) {
      try {
        await repository.review(id, adminId, request.decision, request.note ?? null);
      } catch (error) {
        if (error instanceof WinnerStateError) mapStateError(error);
        if (error instanceof Error && error.message === 'Winner not found') throw notFound();
        throw error;
      }
      await repository.insertAuditLog({
        actorId: adminId,
        action: `winner.${request.decision}`,
        entityType: 'winner',
        entityId: id,
        ...(request.note !== undefined && { details: { note: request.note } }),
      });
      const record = await repository.findAdminById(id);
      if (!record) throw notFound();
      return toDetailDto(record);
    },

    async markPaid(id, adminId) {
      try {
        await repository.markPaid(id, adminId);
      } catch (error) {
        if (error instanceof WinnerStateError) mapStateError(error);
        if (error instanceof Error && error.message === 'Winner not found') throw notFound();
        throw error;
      }
      await repository.insertAuditLog({
        actorId: adminId,
        action: 'winner.paid',
        entityType: 'winner',
        entityId: id,
      });
      const record = await repository.findAdminById(id);
      if (!record) throw notFound();
      return toDetailDto(record);
    },
  };
}
