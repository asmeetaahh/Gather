import type { RequestHandler } from 'express';
import { AUTH_ERROR_CODES, type AppRole } from '@gather/shared';
import { AppError } from '../errors.js';
import type { ProfileRepository } from './profiles.js';
import { InvalidTokenError, type TokenVerifier } from './verifier.js';

/** What the API needs to authenticate a request. Injected so tests can supply their own key set. */
export interface AuthDeps {
  verifier: TokenVerifier;
  profiles: ProfileRepository;
}

/** The authenticated caller, set on `req.auth` by `requireAuth`. Derived only from verified data. */
export interface AuthContext {
  userId: string;
  email: string | null;
  /** From `profiles.role` in the database — never from the token (D-005). */
  role: AppRole;
  displayName: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

/** Refuse absurdly large "tokens" before parsing them. Real Supabase access tokens are ~1 KB. */
const MAX_TOKEN_LENGTH = 8192;

const unauthenticated = () =>
  new AppError(401, AUTH_ERROR_CODES.unauthenticated, 'Authentication required.', {
    'WWW-Authenticate': 'Bearer',
  });

const invalidToken = () =>
  new AppError(401, AUTH_ERROR_CODES.invalidToken, 'Your session is invalid or has expired.', {
    'WWW-Authenticate': 'Bearer error="invalid_token"',
  });

/** Extracts the token from `Authorization: Bearer <token>`. */
function readBearerToken(header: string | undefined): string {
  if (header === undefined) throw unauthenticated();
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match?.[1]) throw invalidToken();
  const token = match[1];
  if (token.length > MAX_TOKEN_LENGTH) throw invalidToken();
  return token;
}

/**
 * Authenticates the request and loads the caller's profile.
 *
 * 1. The bearer token is verified server-side (signature, issuer, audience, expiry).
 * 2. The role is read from `profiles.role` in the database on EVERY request — no caching — so a
 *    demoted or deleted user loses access immediately, and nothing the client controls (token
 *    claims, metadata, query, body) can influence it.
 *
 * Fails closed: if auth is not configured, the key set is unreachable, or the database lookup
 * fails, the request is rejected (503/500) and never reaches the handler.
 */
export function requireAuth(deps: AuthDeps | undefined): RequestHandler {
  return async (req, _res, next) => {
    if (!deps) {
      throw new AppError(
        503,
        AUTH_ERROR_CODES.authUnavailable,
        'Authentication is not available right now.',
      );
    }

    const token = readBearerToken(req.header('authorization'));

    let identity;
    try {
      identity = await deps.verifier(token);
    } catch (error) {
      if (error instanceof InvalidTokenError) throw invalidToken();
      throw new AppError(
        503,
        AUTH_ERROR_CODES.authUnavailable,
        'Authentication is not available right now.',
        {},
        { cause: error },
      );
    }

    const profile = await deps.profiles.findById(identity.userId);
    if (!profile) {
      throw new AppError(
        403,
        AUTH_ERROR_CODES.profileMissing,
        'Your account is not set up yet. Please contact support.',
      );
    }

    req.auth = {
      userId: profile.id,
      email: identity.email,
      role: profile.role,
      displayName: profile.displayName,
    };
    next();
  };
}

/**
 * Allows only administrators. MUST run after `requireAuth`; if it ever runs without an authenticated
 * caller it rejects (deny by default) rather than assuming another layer already checked.
 */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  const auth = req.auth;
  if (!auth) throw unauthenticated();
  if (auth.role !== 'admin') {
    throw new AppError(403, AUTH_ERROR_CODES.forbidden, 'You do not have permission to do this.');
  }
  next();
};
