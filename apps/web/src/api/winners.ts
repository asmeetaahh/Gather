import {
  API_ADMIN_WINNERS_PATH,
  API_MY_WINNERS_PATH,
  STORAGE_BUCKETS,
  WINNER_PROOF_ALLOWED_MIME_TYPES,
  WINNER_PROOF_MAX_BYTES,
  type ListWinnersResponse,
  type RegisterWinnerProofRequest,
  type ReviewWinnerRequest,
  type WinnerResponse,
} from '@gather/shared';
import type { AuthClient } from '../auth/types';
import { apiRequest } from './client';

// ---- The signed-in user's own winnings (PRD §10 DSH-05; ROL-03 "upload winner proof") --------

export const fetchMyWinners = (accessToken: string) =>
  apiRequest<ListWinnersResponse>(API_MY_WINNERS_PATH, { accessToken });

export const fetchMyWinner = (accessToken: string, id: string) =>
  apiRequest<WinnerResponse>(`${API_MY_WINNERS_PATH}/${id}`, { accessToken });

/** Records a screenshot ALREADY uploaded directly to storage (see `uploadWinnerProofFile` below). */
export const registerWinnerProof = (
  accessToken: string,
  id: string,
  request: RegisterWinnerProofRequest,
) =>
  apiRequest<WinnerResponse>(`${API_MY_WINNERS_PATH}/${id}/proof`, {
    method: 'POST',
    accessToken,
    body: request,
  });

/** Re-opens a rejected winner for resubmission (DECISIONS D-021/D-037). */
export const reopenWinnerProof = (accessToken: string, id: string) =>
  apiRequest<WinnerResponse>(`${API_MY_WINNERS_PATH}/${id}/proof/reopen`, {
    method: 'POST',
    accessToken,
  });

// ---- Admin: verify submissions, mark payouts (PRD §11 ADM-06) --------------------------------

export const fetchAllWinners = (accessToken: string) =>
  apiRequest<ListWinnersResponse>(API_ADMIN_WINNERS_PATH, { accessToken });

export const fetchAdminWinner = (accessToken: string, id: string) =>
  apiRequest<WinnerResponse>(`${API_ADMIN_WINNERS_PATH}/${id}`, { accessToken });

export const reviewWinner = (accessToken: string, id: string, request: ReviewWinnerRequest) =>
  apiRequest<WinnerResponse>(`${API_ADMIN_WINNERS_PATH}/${id}/review`, {
    method: 'POST',
    accessToken,
    body: request,
  });

export const markWinnerPaid = (accessToken: string, id: string) =>
  apiRequest<WinnerResponse>(`${API_ADMIN_WINNERS_PATH}/${id}/paid`, {
    method: 'POST',
    accessToken,
  });

// ---- Direct-to-storage proof upload (never through the API — ARCHITECTURE.md §10) -------------

export type ProofUploadResult = { ok: true; storagePath: string } | { ok: false; message: string };

/**
 * Uploads a screenshot DIRECTLY to the private `winner-proofs` bucket, browser -> Supabase Storage,
 * using the signed-in user's own session. Storage RLS is the actual authority (only the owner of
 * this exact winner record, and only while it is `awaiting_proof` — `winner_proofs_objects_insert_owner`
 * in supabase/migrations/…100800_storage.sql); the client-side checks here are only a faster, friendlier
 * rejection than waiting for a round trip. Call `registerWinnerProof` with the returned path next.
 */
export async function uploadWinnerProofFile(
  storage: AuthClient['storage'],
  winnerId: string,
  file: File,
): Promise<ProofUploadResult> {
  if (!(WINNER_PROOF_ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, message: 'Only PNG, JPEG or WebP screenshots are accepted.' };
  }
  if (file.size > WINNER_PROOF_MAX_BYTES) {
    return { ok: false, message: 'That file is too large (10 MB maximum).' };
  }
  // A collision-resistant-enough name: the API re-validates the object actually exists before
  // trusting it, so nothing security-relevant depends on this name being unguessable.
  const storagePath = `${winnerId}/${String(Date.now())}-${file.name}`;
  const { error } = await storage
    .from(STORAGE_BUCKETS.winnerProofs)
    .upload(storagePath, file, { contentType: file.type });
  if (error) return { ok: false, message: error.message };
  return { ok: true, storagePath };
}
