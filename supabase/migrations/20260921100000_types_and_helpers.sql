-- =============================================================================
-- GATHER — 001: shared types, domains and helpers
--
-- Conventions used by every later migration
--   * Primary keys are uuid (gen_random_uuid()); every timestamp is timestamptz (UTC).
--   * Money is ALWAYS integer minor units (domain minor_units, bigint >= 0) and is stored
--     next to a currency_code. No float / numeric money anywhere.  (DECISIONS D-003)
--   * Percentages are integer basis points (domain basis_points): 1% = 100, 10% = 1000,
--     100% = 10000. Integers avoid floating point drift.
--   * Only core PostgreSQL features are used (no extensions), so the migrations apply to a
--     clean Supabase project and to the PGlite test harness alike.
-- =============================================================================

-- ---- Hardening: new tables in `public` start with NO access for API roles ---------------
-- Supabase grants anon/authenticated broad default privileges on new public tables. We
-- reverse that so every table needs an explicit GRANT (see the RLS migration). RLS remains
-- the row-level gate; these grants are a second, independent layer.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- ---- Enumerations -----------------------------------------------------------------------
-- Status/state columns are modelled as enums so the database rejects unknown states.
-- Adding a value later is `alter type ... add value` in a new migration.

-- Registered account types. "Public visitor" has no account; "registered subscriber" is a
-- `user` who has an active subscription (derived, not stored — see is_active_subscriber()).
create type public.app_role as enum ('user', 'admin');

-- PRD §04: "Monthly plan and yearly plan".
create type public.billing_interval as enum ('month', 'year');

-- PRD §04 lifecycle terms: renewal / cancellation / lapsed. `pending` = created but first
-- payment not yet confirmed (a technical necessity of asynchronous checkout).
-- The raw provider status is kept separately (subscriptions.provider_status) so nothing is
-- lost while the mapping rules remain undecided (DECISIONS D-026).
create type public.subscription_status as enum ('pending', 'active', 'cancelled', 'lapsed');

-- What a payment was for. Independent donations are "not tied to gameplay" (PRD §08).
create type public.payment_kind as enum ('subscription', 'donation');

-- Provider-side payment lifecycle (our record of Stripe money movement).
create type public.payment_state as enum ('pending', 'succeeded', 'failed', 'refunded');

-- PRD §06: Random (standard lottery-style) or Algorithmic (weighted by score frequency).
create type public.draw_mode as enum ('random', 'algorithmic');

-- draft -> simulated -> published. `published` is terminal and immutable.
create type public.draw_status as enum ('draft', 'simulated', 'published');

-- PRD §09: proof upload, then admin approve/reject. The two leading states are derived from
-- "winner exists" and "proof uploaded, not yet reviewed".
create type public.verification_status as enum
  ('awaiting_proof', 'pending_review', 'approved', 'rejected');

-- PRD §09: "Payment states: Pending -> Paid".
create type public.payout_status as enum ('pending', 'paid');

create type public.stripe_event_status as enum ('received', 'processed', 'failed');

-- ---- Domains: one definition of "money" and "percentage" --------------------------------
-- Integer minor units (e.g. cents). bigint so pool totals cannot overflow.
create domain public.minor_units as bigint
  constraint minor_units_non_negative check (value >= 0);

-- Integer basis points, 0..10000 (0%..100%).
create domain public.basis_points as integer
  constraint basis_points_range check (value between 0 and 10000);

-- ISO-4217-shaped currency code. The PRD does not fix a currency (DECISIONS D-024), so the
-- code is stored with every monetary record instead of being assumed.
create domain public.currency_code as text
  constraint currency_code_format check (value ~ '^[A-Z]{3}$');

-- ---- Helper: maintain updated_at ------------------------------------------------------
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
