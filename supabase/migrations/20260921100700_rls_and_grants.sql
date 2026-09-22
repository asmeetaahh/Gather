-- =============================================================================
-- GATHER — 008: privileges and Row Level Security
--
-- SECURITY MODEL
--   Two independent layers protect every table:
--     1. Table/column PRIVILEGES (GRANT) — what a role may attempt at all.
--     2. Row Level Security POLICIES     — which rows it may see or touch.
--
--   Roles:
--     anon           public visitor (no session)
--     authenticated  a signed-in account (regular user OR admin — distinguished by
--                    public.is_admin(), never by a client-supplied claim)
--     service_role   the API server. BYPASSES RLS. Its key must never reach the browser.
--
--   Principle: the browser roles can READ their own data (plus genuinely public data) and
--   edit a few profile fields. EVERY other write — scores, subscriptions, payments, draws,
--   winners, proof metadata, charities, settings — goes through the API using the service
--   role, which authenticates the caller, applies business rules and writes the audit log.
--   Direct writes from anon/authenticated are therefore not granted at all, so a missing or
--   buggy policy can never turn into a data-tampering hole.
--
--   Deny by default: RLS is enabled on every table (in the migration that creates it). A
--   table with no policy for a role is invisible to that role.
-- =============================================================================

-- ---- Helper for policies --------------------------------------------------------------------
-- True when the draw is published. SECURITY DEFINER so draw_entries policies can check the
-- draw without evaluating the draws policies, which themselves look at draw_entries (that
-- would recurse infinitely).
create function public.draw_is_published(p_draw_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.draws d where d.id = p_draw_id and d.status = 'published'
  );
$$;

revoke all on function public.draw_is_published(uuid) from public;
grant execute on function public.draw_is_published(uuid) to authenticated, service_role;

-- ---- Privileges -----------------------------------------------------------------------------
-- Start from nothing for the browser-facing roles, then grant the minimum.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant usage on schema public to anon, authenticated, service_role;

