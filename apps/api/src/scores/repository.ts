import type { SupabaseClient } from '@supabase/supabase-js';
import type { ScoreDto } from '@gather/shared';

/** What happened when adding a score. Business outcomes are values, not exceptions. */
export type AddScoreResult =
  | { kind: 'created'; score: ScoreDto; replacedPlayedOn: string | null }
  /** The user already has a score for that date (PRD §05: one per date). */
  | { kind: 'duplicate_date' }
  /** The date is older than all five existing scores (DECISIONS D-061). Nothing was changed. */
  | { kind: 'too_old' };

/**
 * Persistence for scores. EVERY method takes the user id explicitly and scopes by it: the service role
 * bypasses RLS, so ownership is enforced here and by the callers passing only a verified id.
 */
export interface ScoreRepository {
  /** The user's scores, newest date first. */
  list(userId: string): Promise<ScoreDto[]>;
  /** Adds a score atomically, replacing the oldest if the user already has five. */
  add(
    userId: string,
    input: { playedOn: string; stablefordScore: number },
  ): Promise<AddScoreResult>;
  /** Updates the value of the score for that date; `null` if the user has none. */
  update(userId: string, playedOn: string, stablefordScore: number): Promise<ScoreDto | null>;
  /** Deletes the score for that date; `false` if the user has none. */
  remove(userId: string, playedOn: string): Promise<boolean>;
}

const COLUMNS = 'id, played_on, stableford_score, created_at, updated_at';

/** SQLSTATEs raised by `public.add_score` (see the migration). PostgREST passes them through as `code`. */
const UNIQUE_VIOLATION = '23505';
const TOO_OLD = 'GS001';

/** Validates a `scores` row at the trust boundary and maps it to the API shape. Extra columns are ignored. */
export function parseScoreRow(row: unknown): ScoreDto {
  if (typeof row !== 'object' || row === null) throw new Error('Malformed score row');
  const r = row as Record<string, unknown>;
  const {
    id,
    played_on: playedOn,
    stableford_score: score,
    created_at: createdAt,
    updated_at: updatedAt,
  } = r;
  if (
    typeof id !== 'string' ||
    typeof playedOn !== 'string' ||
    typeof score !== 'number' ||
    !Number.isInteger(score) ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string'
  ) {
    throw new Error('Malformed score row');
  }
  return { id, playedOn, stablefordScore: score, createdAt, updatedAt };
}

function parseAddResult(data: unknown): { score: ScoreDto; replacedPlayedOn: string | null } {
  if (typeof data !== 'object' || data === null) throw new Error('Malformed add_score result');
  const { score, replaced_played_on: replaced } = data as Record<string, unknown>;
  if (replaced !== null && typeof replaced !== 'string')
    throw new Error('Malformed add_score result');
  return { score: parseScoreRow(score), replacedPlayedOn: replaced };
}

/** Supabase-backed repository, using the service-role client (server-side only). */
export function createSupabaseScoreRepository(client: SupabaseClient): ScoreRepository {
  return {
    async list(userId) {
      const { data, error } = await client
        .from('scores')
        .select(COLUMNS)
        .eq('user_id', userId)
        .order('played_on', { ascending: false });
      if (error) throw new Error(`Score lookup failed: ${error.message}`);
      return (data as unknown[]).map(parseScoreRow);
    },

    async add(userId, input) {
      // ONE call: the function takes a per-user lock, checks duplicates, evicts the oldest if needed and
      // inserts — all in one transaction. supabase-js cannot do that from separate statements.
      const response = await client.rpc('add_score', {
        p_user_id: userId,
        p_played_on: input.playedOn,
        p_stableford_score: input.stablefordScore,
      });
      const { error } = response;
      if (error) {
        if (error.code === UNIQUE_VIOLATION) return { kind: 'duplicate_date' };
        if (error.code === TOO_OLD) return { kind: 'too_old' };
        throw new Error(`add_score failed (${error.code}): ${error.message}`);
      }
      const data: unknown = response.data; // untyped by supabase-js: validated by parseAddResult
      return { kind: 'created', ...parseAddResult(data) };
    },

    async update(userId, playedOn, stablefordScore) {
      const { data, error } = await client
        .from('scores')
        .update({ stableford_score: stablefordScore })
        .eq('user_id', userId)
        .eq('played_on', playedOn)
        .select(COLUMNS)
        .maybeSingle();
      if (error) throw new Error(`Score update failed: ${error.message}`);
      return data === null ? null : parseScoreRow(data);
    },

    async remove(userId, playedOn) {
      const { data, error } = await client
        .from('scores')
        .delete()
        .eq('user_id', userId)
        .eq('played_on', playedOn)
        .select('id');
      if (error) throw new Error(`Score delete failed: ${error.message}`);
      return (data as unknown[]).length > 0;
    },
  };
}
