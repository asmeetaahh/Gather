import { errors } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { ALICE, TEST_ISSUER, createTestAuth, type TestAuth } from '../test-support/auth.js';
import {
  InvalidTokenError,
  createJwtVerifier,
  supabaseIssuer,
  supabaseJwksUrl,
} from './verifier.js';

let auth: TestAuth;

beforeAll(async () => {
  auth = await createTestAuth();
});

const rejected = (token: string) =>
  expect(auth.verifier(token)).rejects.toBeInstanceOf(InvalidTokenError);

describe('accepts a genuine signed-in user token', () => {
  it('returns the user id and email from a correctly signed, unexpired token', async () => {
    const token = await auth.signToken(ALICE, { email: 'alice@example.test' });
    await expect(auth.verifier(token)).resolves.toEqual({
      userId: ALICE,
      email: 'alice@example.test',
    });
  });

  it('returns a null email when the token carries none', async () => {
    const token = await auth.signToken(ALICE, { email: undefined });
    await expect(auth.verifier(token)).resolves.toEqual({ userId: ALICE, email: null });
  });
});

describe('rejects tokens that are not trustworthy (401 territory)', () => {
  it('rejects garbage and empty strings', async () => {
    for (const token of ['', 'not-a-jwt', 'a.b.c', 'eyJhbGciOiJFUzI1NiJ9.e30.'])
      await rejected(token);
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    await rejected(await auth.signToken(ALICE, {}, { expiresAt: past }));
  });

  it('rejects a token issued by a different issuer or for a different audience', async () => {
    await rejected(await auth.signToken(ALICE, {}, { issuer: 'https://evil.example/auth/v1' }));
    await rejected(await auth.signToken(ALICE, {}, { audience: 'someone-else' }));
  });

  it('rejects a token signed by a key the project does not publish', async () => {
    await rejected(await auth.signWithUntrustedKey(ALICE));
  });

  it('rejects an unsigned token (alg: none)', async () => {
    await rejected(auth.unsignedToken(ALICE));
  });

  it('rejects an HS256 token forged with the public key as the secret (algorithm confusion)', async () => {
    await rejected(await auth.hmacConfusionToken(ALICE));
  });

  it('rejects a token with a tampered payload', async () => {
    const token = await auth.signToken(ALICE);
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({
        sub: ALICE,
        role: 'authenticated',
        iss: TEST_ISSUER,
        aud: 'authenticated',
        exp: 9_999_999_999,
      }),
    ).toString('base64url');
    await rejected(`${header ?? ''}.${forgedPayload}.${signature ?? ''}`);
  });
});

describe('rejects validly signed tokens that are not a signed-in account', () => {
  it('rejects a token with no subject, or a subject that is not a UUID', async () => {
    await rejected(await auth.signToken(ALICE, {}, { omitSubject: true }));
    await rejected(await auth.signToken('not-a-uuid'));
  });

  it("rejects Supabase's anon and service-role API keys presented as bearer tokens", async () => {
    // Neither key belongs to a user; the service-role key in particular must never authenticate a caller.
    await rejected(await auth.signToken(ALICE, { role: 'anon' }));
    await rejected(await auth.signToken(ALICE, { role: 'service_role' }));
  });

  it('rejects a token whose top-level role claims to be admin (roles come from the database)', async () => {
    await rejected(await auth.signToken(ALICE, { role: 'admin' }));
  });

  it('rejects anonymous sessions: they are not registered accounts', async () => {
    await rejected(await auth.signToken(ALICE, { is_anonymous: true }));
  });
});

describe('separates "bad token" from "cannot verify right now"', () => {
  const keyLookup = (error: Error) =>
    createJwtVerifier({ getKey: () => Promise.reject(error), issuer: TEST_ISSUER });

  it('propagates an unreachable key set as an infrastructure error, not as an invalid token', async () => {
    const verifier = keyLookup(new TypeError('fetch failed'));
    const token = await auth.signToken(ALICE);
    const error = await verifier(token).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(InvalidTokenError);
  });

  it('treats a key-set timeout as infrastructure too', async () => {
    const verifier = keyLookup(new errors.JWKSTimeout());
    const error = await verifier(await auth.signToken(ALICE)).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(InvalidTokenError);
  });
});

describe('Supabase endpoints are derived from the project URL', () => {
  it('uses the standard JWKS location and issuer', () => {
    expect(supabaseJwksUrl('https://abc.supabase.co').href).toBe(
      'https://abc.supabase.co/auth/v1/.well-known/jwks.json',
    );
    expect(supabaseIssuer('https://abc.supabase.co')).toBe('https://abc.supabase.co/auth/v1');
    expect(supabaseIssuer('http://127.0.0.1:54321')).toBe('http://127.0.0.1:54321/auth/v1');
  });
});
