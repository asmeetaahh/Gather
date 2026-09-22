-- =============================================================================
-- GATHER — 005: Stableford scores
--
-- PRD §05:
--   * score range 1-45 (Stableford)                     -> CHECK (enforced here)
--   * each score has a date                             -> NOT NULL (enforced here)
--   * one score entry per date                          -> UNIQUE (user_id, played_on)
--   * only the latest 5 are retained at any time        -> hard cap of 5 rows (enforced here)
--   * a new score replaces the oldest stored score      -> DOMAIN/API LOGIC (not here)
--   * display newest first                              -> query ORDER BY played_on DESC
--
-- WHY the "replace the oldest" step is not a database trigger
--   Which score is "oldest" is not settled by the PRD (oldest DATE or earliest ENTRY?
--   DECISIONS D-027). A trigger that silently deletes rows would bake in a guess and would
--   make data disappear as a side effect of an INSERT. Instead the database guarantees the
--   invariant "never more than 5 rows" by REJECTING a 6th insert, and the application (a
--   single transaction: delete the oldest, insert the new one) owns the eviction rule.
-- =============================================================================

create table public.scores (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  -- Calendar date of the round (no time, no timezone).
  played_on        date not null,
  stableford_score smallint not null
                     constraint scores_stableford_range check (stableford_score between 1 and 45),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint scores_one_per_user_per_date unique (user_id, played_on)
);
-- The unique index above also serves "latest scores for a user" (played_on DESC scan).

create trigger scores_set_updated_at
  before update on public.scores
  for each row execute function public.set_updated_at();

alter table public.scores enable row level security;

-- Reject-only guard for the "maximum 5 retained" rule. It never deletes anything.
-- SECURITY DEFINER so the count sees all of the user's rows regardless of the caller's RLS.
-- A per-user advisory lock serialises concurrent inserts so two parallel requests cannot
-- both observe 4 rows and both succeed.
create function public.enforce_score_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('scores:' || new.user_id::text, 0));

  select count(*) into existing
  from public.scores s
  where s.user_id = new.user_id and s.id is distinct from new.id;

  -- 5 = PRD §05 "Only the latest 5 scores are retained at any time".
  if existing >= 5 then
    raise exception 'A user can retain at most 5 scores; remove one before adding another'
      using errcode = 'check_violation', constraint = 'scores_max_five_per_user';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_score_cap() from public;

-- Also fires when an UPDATE moves a score to another user, which could exceed that user's cap.
create trigger scores_enforce_cap
  before insert or update of user_id on public.scores
  for each row execute function public.enforce_score_cap();
