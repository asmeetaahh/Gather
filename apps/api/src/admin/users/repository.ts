import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppRole } from '@gather/shared';

/** One row of the admin user list, or the base of the admin user detail view (PRD §11 ADM-01). */
export interface AdminUserRow {
  id: string;
  /** From Supabase Auth — `profiles` itself never stores email. `null` if the auth account is gone. */
  email: string | null;
  displayName: string | null;
  role: AppRole;
  /** Exactly `is_active_subscriber(uuid)`'s definition (D-070), read via the same set the draw engine uses. */
  hasActiveSubscription: boolean;
  charityName: string | null;
  scoreCount: number;
  createdAt: string;
}

/**
 * Reads and edits admin-facing user information. Deliberately narrow: everything ELSE an admin needs
 * about a user (their scores, subscription, charity preference, winnings) is read through the SAME
 * repositories the user's own pages already use (`ScoreService`, `BillingRepository`,
 * `CharityRepository`, `WinnerRepository`) — composed by `AdminUserService`, not duplicated here.
 */
export interface AdminUserRepository {
  list(): Promise<AdminUserRow[]>;
  findById(id: string): Promise<AdminUserRow | null>;
  /** `null` if no such profile exists. The only profile field an admin may edit directly (D-059: role
   * changes stay a service-role/SQL operation; charity/percentage are the user's own choice). */
  updateDisplayName(id: string, displayName: string): Promise<AdminUserRow | null>;
}

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
function malformed(what: string): never {
  throw new Error(`Malformed ${what} row`);
}
const str = (v: unknown, what: string): string => (typeof v === 'string' ? v : malformed(what));
function role(v: unknown, what: string): AppRole {
  return v === 'user' || v === 'admin' ? v : malformed(what);
}

/**
 * Supabase-js's Auth Admin API pages at up to 1000 users per page; this reads only the first page.
 * At this project's scale (a trainee assignment) that is every user; a genuinely large user base would
 * need real pagination here, which is not built (documented, not silently truncated without saying so).
 */
const MAX_USERS = 1000;

export function createSupabaseAdminUserRepository(client: SupabaseClient): AdminUserRepository {
  async function emailsById(): Promise<Map<string, { email: string | null; createdAt: string }>> {
    const { data, error } = await client.auth.admin.listUsers({ perPage: MAX_USERS });
    if (error) throw new Error(`Auth user list failed: ${error.message}`);
    return new Map(
      data.users.map((u) => [u.id, { email: u.email ?? null, createdAt: u.created_at }]),
    );
  }

  async function activeSubscriberIds(): Promise<Set<string>> {
    // The exact set the draw engine itself reads (migration …150000) — never a second definition of
    // "active subscriber".
    const response = await client.rpc('active_subscriber_ids');
    if (response.error)
      throw new Error(`Active subscriber lookup failed: ${response.error.message}`);
    const data: unknown = response.data; // untyped by supabase-js
    return new Set(
      (data as unknown[]).map((r) => str(isRow(r) ? r.user_id : r, 'active subscriber id')),
    );
  }

  async function scoreCountsById(): Promise<Map<string, number>> {
    const { data, error } = await client.from('scores').select('user_id');
    if (error) throw new Error(`Score count lookup failed: ${error.message}`);
    const counts = new Map<string, number>();
    for (const raw of data as unknown[]) {
      if (!isRow(raw)) malformed('score');
      const userId = str(raw.user_id, 'score');
      counts.set(userId, (counts.get(userId) ?? 0) + 1);
    }
    return counts;
  }

  function toRow(
    profile: Row,
    email: { email: string | null; createdAt: string } | undefined,
    active: Set<string>,
    scoreCounts: Map<string, number>,
  ): AdminUserRow {
    const id = str(profile.id, 'profile');
    const charity = profile.charities;
    return {
      id,
      email: email?.email ?? null,
      displayName: profile.display_name === null ? null : str(profile.display_name, 'profile'),
      role: role(profile.role, 'profile'),
      hasActiveSubscription: active.has(id),
      charityName: isRow(charity) ? str(charity.name, 'profile') : null,
      scoreCount: scoreCounts.get(id) ?? 0,
      // Auth is the source of truth for "when this account was created"; a profile without a matching
      // auth user (should not happen) falls back to something rather than throwing on a list read.
      createdAt: email?.createdAt ?? new Date(0).toISOString(),
    };
  }

  return {
    async list() {
      const [{ data, error }, emails, active, scoreCounts] = await Promise.all([
        client
          .from('profiles')
          .select('id, display_name, role, charities!selected_charity_id(name)'),
        emailsById(),
        activeSubscriberIds(),
        scoreCountsById(),
      ]);
      if (error) throw new Error(`User list failed: ${error.message}`);
      return (data as unknown[])
        .map((raw) => {
          if (!isRow(raw)) return malformed('profile');
          return toRow(raw, emails.get(str(raw.id, 'profile')), active, scoreCounts);
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async findById(id) {
      const [{ data, error }, authUser, active, scoreCounts] = await Promise.all([
        client
          .from('profiles')
          .select('id, display_name, role, charities!selected_charity_id(name)')
          .eq('id', id)
          .maybeSingle(),
        client.auth.admin.getUserById(id),
        activeSubscriberIds(),
        scoreCountsById(),
      ]);
      if (error) throw new Error(`User lookup failed: ${error.message}`);
      if (data === null) return null;
      if (!isRow(data)) return malformed('profile');
      const email = authUser.data.user
        ? { email: authUser.data.user.email ?? null, createdAt: authUser.data.user.created_at }
        : undefined;
      return toRow(data, email, active, scoreCounts);
    },

    async updateDisplayName(id, displayName) {
      const { data, error } = await client
        .from('profiles')
        .update({ display_name: displayName })
        .eq('id', id)
        .select('id, display_name, role, charities!selected_charity_id(name)')
        .maybeSingle();
      if (error) throw new Error(`User update failed: ${error.message}`);
      if (data === null) return null;
      if (!isRow(data)) return malformed('profile');
      const authUser = await client.auth.admin.getUserById(id);
      const email = authUser.data.user
        ? { email: authUser.data.user.email ?? null, createdAt: authUser.data.user.created_at }
        : undefined;
      const [active, scoreCounts] = await Promise.all([activeSubscriberIds(), scoreCountsById()]);
      return toRow(data, email, active, scoreCounts);
    },
  };
}
