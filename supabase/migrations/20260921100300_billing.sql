-- =============================================================================
-- GATHER — 004: plans, subscriptions, payments, charity contributions, Stripe ledger
--
-- No Stripe integration exists yet (later phase). These tables are the database side of the
-- payment boundary: the API (service role) writes them from verified Stripe webhooks.
-- Financial rows reference profiles with ON DELETE RESTRICT: an account with financial
-- history cannot be hard-deleted (erasure policy is an open decision, D-032).
-- =============================================================================

-- ---- plans ---------------------------------------------------------------------------------
-- PRD §04: "Monthly plan and yearly plan (discounted rate)". Prices and currency are NOT in
-- the PRD (D-024), so no plan rows are created here; they are inserted once decided.
create table public.plans (
  id               uuid primary key default gen_random_uuid(),
  name             text not null
                     constraint plans_name_length check (char_length(btrim(name)) between 1 and 100),
  billing_interval public.billing_interval not null,
  amount_minor     public.minor_units not null
                     constraint plans_amount_positive check (amount_minor > 0),
  currency         public.currency_code not null,
  stripe_price_id  text unique,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- The PRD defines exactly one monthly and one yearly plan; historic prices are kept as
-- inactive rows. (Relax to per-currency if D-024 introduces several currencies.)
-- NOTE: "yearly is cheaper than 12 x monthly" is a cross-row rule and is validated when
-- plans are created (application/admin logic), not by a CHECK.
create unique index plans_one_active_per_interval
  on public.plans (billing_interval) where is_active;

create trigger plans_set_updated_at
  before update on public.plans
  for each row execute function public.set_updated_at();

alter table public.plans enable row level security;

-- ---- billing_customers ---------------------------------------------------------------------
-- Maps a user to their Stripe customer. Kept out of `profiles` so the mapping is never part
-- of a row that browsers can read. No user-facing policies: service role only.
create table public.billing_customers (
  user_id            uuid primary key references public.profiles (id) on delete restrict,
  stripe_customer_id text not null unique,
  created_at         timestamptz not null default now()
);

alter table public.billing_customers enable row level security;

-- ---- subscriptions -------------------------------------------------------------------------
create table public.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles (id) on delete restrict,
  plan_id                uuid not null references public.plans (id) on delete restrict,
  status                 public.subscription_status not null default 'pending',
  -- Raw Stripe status, kept verbatim so the mapping to `status` (grace periods, past_due
  -- handling — D-026) can be decided or changed without losing information.
  provider_status        text,
  stripe_subscription_id text unique,
  -- PRD §10: the dashboard shows the renewal date.
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  -- Whether cancellation takes effect immediately or at period end is undecided (D-026);
  -- both shapes are representable.
  cancel_at_period_end   boolean not null default false,
  cancelled_at           timestamptz,
  ended_at               timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint subscriptions_period_order
    check (current_period_start is null or current_period_end is null
           or current_period_end > current_period_start),
  -- An active subscription always has a renewal date to display/validate against.
  constraint subscriptions_active_has_period_end
    check (status <> 'active' or current_period_end is not null)
);

-- A user has at most one in-flight or live subscription at a time (one plan at a time).
-- Cancelled/lapsed rows are history and do not block re-subscribing.
create unique index subscriptions_one_current_per_user
  on public.subscriptions (user_id) where status in ('pending', 'active');
create index subscriptions_user_idx on public.subscriptions (user_id, created_at desc);
-- Admin views and lapse/renewal sweeps.
create index subscriptions_status_period_end_idx
  on public.subscriptions (status, current_period_end);

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

alter table public.subscriptions enable row level security;

-- ---- is_active_subscriber() ----------------------------------------------------------------
-- THE single definition of "this user currently has an active subscription".
-- PRD §04: "Real-time subscription status check on every authenticated request", so the API
-- and RLS both read this function/table on each request instead of trusting cached state.
-- The exact rule is intentionally minimal (status = 'active'). Grace periods, cancelled-but-
-- paid-through access and past_due handling are undecided (D-026/D-030); when decided, change
-- THIS function in a new migration and every policy follows.
create function public.is_active_subscriber(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.subscriptions s
    where s.user_id = p_user_id and s.status = 'active'
  );
