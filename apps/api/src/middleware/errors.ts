import type { NextFunction, Request, Response } from 'express';
import type { ApiErrorBody } from '@gather/shared';
import { AppError, ValidationError } from '../errors.js';

/** Catch-all for unmatched `/api/*` routes: JSON 404 instead of Express's HTML page. */
export function apiNotFound(_req: Request, res: Response): void {
  const body: ApiErrorBody = { error: { code: 'not_found', message: 'Resource not found.' } };
  res.status(404).json(body);
}

/** Read an HTTP status off errors raised by Express/body-parser (`status`/`statusCode`). */
function statusOf(err: unknown): number {
  if (typeof err === 'object' && err !== null) {
    const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
    const candidate = typeof status === 'number' ? status : statusCode;
    if (typeof candidate === 'number' && candidate >= 400 && candidate <= 599) return candidate;
  }
  return 500;
}

/**
 * Final error handler. Always responds with the shared `ApiErrorBody` envelope and never leaks
 * internal error messages or stack traces to the client.
 *
 * - `AppError`: reported with its own status, code and (client-safe) message.
 * - Errors raised by Express/body-parser (e.g. malformed JSON): a generic 4xx.
 * - Anything else: logged, then a generic 500. Authorization always fails CLOSED — an unexpected
 *   error in an auth middleware ends the request here; it never falls through to the handler.
 */
export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof AppError) {
    if (err.status >= 500) console.error(`${err.code}:`, err.cause ?? err.message);
    for (const [name, value] of Object.entries(err.headers)) res.setHeader(name, value);
    const body: ApiErrorBody = {
      error: {
        code: err.code,
        message: err.message,
        ...(err instanceof ValidationError && { fieldErrors: err.fieldErrors }),
      },
    };
    res.status(err.status).json(body);
    return;
  }

  const status = statusOf(err);
  if (status >= 500) console.error('Unhandled API error:', err);

  const body: ApiErrorBody =
    status >= 500
      ? { error: { code: 'internal_error', message: 'An unexpected error occurred.' } }
      : { error: { code: 'bad_request', message: 'The request could not be processed.' } };
  res.status(status).json(body);
}
