-- =============================================================================
-- GATHER — 011: browser roles must not be able to look up ANOTHER user's subscription
--
-- PROBLEM (found in the Phase 1 checkpoint review). is_active_subscriber(p_user_id uuid) is
-- SECURITY DEFINER, so it reads `subscriptions` without RLS, and it was executable by
-- `authenticated`. PostgREST exposes executable public functions as /rpc/*, so any signed-in
-- user could call it with someone else's id and learn whether that person subscribes — while
-- RLS correctly hid the subscription row itself. That bypasses the user-isolation guarantee.
--
-- FIX.
--   * is_active_subscriber(uuid) — the single entitlement DEFINITION — becomes callable only by
--     the API (service_role), which legitimately needs to check any user.
--   * current_user_is_active_subscriber() — a no-argument wrapper that can only ever answer for
--     the caller (auth.uid()) — is what browser roles and RLS policies use. It delegates to
--     is_active_subscriber(uuid), so there is still ONE definition to change if D-026/D-030
--     alter the rule. It is SECURITY DEFINER, so it can call the restricted function.
--   * The one RLS policy that used the uuid version is recreated to use the wrapper.
--
-- draw_is_published(uuid) is intentionally left as is: it discloses only whether a draw id is
-- published (no user data), and draw ids are not guessable.
-- =============================================================================

create function public.current_user_is_active_subscriber()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_active_subscriber((select auth.uid()));
$$;

revoke all on function public.current_user_is_active_subscriber() from public;
grant execute on function public.current_user_is_active_subscriber() to authenticated, service_role;

revoke execute on function public.is_active_subscriber(uuid) from authenticated;

-- Same policy as before (see the RLS migration), now using the caller-only wrapper.
drop policy draws_select_published on public.draws;

create policy draws_select_published on public.draws
  for select to authenticated
  using (
    status = 'published'
    and (
      (select public.current_user_is_active_subscriber())
      or exists (
        select 1 from public.draw_entries e
        where e.draw_id = draws.id and e.user_id = (select auth.uid())
      )
    )
  );
