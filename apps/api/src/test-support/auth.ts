import {
  SignJWT,
  UnsecuredJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
} from 'jose';
import type { AppRole } from '@gather/shared';
import { createJwtVerifier, type TokenVerifier } from '../auth/verifier.js';
import type { AuthProfile, ProfileRepository } from '../auth/profiles.js';
import type { AuthDeps } from '../auth/middleware.js';

/**
 * Test-only helpers. They do REAL cryptography — a freshly generated ES256 key pair, a real JWKS and
 * properly signed tokens — and run them through the production `createJwtVerifier`. Only the source of
 * the public keys differs from production (a local set instead of Supabase's remote one).
 */

export const TEST_ISSUER = 'https://test-project.supabase.co/auth/v1';
export const TEST_KID = 'test-signing-key';

/** Profile store standing in for `public.profiles`. Its behaviour is covered by the database tests. */
export class InMemoryProfiles implements ProfileRepository {
  private readonly rows = new Map<string, AuthProfile>();
  /** When set, every lookup fails — simulates the database being unreachable. */
  failWith: Error | null = null;

  add(id: string, role: AppRole = 'user', displayName: string | null = null): void {
    this.rows.set(id, { id, role, displayName });
  }

  setRole(id: string, role: AppRole): void {
    const row = this.rows.get(id);
    if (!row) throw new Error(`No such profile ${id}`);
    this.rows.set(id, { ...row, role });
  }

  remove(id: string): void {
    this.rows.delete(id);
  }

  findById(userId: string): Promise<AuthProfile | null> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.rows.get(userId) ?? null);
  }
}

export interface TestAuth {
  deps: AuthDeps;
  verifier: TokenVerifier;
  profiles: InMemoryProfiles;
  /** The public key set, as Supabase would publish it. */
  publicJwk: JWK;
  /** Signs a token as the trusted key, with sensible defaults that tests can override. */
  signToken(userId: string, claims?: JWTPayload, options?: SignOptions): Promise<string>;
  /** Signs with a DIFFERENT key that the verifier does not trust. */
  signWithUntrustedKey(userId: string): Promise<string>;
  /** A well-formed token with `alg: none` (no signature). */
  unsignedToken(userId: string): string;
  /** An HS256 token "signed" with the public key as a shared secret (algorithm-confusion attack). */
  hmacConfusionToken(userId: string): Promise<string>;
}

export interface SignOptions {
  issuer?: string;
  audience?: string;
  /** Anything `setExpirationTime` accepts, e.g. '1h' or a past unix timestamp. */
  expiresAt?: string | number;
  /** Omit the subject claim entirely. */
  omitSubject?: boolean;
}

export async function createTestAuth(): Promise<TestAuth> {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const publicJwk: JWK = {
    ...(await exportJWK(publicKey)),
    kid: TEST_KID,
    alg: 'ES256',
    use: 'sig',
  };
  const verifier = createJwtVerifier({
    getKey: createLocalJWKSet({ keys: [publicJwk] }),
    issuer: TEST_ISSUER,
  });
  const profiles = new InMemoryProfiles();

  const baseClaims = (email: string): JWTPayload => ({ role: 'authenticated', email });

  return {
    deps: { verifier, profiles },
    verifier,
    profiles,
    publicJwk,

    async signToken(userId, claims = {}, options = {}) {
      const jwt = new SignJWT({ ...baseClaims(`${userId.slice(0, 8)}@example.test`), ...claims })
        .setProtectedHeader({ alg: 'ES256', kid: TEST_KID })
        .setIssuer(options.issuer ?? TEST_ISSUER)
        .setAudience(options.audience ?? 'authenticated')
        .setIssuedAt()
        .setExpirationTime(options.expiresAt ?? '1h');
      if (!options.omitSubject) jwt.setSubject(userId);
      return jwt.sign(privateKey);
    },

    async signWithUntrustedKey(userId) {
      const other = await generateKeyPair('ES256');
      return new SignJWT(baseClaims('x@example.test'))
        .setProtectedHeader({ alg: 'ES256', kid: TEST_KID })
        .setIssuer(TEST_ISSUER)
        .setAudience('authenticated')
        .setSubject(userId)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(other.privateKey);
    },

    unsignedToken(userId) {
      return new UnsecuredJWT({ ...baseClaims('x@example.test') })
        .setIssuer(TEST_ISSUER)
        .setAudience('authenticated')
        .setSubject(userId)
        .setExpirationTime('1h')
        .encode();
    },

    hmacConfusionToken(userId) {
      // The attacker only knows the PUBLIC key; they use it as an HMAC secret.
      return new SignJWT(baseClaims('x@example.test'))
        .setProtectedHeader({ alg: 'HS256', kid: TEST_KID })
        .setIssuer(TEST_ISSUER)
        .setAudience('authenticated')
        .setSubject(userId)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(JSON.stringify(publicJwk)));
    },
  };
}

/** Stable UUIDs for readable tests. */
export const ALICE = '11111111-1111-4111-8111-111111111111';
export const BOB = '22222222-2222-4222-8222-222222222222';
export const ADMIN = '99999999-9999-4999-8999-999999999999';
