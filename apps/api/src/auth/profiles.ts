import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { APP_ROLES, type AppRole } from '@gather/shared';
import type { SupabaseConfig } from '../config.js';

/** The application profile (`public.profiles`) of a signed-in account. */
export interface AuthProfile {
  id: string;
  /** THE source of truth for authorization: `profiles.role`, read from the database. */
  role: AppRole;
  displayName: string | null;
}

export interface ProfileRepository {
  /** The profile for an auth user id, or `null` if there is none. Throws if the lookup itself fails. */
  findById(userId: string): Promise<AuthProfile | null>;
}

function isAppRole(value: unknown): value is AppRole {
  return typeof value === 'string' && (APP_ROLES as readonly string[]).includes(value);
}

/**
 * Validates a `profiles` row at the trust boundary. An unrecognised role is an error, never a
 * default: authorization must fail closed rather than guess what an unknown value means.
 */
export function parseProfileRow(row: unknown): AuthProfile {
  if (typeof row !== 'object' || row === null) throw new Error('Malformed profile row');
  const { id, role, display_name: displayName } = row as Record<string, unknown>;
  if (typeof id !== 'string') throw new Error('Malformed profile row: id');
  if (!isAppRole(role)) throw new Error('Malformed profile row: unrecognised role');
  return { id, role, displayName: typeof displayName === 'string' ? displayName : null };
}

/**
 * Server-side Supabase client using the SERVICE-ROLE key, which bypasses RLS. It must only ever be
 * created and used inside the api app (DECISIONS D-004); every query made with it must therefore be
 * scoped by an identity the API has already verified.
 */
export function createServiceClient(config: SupabaseConfig) {
  return createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Reads profiles through the service role. The id always comes from a verified token, never a request. */
export function createSupabaseProfileRepository(client: SupabaseClient): ProfileRepository {
  return {
    async findById(userId) {
      const { data, error } = await client
        .from('profiles')
        .select('id, role, display_name')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw new Error(`Profile lookup failed: ${error.message}`);
      return data === null ? null : parseProfileRow(data);
    },
  };
}
