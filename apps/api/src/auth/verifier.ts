import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

/** Who a verified access token belongs to. Says nothing about roles — see the profile lookup. */
export interface VerifiedIdentity {
  userId: string;
  /** Taken from the token for display only; never used for authorization. */
  email: string | null;
}

/** Verifies an access token, or throws `InvalidTokenError`. Any other error means "cannot verify now". */
export type TokenVerifier = (token: string) => Promise<VerifiedIdentity>;

/** The token is malformed, expired, untrusted or not a signed-in user's token (client's fault → 401). */
export class InvalidTokenError extends Error {}

/**
 * Only asymmetric algorithms are accepted (Supabase "JWT signing keys"). Restricting the list is what
 * prevents algorithm-confusion attacks (e.g. an HS256 token "signed" with the public key) and the
 * `alg: none` attack. Projects still on the legacy shared-secret HS256 scheme must migrate to signing
 * keys (docs/DECISIONS.md D-057).
 */
const ALLOWED_ALGORITHMS = ['ES256', 'RS256'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** jose errors that mean "this token is bad". Everything else (network, JWKS timeout) is infrastructure. */
function isBadTokenError(error: unknown): boolean {
  return (
    error instanceof joseErrors.JWTExpired ||
    error instanceof joseErrors.JWTInvalid ||
    error instanceof joseErrors.JWTClaimValidationFailed ||
    error instanceof joseErrors.JWSInvalid ||
    error instanceof joseErrors.JWSSignatureVerificationFailed ||
    error instanceof joseErrors.JOSEAlgNotAllowed ||
    error instanceof joseErrors.JOSENotSupported ||
    error instanceof joseErrors.JWKSNoMatchingKey ||
    error instanceof joseErrors.JWKSMultipleMatchingKeys
  );
}

/**
 * Builds a verifier from a key resolver, so tests can supply a local key set and production supplies
 * Supabase's remote one — the verification logic itself is identical and is what the tests exercise.
 *
 * Checks: signature (asymmetric only), `iss`, `aud`, expiry, then that the token belongs to a real,
 * signed-in user: it must carry a UUID `sub`, `role === 'authenticated'` and not be an anonymous
 * session. This rejects Supabase's anon and service-role API keys if they are presented as bearers.
 */
export function createJwtVerifier(options: {
  getKey: JWTVerifyGetKey;
  issuer: string;
  audience?: string;
}): TokenVerifier {
  const { getKey, issuer, audience = 'authenticated' } = options;

  return async (token) => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, getKey, {
        issuer,
        audience,
        algorithms: ALLOWED_ALGORITHMS,
        clockTolerance: 5,
      }));
    } catch (error) {
      if (isBadTokenError(error)) throw new InvalidTokenError('Token rejected', { cause: error });
      throw error;
    }

    const { sub, role, email, is_anonymous: isAnonymous } = payload as Record<string, unknown>;
    if (typeof sub !== 'string' || !UUID.test(sub)) throw new InvalidTokenError('Missing user id');
    if (role !== 'authenticated') throw new InvalidTokenError('Not a signed-in user token');
    if (isAnonymous === true) throw new InvalidTokenError('Anonymous sessions are not accounts');

    return { userId: sub.toLowerCase(), email: typeof email === 'string' ? email : null };
  };
}

/** Where Supabase Auth publishes the public keys it signs tokens with. */
export function supabaseJwksUrl(supabaseUrl: string): URL {
  return new URL('/auth/v1/.well-known/jwks.json', supabaseUrl);
}

/** The `iss` claim Supabase Auth puts in every access token. */
export function supabaseIssuer(supabaseUrl: string): string {
  return new URL('/auth/v1', supabaseUrl).href;
}

/** Production verifier: trusts exactly the keys published by this project's Supabase Auth. */
export function createSupabaseTokenVerifier(supabaseUrl: string): TokenVerifier {
  return createJwtVerifier({
    getKey: createRemoteJWKSet(supabaseJwksUrl(supabaseUrl)),
    issuer: supabaseIssuer(supabaseUrl),
  });
}
