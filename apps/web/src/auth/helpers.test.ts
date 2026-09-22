import { describe, expect, it } from 'vitest';
import { describeAuthError, safeRedirect, validateCredentials } from './helpers';

describe('describeAuthError', () => {
  it('maps known Supabase codes to friendly messages', () => {
    expect(describeAuthError({ code: 'invalid_credentials' })).toBe('Incorrect email or password.');
    expect(describeAuthError({ code: 'email_not_confirmed' })).toMatch(/confirm your email/);
    expect(describeAuthError({ code: 'user_already_exists' })).toMatch(/already exists/);
    expect(describeAuthError({ code: 'email_exists' })).toMatch(/already exists/);
    expect(describeAuthError({ code: 'over_request_rate_limit' })).toMatch(/Too many attempts/);
    expect(describeAuthError({ code: 'signup_disabled' })).toMatch(/unavailable/);
  });

  it("shows Supabase's own text for a weak password (the policy is not ours to state)", () => {
    expect(
      describeAuthError({
        code: 'weak_password',
        message: 'Password should be at least 12 characters.',
      }),
    ).toBe('Password should be at least 12 characters.');
    expect(describeAuthError({ code: 'weak_password' })).toMatch(/too weak/);
  });

  it('reports connectivity problems distinctly', () => {
    expect(describeAuthError({ name: 'AuthRetryableFetchError', message: 'x' })).toMatch(
      /Could not reach/,
    );
    expect(describeAuthError({ status: 0, message: 'x' })).toMatch(/Could not reach/);
  });

  it('never leaks unknown provider messages', () => {
    const text = describeAuthError({
      code: 'unexpected_failure',
      message: 'db-host.internal exploded',
    });
    expect(text).toBe('Something went wrong. Please try again.');
  });
});

describe('validateCredentials', () => {
  it('trims and accepts a plausible email with any non-empty password', () => {
    expect(validateCredentials('  a@b.co ', 'x')).toEqual({ ok: true, email: 'a@b.co' });
  });

  it('rejects an empty or malformed email and an empty password', () => {
    for (const email of ['', '   ', 'nope', 'a@b', '@b.co', 'a b@c.co']) {
      expect(validateCredentials(email, 'pw').ok, email).toBe(false);
    }
    expect(validateCredentials('a@b.co', '')).toEqual({
      ok: false,
      message: 'Enter your password.',
    });
  });
});

describe('safeRedirect (open-redirect protection)', () => {
  it('follows in-app paths', () => {
    expect(safeRedirect('/admin')).toBe('/admin');
    expect(safeRedirect('/account?tab=1')).toBe('/account?tab=1');
  });

  it.each([
    '//evil.example',
    'https://evil.example',
    'javascript:alert(1)',
    '/\\evil.example',
    'account',
    '',
    null,
    undefined,
    5,
  ])('falls back for %s', (target) => {
    expect(safeRedirect(target)).toBe('/account');
  });

  it('never redirects back to the login or signup screens', () => {
    expect(safeRedirect('/login')).toBe('/account');
    expect(safeRedirect('/signup')).toBe('/account');
  });
});
