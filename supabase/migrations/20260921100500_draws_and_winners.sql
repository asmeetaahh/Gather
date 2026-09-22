-- =============================================================================
-- GATHER — 006: monthly draws, entries, tier results, winners, winner proof
--
-- Lifecycle (PRD §06): monthly cadence; admin configures mode, simulates, then publishes.
--   draft --simulate--> simulated --publish--> published (terminal, immutable)
--
-- The draw ENGINE is not implemented in Phase 1. Simulation results are stored as candidate
-- rows in the same tables (draws.winning_numbers, draw_entries, draw_tier_results) and are
-- replaced on each re-simulation. On publish they are frozen by the guard triggers below.
-- Winner rows are created only at publish time.
--
-- Everything the PRD leaves undecided (what a "match" is, number range, weighting, pool size,
-- rollover trigger, remainder rule, eligibility) is deliberately NOT encoded as a constraint;
-- each is recorded in docs/DECISIONS.md and enforced by domain code once decided.
-- =============================================================================

-- ---- draws ---------------------------------------------------------------------------------
create table public.draws (
  id                      uuid primary key default gen_random_uuid(),
  -- The month this draw belongs to, stored as the first day of that month ("monthly
  -- cadence", PRD §06). A plain date avoids committing to a timezone (D-017).
  draw_month              date not null unique
                            constraint draws_month_is_first_of_month
                            check (extract(day from draw_month) = 1),
  mode                    public.draw_mode not null,
  status                  public.draw_status not null default 'draft',
  -- When the draw is planned to run / entries close. Nullable: cadence, cutoff and timezone
  -- are undecided (D-017).
  scheduled_at            timestamptz,

  -- The drawn numbers. DERIVED, NOT STATED: the PRD never says "5 numbers"; it defines a
  -- "5-number match" as the top prize tier, which implies a 5-number draw. The number RANGE
  -- and whether numbers may repeat are undecided (D-012) and intentionally unconstrained.
  winning_numbers         smallint[],

  -- Snapshots of the inputs to this draw's prize pool (PRD §07: pool is calculated "based on
  -- active subscriber count"). Pool size rule: D-014; yearly treatment: D-015.
  active_subscriber_count integer
                            constraint draws_subscriber_count_non_negative
                            check (active_subscriber_count is null or active_subscriber_count >= 0),
  currency                public.currency_code,
  prize_pool_minor        public.minor_units,
  pool_contribution_bps   public.basis_points,
  pool_contribution_fixed_minor public.minor_units,

  simulated_at            timestamptz,
  published_at            timestamptz,
  created_by              uuid references public.profiles (id) on delete restrict,
  published_by            uuid references public.profiles (id) on delete restrict,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint draws_numbers_shape
    check (
      winning_numbers is null
      or (cardinality(winning_numbers) = 5
          and array_position(winning_numbers, null::smallint) is null)
    ),
  -- A simulated or published draw always has numbers.
  constraint draws_numbers_present_once_simulated
    check (status = 'draft' or winning_numbers is not null),
  -- A published draw is complete: every figure needed to explain it is present.
  constraint draws_published_is_complete
    check (
      status <> 'published'
      or (published_at is not null and prize_pool_minor is not null
          and active_subscriber_count is not null and currency is not null)
    ),
  constraint draws_published_at_only_when_published
    check (status = 'published' or published_at is null),
  constraint draws_pool_has_currency
    check (prize_pool_minor is null or currency is not null),
  constraint draws_pool_config_shape
    check (pool_contribution_bps is null or pool_contribution_fixed_minor is null),
  -- Target for composite foreign keys that must agree on currency.
  constraint draws_id_currency_key unique (id, currency)
);

create index draws_status_idx on public.draws (status, draw_month desc);

create trigger draws_set_updated_at
  before update on public.draws
  for each row execute function public.set_updated_at();

alter table public.draws enable row level security;

-- ---- draw_entries --------------------------------------------------------------------------
-- One row per user per draw: "Participation summary — draws entered" (PRD §10).
-- `entry_numbers` is a SNAPSHOT of the numbers the user is matched with at draw time, so a
-- result stays explainable even if the user later edits scores. What those numbers ARE (the
-- user's scores?) and who is eligible are undecided (D-011, D-016): the schema does not
-- presume either. Users with fewer than five numbers are representable (D-016).
create table public.draw_entries (
  id            uuid primary key default gen_random_uuid(),
  draw_id       uuid not null references public.draws (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete restrict,
  entry_numbers smallint[] not null
                  constraint draw_entries_numbers_shape
                  check (cardinality(entry_numbers) <= 5
                         and array_position(entry_numbers, null::smallint) is null),
  -- Number of matches with the draw (0-5). NULL until evaluated.
  match_count   smallint
                  constraint draw_entries_match_count_range check (match_count between 0 and 5),
  created_at    timestamptz not null default now(),
  constraint draw_entries_one_per_user_per_draw unique (draw_id, user_id),
  -- Target for the composite foreign key from winners.
  constraint draw_entries_identity_key unique (id, draw_id, user_id, match_count)
);

create index draw_entries_user_idx on public.draw_entries (user_id, draw_id);
-- Winner queries only look at entries that matched a prize tier.
create index draw_entries_prize_matches_idx on public.draw_entries (draw_id, match_count)
  where match_count >= 3;

alter table public.draw_entries enable row level security;

-- ---- draw_tier_results ---------------------------------------------------------------------
-- Per draw and prize tier: the pool, who shared it, and any rollover — a frozen snapshot that
-- includes the share and rollover flag in force at the time (so editing prize_tiers later
-- cannot change history). PRD §07: 40/35/25, only 5-match rolls over, equal split.
create table public.draw_tier_results (
  draw_id                uuid not null references public.draws (id) on delete cascade,
  match_count            smallint not null references public.prize_tiers (match_count),
  share_bps              public.basis_points not null,
  rolls_over             boolean not null,
  -- This draw's own share of the pool for the tier.
  base_pool_minor        public.minor_units not null,
  -- Carried in from earlier draws (only tiers that roll over may carry).
  rollover_in_minor      public.minor_units not null default 0,
  winners_count          integer not null default 0
                           constraint draw_tier_results_winners_non_negative check (winners_count >= 0),
  -- Equal split among winners (PRD §07). Integer division leaves a remainder whose handling
  -- is undecided (D-020); `remainder_minor` records whatever the decided rule produces.
  prize_per_winner_minor public.minor_units not null default 0,
  remainder_minor        public.minor_units not null default 0,
  -- Amount carried into the next draw (only tiers that roll over). "Unclaimed" trigger: D-019.
  rollover_out_minor     public.minor_units not null default 0,
  primary key (draw_id, match_count),
  -- PRD §07: only the 5-match jackpot rolls over.
  constraint draw_tier_results_rollover_only_if_tier_rolls
    check (rolls_over or (rollover_in_minor = 0 and rollover_out_minor = 0)),
  constraint draw_tier_results_no_winners_no_prize
    check (winners_count > 0 or (prize_per_winner_minor = 0 and remainder_minor = 0)),
  -- Nothing can be paid out or carried beyond what the tier held.
  constraint draw_tier_results_allocation_within_pool
    check (
      prize_per_winner_minor * winners_count + remainder_minor + rollover_out_minor
        <= base_pool_minor + rollover_in_minor
    )
);

alter table public.draw_tier_results enable row level security;

-- ---- winners -------------------------------------------------------------------------------
-- Created at publish for every entry that matched a prize tier. Verification and payout are
-- tracked here (PRD §09, §11): the winner uploads proof, an admin approves/rejects, an admin
-- marks the payout completed.
create table public.winners (
  id                  uuid primary key default gen_random_uuid(),
  draw_id             uuid not null,
  user_id             uuid not null,
  draw_entry_id       uuid not null unique,
  match_count         smallint not null
                        constraint winners_match_count_is_prize_tier check (match_count in (3, 4, 5)),
  prize_minor         public.minor_units not null,
  currency            public.currency_code not null,

  verification_status public.verification_status not null default 'awaiting_proof',
  reviewed_by         uuid references public.profiles (id) on delete restrict,
  reviewed_at         timestamptz,
  review_note         text,

  -- PRD §09: Pending -> Paid.
  payout_status       public.payout_status not null default 'pending',
  paid_at             timestamptz,
  paid_by             uuid references public.profiles (id) on delete restrict,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- The winner must agree with the entry it came from on draw, user and tier ...
  constraint winners_entry_fk
    foreign key (draw_entry_id, draw_id, user_id, match_count)
    references public.draw_entries (id, draw_id, user_id, match_count) on delete restrict,
  -- ... with that draw's tier result ...
  constraint winners_tier_result_fk
    foreign key (draw_id, match_count)
    references public.draw_tier_results (draw_id, match_count) on delete restrict,
  -- ... and with the draw's currency.
  constraint winners_draw_currency_fk
    foreign key (draw_id, currency)
    references public.draws (id, currency) on delete restrict,
  -- One entry per user per draw implies one prize per user per draw.
  constraint winners_one_per_user_per_draw unique (draw_id, user_id),
  constraint winners_review_timestamp
    check ((verification_status in ('approved', 'rejected')) = (reviewed_at is not null)),
  constraint winners_paid_timestamp
    check ((payout_status = 'paid') = (paid_at is not null))
);

create index winners_user_idx on public.winners (user_id, created_at desc);
-- Admin work queues: "needs review" / "approved, awaiting payout".
create index winners_admin_queue_idx on public.winners (verification_status, payout_status);

create trigger winners_set_updated_at
  before update on public.winners
  for each row execute function public.set_updated_at();

alter table public.winners enable row level security;

-- ---- winner_proofs -------------------------------------------------------------------------
-- Metadata for the screenshot a winner uploads (PRD §09). The file itself is in the PRIVATE
-- `winner-proofs` storage bucket. Multiple rows per winner are allowed so a resubmission after
-- rejection (undecided, D-021) needs no schema change; the review outcome lives on `winners`.
create table public.winner_proofs (
  id           uuid primary key default gen_random_uuid(),
  winner_id    uuid not null references public.winners (id) on delete restrict,
  -- Object path inside the bucket. Convention: '<winner_id>/<file>', enforced below and
  -- relied on by the storage policies.
  storage_path text not null unique,
  uploaded_at  timestamptz not null default now(),
  constraint winner_proofs_path_under_winner
    check (storage_path like (winner_id::text || '/%'))
);

create index winner_proofs_winner_idx on public.winner_proofs (winner_id, uploaded_at desc);

alter table public.winner_proofs enable row level security;

-- =============================================================================
-- Immutability guards
--
-- Published results must not change through ordinary operations. Users have no write
-- privileges at all (see RLS migration); these triggers additionally protect against
-- application bugs running with the service role. They only ever RAISE — they never modify
-- or delete data. Corrections to a published draw are undecided (D-018); until decided they
-- require a deliberate, reviewed migration.
-- =============================================================================

-- A published draw cannot be updated or deleted.
create function public.guard_published_draw()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'published' then
    raise exception 'Published draws are immutable (draw %)', old.id
      using errcode = 'integrity_constraint_violation';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger draws_guard_published
  before update or delete on public.draws
  for each row execute function public.guard_published_draw();

-- Entries and tier results of a published draw cannot be inserted, changed or removed.
-- If the parent draw is already gone (cascade from deleting an unpublished draw), allow it.
create function public.guard_published_draw_children()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_draw_id uuid;
  v_status  public.draw_status;
begin
  if tg_op = 'DELETE' then
    v_draw_id := old.draw_id;
  else
    v_draw_id := new.draw_id;
  end if;

  select d.status into v_status from public.draws d where d.id = v_draw_id;

  if v_status = 'published' then
    raise exception '% of a published draw are immutable (draw %)', tg_table_name, v_draw_id
      using errcode = 'integrity_constraint_violation';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger draw_entries_guard_published
  before insert or update or delete on public.draw_entries
  for each row execute function public.guard_published_draw_children();

create trigger draw_tier_results_guard_published
  before insert or update or delete on public.draw_tier_results
  for each row execute function public.guard_published_draw_children();

-- Winners: only created for published draws; identity and prize are frozen; a paid winner
-- can never go back to pending (PRD §09 "Pending -> Paid"); never deleted.
create function public.guard_winner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status public.draw_status;
begin
  if tg_op = 'INSERT' then
    select d.status into v_status from public.draws d where d.id = new.draw_id;
    if v_status is distinct from 'published' then
      raise exception 'Winners can only be created for a published draw'
        using errcode = 'integrity_constraint_violation';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'Winner records are permanent and cannot be deleted'
      using errcode = 'integrity_constraint_violation';
  end if;

  if (new.draw_id, new.user_id, new.draw_entry_id, new.match_count, new.prize_minor, new.currency)
     is distinct from
     (old.draw_id, old.user_id, old.draw_entry_id, old.match_count, old.prize_minor, old.currency) then
    raise exception 'A winner''s draw, user, tier and prize are immutable'
      using errcode = 'integrity_constraint_violation';
  end if;

  if old.payout_status = 'paid' and new.payout_status <> 'paid' then
    raise exception 'A paid winner cannot return to pending'
      using errcode = 'integrity_constraint_violation';
  end if;

  return new;
end;
$$;

create trigger winners_guard
  before insert or update or delete on public.winners
  for each row execute function public.guard_winner();