-- The API role: full access (it bypasses RLS). Immutability guards still apply to it.
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Public reference/content data (visitors "explore listed charities" and "understand draw
-- mechanics", PRD §03).
grant select on public.charities, public.charity_images, public.charity_events,
  public.plans, public.prize_tiers to anon, authenticated;

-- Private data readable by the signed-in user (rows limited by policy below).
grant select on public.profiles, public.subscriptions, public.payments,
  public.charity_contributions, public.scores, public.draws, public.draw_entries,
  public.draw_tier_results, public.winners, public.winner_proofs,
  public.platform_settings, public.admin_audit_log to authenticated;

-- The ONLY direct write: a user editing their own profile preferences. `role` (and every
-- other column) is deliberately absent, so a user can never promote themselves to admin.
grant update (display_name, selected_charity_id, charity_bps) on public.profiles to authenticated;

-- billing_customers and stripe_events: no grants for anon/authenticated = service role only.

-- ---- Policies: profiles ---------------------------------------------------------------------
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy profiles_select_admin on public.profiles
  for select to authenticated
  using ((select public.is_admin()));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ---- Policies: public charity directory -----------------------------------------------------
-- Archived charities are hidden from the public; admins can still see them.
create policy charities_select_public on public.charities
  for select to anon, authenticated
  using (archived_at is null);

create policy charities_select_admin on public.charities
  for select to authenticated
  using ((select public.is_admin()));

create policy charity_images_select_public on public.charity_images
  for select to anon, authenticated
  using (exists (
    select 1 from public.charities c
    where c.id = charity_images.charity_id and c.archived_at is null
  ));

create policy charity_images_select_admin on public.charity_images
  for select to authenticated
  using ((select public.is_admin()));

create policy charity_events_select_public on public.charity_events
  for select to anon, authenticated
  using (exists (
    select 1 from public.charities c
    where c.id = charity_events.charity_id and c.archived_at is null
  ));

create policy charity_events_select_admin on public.charity_events
  for select to authenticated
  using ((select public.is_admin()));

-- ---- Policies: plans and prize tiers --------------------------------------------------------
-- Visitors can "initiate subscription", so active plans are public. Retired plans are not.
create policy plans_select_active on public.plans
  for select to anon, authenticated
  using (is_active);

create policy plans_select_admin on public.plans
  for select to authenticated
  using ((select public.is_admin()));

-- The prize split is public draw mechanics (PRD §03, §07).
create policy prize_tiers_select_public on public.prize_tiers
  for select to anon, authenticated
  using (true);

-- ---- Policies: configuration and audit (admin only) -----------------------------------------
create policy platform_settings_select_admin on public.platform_settings
  for select to authenticated
  using ((select public.is_admin()));

create policy admin_audit_log_select_admin on public.admin_audit_log
  for select to authenticated
  using ((select public.is_admin()));

-- ---- Policies: a user's own billing and score data ------------------------------------------
-- Read-only for users. A lapsed user can still read their own history.
create policy subscriptions_select_own on public.subscriptions
  for select to authenticated using (user_id = (select auth.uid()));
create policy subscriptions_select_admin on public.subscriptions
  for select to authenticated using ((select public.is_admin()));

create policy payments_select_own on public.payments
  for select to authenticated using (user_id = (select auth.uid()));
create policy payments_select_admin on public.payments
  for select to authenticated using ((select public.is_admin()));

create policy charity_contributions_select_own on public.charity_contributions
  for select to authenticated using (user_id = (select auth.uid()));
create policy charity_contributions_select_admin on public.charity_contributions
  for select to authenticated using ((select public.is_admin()));

create policy scores_select_own on public.scores
  for select to authenticated using (user_id = (select auth.uid()));
create policy scores_select_admin on public.scores
  for select to authenticated using ((select public.is_admin()));

-- ---- Policies: draws ------------------------------------------------------------------------
-- Draft and simulated draws (including candidate results) are admin-only.
-- Published draws are visible to active subscribers and to anyone who was entered in that
-- draw (so a since-lapsed user can still see a result they took part in).
-- RESTRICTIVE DEFAULT pending D-030: the PRD says non-subscribers get "restricted access" but
-- not what is restricted. Relax by editing this one policy.
create policy draws_select_published on public.draws
  for select to authenticated
  using (
    status = 'published'
    and (
      (select public.is_active_subscriber((select auth.uid())))
      or exists (
        select 1 from public.draw_entries e
        where e.draw_id = draws.id and e.user_id = (select auth.uid())
      )
    )
  );

create policy draws_select_admin on public.draws
  for select to authenticated using ((select public.is_admin()));

-- A user sees only their own entry, and only once the draw is published (candidate match
-- counts from a simulation must never leak).
create policy draw_entries_select_own_published on public.draw_entries
  for select to authenticated
  using (user_id = (select auth.uid()) and public.draw_is_published(draw_id));

create policy draw_entries_select_admin on public.draw_entries
  for select to authenticated using ((select public.is_admin()));

-- Tier results are visible exactly when the parent draw is visible to the caller (the
-- subquery is itself subject to the draws policies above).
create policy draw_tier_results_select_visible_draw on public.draw_tier_results
  for select to authenticated
  using (exists (select 1 from public.draws d where d.id = draw_tier_results.draw_id));

create policy draw_tier_results_select_admin on public.draw_tier_results
  for select to authenticated using ((select public.is_admin()));

-- ---- Policies: winners and proof ------------------------------------------------------------
create policy winners_select_own on public.winners
  for select to authenticated using (user_id = (select auth.uid()));
create policy winners_select_admin on public.winners
  for select to authenticated using ((select public.is_admin()));

create policy winner_proofs_select_own on public.winner_proofs
  for select to authenticated
  using (exists (
    select 1 from public.winners w
    where w.id = winner_proofs.winner_id and w.user_id = (select auth.uid())
  ));
create policy winner_proofs_select_admin on public.winner_proofs
  for select to authenticated using ((select public.is_admin()));
