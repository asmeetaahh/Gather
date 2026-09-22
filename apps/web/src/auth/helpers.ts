/** Pure helpers for the auth screens. Kept free of React and Supabase so they are trivial to test. */

/** Minimal shape of a Supabase auth error (`AuthError`); only what we read. */
export interface AuthErrorLike {
  message?: string;
  code?: string | undefined;
  status?: number | undefined;
  name?: string;
}

/**
 * Turns a Supabase auth error into a message that is safe and useful to show. Unknown errors get a
 * generic message so provider internals are never displayed. Login failures deliberately do not say
 * whether the email or the password was wrong.
 */
export function describeAuthError(error: AuthErrorLike): string {
  switch (error.code) {
    case 'invalid_credentials':
      return 'Incorrect email or password.';
    case 'email_not_confirmed':
      return 'Please confirm your email address before signing in.';
    case 'user_already_exists':
    case 'email_exists':
      return 'An account with this email already exists. Try signing in instead.';
    case 'weak_password':
      // Supabase's message states the project's actual password rules, which we do not decide.
      return error.message || 'That password is too weak. Please choose a stronger one.';
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return 'Too many attempts. Please wait a moment and try again.';
    case 'signup_disabled':
    case 'email_provider_disabled':
      return 'Sign-ups are currently unavailable.';
    case 'email_address_invalid':
    case 'validation_failed':
      return 'Please enter a valid email address.';
  }
  if (error.name === 'AuthRetryableFetchError' || error.status === 0) {
    return 'Could not reach the sign-in service. Check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

export type CredentialsCheck = { ok: true; email: string } | { ok: false; message: string };

/**
 * Cheap client-side checks so obviously empty submissions never leave the browser. Password STRENGTH is
 * not judged here: the project's policy is a Supabase setting and an open decision (D-028).
 */
export function validateCredentials(email: string, password: string): CredentialsCheck {
  const trimmed = email.trim();
  if (trimmed === '') return { ok: false, message: 'Enter your email address.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { ok: false, message: 'Enter a valid email address.' };
  }
  if (password === '') return { ok: false, message: 'Enter your password.' };
  return { ok: true, email: trimmed };
}

/**
 * Only follow a post-login redirect to a path inside this app. Rejects absolute URLs and
 * protocol-relative ones (`//evil.example`), which would be an open-redirect hole.
 */
export function safeRedirect(target: unknown, fallback = '/account'): string {
  if (typeof target !== 'string') return fallback;
  if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\')) return fallback;
  if (target === '/login' || target === '/signup') return fallback;
  return target;
}
