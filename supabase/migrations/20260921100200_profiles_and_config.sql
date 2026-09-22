-- =============================================================================
-- GATHER — 003: profiles, admin role, platform settings, prize tiers
--
-- Authentication itself (signup/login) is NOT implemented in Phase 1. Supabase Auth owns
-- `auth.users`; this migration only defines the application profile that hangs off it.
-- =============================================================================

-- ---- profiles ----------------------------------------------------------------------------
-- One row per registered account (PRD §03: "Manage profile & settings").
create table public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  -- SECURITY: the admin role lives here, in the database, where API-role users cannot edit
  -- it (no UPDATE privilege on this column — see the RLS migration). It is never read from
  -- client-controllable JWT/user metadata. Admins are promoted only by a service-role/SQL
  -- operation.
  role                public.app_role not null default 'user',
  display_name        text
                        constraint profiles_display_name_length
                        check (display_name is null or char_length(btrim(display_name)) between 1 and 100),
  -- PRD §08: "Users select a charity at signup". Nullable because the profile row is created
  -- by the auth trigger before the user has chosen; requiring a charity before a subscription
  -- becomes active is application logic. ON DELETE SET NULL: removing a charity never
  -- deletes a user; contribution history is preserved separately.
  selected_charity_id uuid references public.charities (id) on delete set null,
  -- PRD §08: "Minimum contribution: 10% of subscription fee"; users "may voluntarily
  -- increase". 1000 bps = 10%. The upper bound (10000 = 100%) is only the logical limit;
  -- any tighter product cap is configuration (platform_settings.charity_max_bps, D-025).
  charity_bps         public.basis_points not null default 1000
                        constraint profiles_charity_bps_minimum check (charity_bps >= 1000),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index profiles_selected_charity_idx on public.profiles (selected_charity_id);
-- Admin user list and admin checks.
create index profiles_role_idx on public.profiles (role) where role = 'admin';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;

-- Every new auth user gets a profile with the least-privileged role. Deliberately reads NO
-- metadata: nothing a client can put into signup data can influence role or charity.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---- is_admin() ---------------------------------------------------------------------------
-- Used by RLS policies. SECURITY DEFINER so it can read `profiles` without recursing into
-- the profiles policies; search_path is pinned so it cannot be hijacked.
-- NOTE: this is defence in depth. The API enforces admin authorization server-side first
-- (DECISIONS D-005); it uses the service role, which bypasses RLS.
create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated, service_role;

-- ---- platform_settings ---------------------------------------------------------------------
-- Single-row table holding values the PRD leaves open. NULL means "not decided yet"; code
-- that needs a NULL value must refuse to proceed rather than guess. Each column names the
-- open decision it serves. Writable by service role only.
create table public.platform_settings (
  id boolean primary key default true constraint platform_settings_singleton check (id),

  -- D-014. PRD §07: "A fixed portion of each subscription contributes to the prize pool."
  -- The PRD does not say whether the portion is a percentage or a fixed amount, so both
  -- shapes are representable; at most one may be set.
  prize_pool_bps                  public.basis_points,
  prize_pool_per_subscription_minor public.minor_units,

  -- D-012. Range of drawable numbers (not stated in the PRD).
  draw_number_min                 smallint,
  draw_number_max                 smallint,

  -- D-025. Optional product cap on a user's charity percentage (PRD only gives a minimum).
  charity_max_bps                 public.basis_points,

  updated_at                      timestamptz not null default now(),
  updated_by                      uuid references public.profiles (id) on delete restrict,

  constraint platform_settings_pool_shape
    check (prize_pool_bps is null or prize_pool_per_subscription_minor is null),
  constraint platform_settings_number_range
    check (
      (draw_number_min is null) = (draw_number_max is null)
      and (draw_number_min is null or draw_number_min < draw_number_max)
    ),
  constraint platform_settings_charity_max
    check (charity_max_bps is null or charity_max_bps >= 1000)
);

create trigger platform_settings_set_updated_at
  before update on public.platform_settings
  for each row execute function public.set_updated_at();

alter table public.platform_settings enable row level security;

-- The one settings row, with every undecided value left NULL.
insert into public.platform_settings (id) values (true);

-- ---- prize_tiers ---------------------------------------------------------------------------
-- PRD §07, reproduced exactly. This is the CURRENT rule; every draw snapshots the values it
-- used into draw_tier_results, so changing this table can never rewrite history.
--   5-Number match  40%  rollover: Yes (jackpot)
--   4-Number match  35%  rollover: No
--   3-Number match  25%  rollover: No
create table public.prize_tiers (
  match_count smallint primary key
                constraint prize_tiers_match_count check (match_count in (3, 4, 5)),
  share_bps   public.basis_points not null
                constraint prize_tiers_share_positive check (share_bps > 0),
  rolls_over  boolean not null
);

alter table public.prize_tiers enable row level security;

insert into public.prize_tiers (match_count, share_bps, rolls_over) values
  (5, 4000, true),
  (4, 3500, false),
  (3, 2500, false);
