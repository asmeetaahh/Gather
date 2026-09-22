import type { ScoreDto } from '@gather/shared';
import type { SubscriptionGate } from '../auth/entitlement.js';
import type { AddScoreResult, ScoreRepository } from '../scores/repository.js';

/**
 * Test doubles for the score layer. The in-memory repository mirrors the rules of the SQL function
 * `public.add_score` (oldest = earliest DATE, back-dated rejected, duplicate rejected before evicting) so
 * HTTP-level scenarios read naturally. It is NOT the authority: the real rules are proven against
 * PostgreSQL in supabase/tests/scores-function.test.ts.
 */
export class InMemoryScores implements ScoreRepository {
  private rows: (ScoreDto & { userId: string })[] = [];
  private nextId = 1;
  /** How many times each operation reached the "database" — proves rejected requests never got there. */
  readonly calls = { list: 0, add: 0, update: 0, remove: 0 };
  /** When set, every operation fails — simulates the database being unreachable. */
  failWith: Error | null = null;

  /** The API shape of a stored row (drops the owner). */
  private static toDto(row: ScoreDto & { userId: string }): ScoreDto {
    return {
      id: row.id,
      playedOn: row.playedOn,
      stablefordScore: row.stablefordScore,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private guard(): void {
    if (this.failWith) throw this.failWith;
  }

  /** Puts a score straight into storage, bypassing the rules (test setup). */
  seed(userId: string, playedOn: string, stablefordScore: number): void {
    const now = new Date().toISOString();
    this.rows.push({
      id: `s${String(this.nextId++)}`,
      userId,
      playedOn,
      stablefordScore,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** All of a user's rows as stored, newest date first (for assertions). */
  stored(userId: string): ScoreDto[] {
    return this.rows
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.playedOn.localeCompare(a.playedOn))
      .map((row) => InMemoryScores.toDto(row));
  }

  list(userId: string): Promise<ScoreDto[]> {
    this.calls.list++;
    this.guard();
    return Promise.resolve(this.stored(userId));
  }

  add(
    userId: string,
    input: { playedOn: string; stablefordScore: number },
  ): Promise<AddScoreResult> {
    this.calls.add++;
    this.guard();
    const mine = this.rows.filter((r) => r.userId === userId);
    if (mine.some((r) => r.playedOn === input.playedOn))
      return Promise.resolve({ kind: 'duplicate_date' });

    let replacedPlayedOn: string | null = null;
    if (mine.length >= 5) {
      const oldest = [...mine].sort((a, b) => a.playedOn.localeCompare(b.playedOn))[0];
      if (!oldest) throw new Error('unreachable');
      if (input.playedOn < oldest.playedOn) return Promise.resolve({ kind: 'too_old' });
      this.rows = this.rows.filter((r) => r.id !== oldest.id);
      replacedPlayedOn = oldest.playedOn;
    }
    const now = new Date().toISOString();
    const row = {
      id: `s${String(this.nextId++)}`,
      userId,
      playedOn: input.playedOn,
      stablefordScore: input.stablefordScore,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    return Promise.resolve({ kind: 'created', score: InMemoryScores.toDto(row), replacedPlayedOn });
  }

  update(userId: string, playedOn: string, stablefordScore: number): Promise<ScoreDto | null> {
    this.calls.update++;
    this.guard();
    const row = this.rows.find((r) => r.userId === userId && r.playedOn === playedOn);
    if (!row) return Promise.resolve(null);
    row.stablefordScore = stablefordScore;
    row.updatedAt = new Date().toISOString();
    return Promise.resolve(InMemoryScores.toDto(row));
  }

  remove(userId: string, playedOn: string): Promise<boolean> {
    this.calls.remove++;
    this.guard();
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !(r.userId === userId && r.playedOn === playedOn));
    return Promise.resolve(this.rows.length < before);
  }
}

/** Entitlement stand-in: a set of active subscribers that a test can change between requests. */
export class FakeSubscriptions implements SubscriptionGate {
  readonly active = new Set<string>();
  calls = 0;
  failWith: Error | null = null;

  isActiveSubscriber(userId: string): Promise<boolean> {
    this.calls++;
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.active.has(userId));
  }
}
