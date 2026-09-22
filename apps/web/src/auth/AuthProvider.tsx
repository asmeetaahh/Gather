import { SIGNUP_CHARITY_METADATA_KEY } from '@gather/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiRequestError, fetchMe } from '../api/client';
import { AuthContext } from './context';
import { describeAuthError } from './helpers';
import type { AuthActionResult, AuthClient, AuthContextValue, AuthState } from './types';

/** Turn a session's access token into an authenticated state by asking the API who this is. */
async function loadIdentity(accessToken: string): Promise<AuthState | 'session-rejected'> {
  try {
    const { user } = await fetchMe(accessToken);
    return { status: 'authenticated', user };
  } catch (error) {
    if (error instanceof ApiRequestError) {
      if (error.status === 401) return 'session-rejected';
      if (error.status === 403) {
        return {
          status: 'error',
          message: 'Your account is not fully set up yet. Please contact support.',
        };
      }
    }
    return { status: 'error', message: 'Could not reach the server. Please try again.' };
  }
}

/**
 * Owns the sign-in state for the whole app.
 *
 * - SESSION RESTORATION: supabase-js persists the session and, once we subscribe, emits
 *   `INITIAL_SESSION` with whatever it restored (refreshing an expired access token first).
 * - The user's ROLE is never read from the session. After a session appears we ask the API
 *   (`GET /api/me`), which verifies the token server-side and reads `profiles.role` from the database.
 *   Everything the UI shows about "who you are" comes from that response.
 * - If the API rejects the token (401) the local session is discarded.
 */
export function AuthProvider({
  client,
  children,
}: {
  client: AuthClient | null;
  children: ReactNode;
}) {
  const [state, setState] = useState<AuthState>(
    client ? { status: 'loading' } : { status: 'unconfigured' },
  );
  // Ignore results of superseded lookups (e.g. sign-in then quick sign-out).
  const latest = useRef(0);

  useEffect(() => {
    if (!client) return;

    const { data } = client.auth.onAuthStateChange((event, session) => {
      const ticket = ++latest.current;

      if (!session) {
        setState({ status: 'unauthenticated' });
        return;
      }
      // A refreshed token does not change who the user is or their role.
      if (event === 'TOKEN_REFRESHED') return;

      // Avoid flashing "loading" when re-confirming an already signed-in user.
      setState((prev) => (prev.status === 'authenticated' ? prev : { status: 'loading' }));

      void loadIdentity(session.access_token).then((result) => {
        if (ticket !== latest.current) return;
        if (result === 'session-rejected') {
          setState({ status: 'unauthenticated' });
          // Not inside the auth callback: supabase-js can deadlock if it is re-entered from there.
          setTimeout(() => void client.auth.signOut({ scope: 'local' }), 0);
          return;
        }
        setState(result);
      });
    });

    return () => {
      data.subscription.unsubscribe();
    };
  }, [client]);

  const signIn = useCallback(
    async (email: string, password: string): Promise<AuthActionResult> => {
      if (!client) return { ok: false, message: 'Sign-in is not available right now.' };
      try {
        const { error } = await client.auth.signInWithPassword({ email, password });
        return error ? { ok: false, message: describeAuthError(error) } : { ok: true };
      } catch {
        return { ok: false, message: describeAuthError({ status: 0 }) };
      }
    },
    [client],
  );

  const signUp = useCallback(
    async (
      email: string,
      password: string,
      options?: { charityId?: string },
    ): Promise<AuthActionResult> => {
      if (!client) return { ok: false, message: 'Sign-up is not available right now.' };
      try {
        // The chosen charity rides in the signup data, so it is recorded even when the project requires
        // email confirmation (there is no session yet). The database validates it (CHR-01, D-065).
        const { data, error } = await client.auth.signUp({
          email,
          password,
          ...(options?.charityId && {
            options: { data: { [SIGNUP_CHARITY_METADATA_KEY]: options.charityId } },
          }),
        });
        if (error) return { ok: false, message: describeAuthError(error) };
        // Whether a session is returned depends on the project's "confirm email" setting, which is an
        // open decision (D-028): handle both rather than assume either.
        return { ok: true, needsEmailConfirmation: data.session === null };
      } catch {
        return { ok: false, message: describeAuthError({ status: 0 }) };
      }
    },
    [client],
  );

  const signOut = useCallback(async () => {
    if (!client) return;
    latest.current += 1;
    // Local scope ends only THIS browser's session (and revokes its refresh token).
    await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
    setState({ status: 'unauthenticated' });
  }, [client]);

  const getAccessToken = useCallback(async () => {
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session?.access_token ?? null;
  }, [client]);

  const getStorage = useCallback(() => client?.storage ?? null, [client]);

  const value = useMemo<AuthContextValue>(
    () => ({ state, signIn, signUp, signOut, getAccessToken, getStorage }),
    [state, signIn, signUp, signOut, getAccessToken, getStorage],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
