import { SCORE_MAX, SCORE_MIN } from './domain.js';
import type { FieldError } from './errors.js';

/** Base path of the score endpoints. All of them require a signed-in user and act only as that user. */
export const API_SCORES_PATH = '/api/scores' as const;

/** A stored Stableford score, as returned by the API. */
export interface ScoreDto {
  id: string;
  /** Calendar date of the round, `YYYY-MM-DD` (no time, no timezone). */
  playedOn: string;
  /** Integer from 1 to 45 (PRD §05). */
  stablefordScore: number;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/scores` — the user's own scores, NEWEST first (PRD §05: reverse chronological). */
export interface ListScoresResponse {
  scores: ScoreDto[];
}

/** `POST /api/scores` */
export interface CreateScoreRequest {
  playedOn: string;
  stablefordScore: number;
}

/** `201` response of `POST /api/scores`. */
export interface CreateScoreResponse {
  score: ScoreDto;
  /**
   * The date of the score that was removed to make room, or `null` if there was room. Present so a UI
   * can tell the user which score was replaced (PRD §05: "replaces the oldest stored score").
   */
  replacedPlayedOn: string | null;
}

/** `PUT /api/scores/:playedOn` — edits the value of the score for that date. */
export interface UpdateScoreRequest {
  stablefordScore: number;
}

/** `200` response of `PUT /api/scores/:playedOn`. */
export interface UpdateScoreResponse {
  score: ScoreDto;
}

/** Stable `error.code` values specific to scores (in addition to the shared auth codes). */
export const SCORE_ERROR_CODES = {
  /** The request body/parameters are invalid. HTTP 400, with `fieldErrors`. */
  validation: 'validation_failed',
  /** Writing scores needs an active subscription. HTTP 403. */
  subscriptionRequired: 'subscription_required',
  /** The user already has a score for that date (PRD §05: one per date). HTTP 409. */
  duplicateDate: 'score_date_exists',
  /** The user has no score for that date. HTTP 404. */
  notFound: 'score_not_found',
  /** The date is older than all five of the user's scores (DECISIONS D-061). HTTP 422. */
  tooOld: 'score_too_old',
} as const;

export type ScoreErrorCode = (typeof SCORE_ERROR_CODES)[keyof typeof SCORE_ERROR_CODES];

// ---- Validation (pure; used by the API and reusable by the web UI) --------------------------------

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date in `YYYY-MM-DD` form (rejects `2026-02-30`, `2026-13-01`, `26-1-1`, …). */
export function isValidCalendarDate(value: string): boolean {
  const match = DATE_SHAPE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(0);
  // setUTCFullYear (unlike Date.UTC) does not treat years 0-99 as 1900-1999.
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Error message for an invalid Stableford value, or `null` if valid. PRD §05: an integer from 1 to 45.
 * Strict about the JSON type: `"30"`, `30.5`, `true`, `null` and `NaN` are all rejected.
 */
export function stablefordScoreError(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return 'The score must be a whole number.';
  }
  if (value < SCORE_MIN || value > SCORE_MAX) {
    return `The score must be between ${String(SCORE_MIN)} and ${String(SCORE_MAX)}.`;
  }
  return null;
}

/**
 * Error message for an invalid round date, or `null` if valid. PRD §05: every score has a date.
 * Only the FORMAT and calendar validity are checked: future dates and a maximum age are undecided
 * (DECISIONS D-027) and deliberately not enforced.
 */
export function playedOnError(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return 'A date is required (YYYY-MM-DD).';
  if (!isValidCalendarDate(value))
    return 'The date must be a real calendar date in YYYY-MM-DD form.';
  return null;
}

const bodyError = (): FieldError[] => [{ field: 'body', message: 'A JSON object is required.' }];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collects field errors; `null` messages mean "valid". */
function collect(checks: [field: string, message: string | null][]): FieldError[] {
  return checks.flatMap(([field, message]) => (message === null ? [] : [{ field, message }]));
}

/**
 * Validates a `POST /api/scores` body. Only `playedOn` and `stablefordScore` are read: any other field
 * (e.g. a `userId`) is ignored, so a client can never choose whose score it is.
 */
export function parseCreateScore(body: unknown): Parsed<CreateScoreRequest> {
  if (!isPlainObject(body)) return { ok: false, errors: bodyError() };
  const errors = collect([
    ['playedOn', playedOnError(body.playedOn)],
    ['stablefordScore', stablefordScoreError(body.stablefordScore)],
  ]);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { playedOn: body.playedOn as string, stablefordScore: body.stablefordScore as number },
  };
}

/** Validates a `PUT /api/scores/:playedOn` body. */
export function parseUpdateScore(body: unknown): Parsed<UpdateScoreRequest> {
  if (!isPlainObject(body)) return { ok: false, errors: bodyError() };
  const errors = collect([['stablefordScore', stablefordScoreError(body.stablefordScore)]]);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { stablefordScore: body.stablefordScore as number } };
}

/** Validates the `:playedOn` path parameter. */
export function parsePlayedOnParam(value: unknown): Parsed<string> {
  const message = playedOnError(value);
  return message === null
    ? { ok: true, value: value as string }
    : { ok: false, errors: [{ field: 'playedOn', message }] };
}
