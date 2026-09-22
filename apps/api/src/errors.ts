import type { FieldError } from '@gather/shared';

/**
 * An error the API deliberately reports to the client with a specific status and stable code.
 *
 * Only `code` and `message` reach the response body (as the shared `ApiErrorBody`), so messages
 * must be safe to show to end users and must never contain internal details. Any other thrown error
 * is treated as unexpected and returned as a generic 500.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Extra response headers, e.g. `WWW-Authenticate` on a 401. */
    readonly headers: Readonly<Record<string, string>> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AppError';
  }
}

/** A request that failed validation: HTTP 400, listing what is wrong with which field. */
export class ValidationError extends AppError {
  constructor(readonly fieldErrors: FieldError[]) {
    super(400, 'validation_failed', 'The request is invalid.');
    this.name = 'ValidationError';
  }
}
