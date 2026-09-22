import type { SupabaseClient } from '@supabase/supabase-js';
import type { MeResponse } from '@gather/shared';

/** The slice of the Supabase client the app uses. A real `SupabaseClient` satisfies it; tests supply a fake. */
export interface AuthClient {
  auth: Pick<
    SupabaseClient['auth'],
    'onAuthStateChange' | 'getSession' | 'signUp' | 'signInWithPassword' | 'signOut'
  >;
}

/** The signed-in user as verified by the API (role from the database, not from the token). */
export type AuthUser = MeResponse['user'];

export type AuthState =
  /** Waiting for Supabase to report the stored session, or for the API to confirm the profile. */
  | { status: 'loading' }
  /** Supabase is not configured for this build. */
  | { status: 'unconfigured' }
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; user: AuthUser }
  /** Signed in, but the profile could not be confirmed (API down, or the account has no profile). */
  | { status: 'error'; message: string };

export type AuthActionResult =
  { ok: true; needsEmailConfirmation?: boolean } | { ok: false; message: string };

export interface AuthContextValue {
  state: AuthState;
  signIn: (email: string, password: string) => Promise<AuthActionResult>;
  /** `charityId` is the charity chosen on the signup form (CHR-01); it travels in the signup data. */
  signUp: (
    email: string,
    password: string,
    options?: { charityId?: string },
  ) => Promise<AuthActionResult>;
  signOut: () => Promise<void>;
  /** A fresh access token for API calls (supabase-js refreshes it when needed), or null if signed out. */
  getAccessToken: () => Promise<string | null>;
}