$$;

revoke all on function public.is_active_subscriber(uuid) from public;
grant execute on function public.is_active_subscriber(uuid) to authenticated, service_role;

-- ---- payments ------------------------------------------------------------------------------
-- Our record of money received through Stripe: subscription charges and donations.
create table public.payments (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references public.profiles (id) on delete restrict,
  kind                     public.payment_kind not null,
  subscription_id          uuid references public.subscriptions (id) on delete restrict,
  amount_minor             public.minor_units not null
                             constraint payments_amount_positive check (amount_minor > 0),
  currency                 public.currency_code not null,
  state                    public.payment_state not null default 'pending',
  stripe_payment_intent_id text unique,
  stripe_invoice_id        text unique,
  paid_at                  timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  -- A subscription payment belongs to a subscription; a donation never does.
  constraint payments_kind_matches_subscription
    check ((kind = 'subscription') = (subscription_id is not null)),
  constraint payments_paid_has_timestamp
    check (state not in ('succeeded', 'refunded') or paid_at is not null),
  -- Target for composite foreign keys that must agree on owner, currency and kind.
  constraint payments_identity_key unique (id, user_id, currency, kind)
);

create index payments_user_idx on public.payments (user_id, created_at desc);
create index payments_subscription_idx on public.payments (subscription_id)
  where subscription_id is not null;
-- Prize-pool and revenue queries only ever read succeeded payments.
create index payments_succeeded_paid_at_idx on public.payments (paid_at)
  where state = 'succeeded';

create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function public.set_updated_at();

alter table public.payments enable row level security;

-- ---- charity_contributions -----------------------------------------------------------------
-- The charity's share of a payment. Written once per payment, so charity totals (PRD §11
-- "Charity contribution totals") are a SUM over this table. Records the percentage and basis
-- that were applied at the time, so later changes to a user's percentage never rewrite it.
--
-- The DB guarantees the recorded percentage is >= the PRD minimum and that the amount never
-- exceeds its basis. HOW the amount is computed (gross vs net basis, rounding) is a domain
-- rule pending D-025 and lives in application code with tests.
create table public.charity_contributions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete restrict,
  charity_id     uuid not null references public.charities (id) on delete restrict,
  payment_id     uuid not null unique,
  source         public.payment_kind not null,
  currency       public.currency_code not null,
  amount_minor   public.minor_units not null
                   constraint charity_contributions_amount_positive check (amount_minor > 0),
  -- Subscription-sourced rows only: the fee the percentage was applied to and the percentage.
  basis_minor    public.minor_units,
  percentage_bps public.basis_points,
  created_at     timestamptz not null default now(),
  -- The contribution must agree with its payment on owner, currency and kind.
  constraint charity_contributions_payment_fk
    foreign key (payment_id, user_id, currency, source)
    references public.payments (id, user_id, currency, kind) on delete restrict,
  constraint charity_contributions_subscription_shape
    check (
      source <> 'subscription'
      or (basis_minor is not null and percentage_bps is not null
          and percentage_bps >= 1000 and amount_minor <= basis_minor)
    ),
  constraint charity_contributions_donation_shape
    check (source <> 'donation' or (basis_minor is null and percentage_bps is null))
);

create index charity_contributions_charity_idx on public.charity_contributions (charity_id);
create index charity_contributions_user_idx
  on public.charity_contributions (user_id, created_at desc);

alter table public.charity_contributions enable row level security;

-- ---- stripe_events -------------------------------------------------------------------------
-- Webhook idempotency ledger. The Stripe event id is the primary key, so the API can do
-- `insert ... on conflict (id) do nothing` and process an event only when the insert
-- succeeded. Service role only.
create table public.stripe_events (
  id            text primary key,
  type          text not null,
  livemode      boolean not null,
  payload       jsonb not null,
  status        public.stripe_event_status not null default 'received',
  error         text,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  constraint stripe_events_processed_matches_status
    check ((status = 'processed') = (processed_at is not null))
);

-- Retry/inspection queue: only unfinished events.
create index stripe_events_unprocessed_idx
  on public.stripe_events (received_at) where status <> 'processed';

alter table public.stripe_events enable row level security;
