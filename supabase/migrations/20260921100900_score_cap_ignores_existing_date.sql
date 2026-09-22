-- =============================================================================
-- GATHER — 010: the score cap must not reject statements that add no row
--
-- PROBLEM (found in the Phase 1 checkpoint review). enforce_score_cap() runs BEFORE INSERT,
-- i.e. before PostgreSQL resolves ON CONFLICT. For a user already at 5 scores it therefore
-- rejected statements that would never have added a row:
--   * INSERT ... ON CONFLICT (user_id, played_on) DO UPDATE   -- an edit of an existing date
--   * INSERT ... ON CONFLICT DO NOTHING                       -- an idempotent retry
--   * a plain INSERT of an existing date, which reported "too many scores" instead of a
--     duplicate date (PRD SCR-04: a duplicate is not allowed, the entry may be edited/deleted)
--
-- FIX. An INSERT for a (user, date) that already exists cannot increase the row count: it can
-- only hit the unique constraint, be skipped by ON CONFLICT DO NOTHING, or turn into an UPDATE.
-- So the cap check is skipped for it and the existing constraint decides. An ON CONFLICT DO
-- UPDATE that tries to change user_id still fires the BEFORE UPDATE OF user_id trigger, so it
-- cannot be used to move a score into another user's full quota (covered by a test).
--
-- UNCHANGED: the cap is still reject-only (it never deletes), still serialised per user by an
-- advisory lock, and "replace the oldest" is still the application's job (DECISIONS D-049):
-- delete the oldest, then insert — in one transaction, one statement or one function.
--
-- CREATE OR REPLACE keeps the function's owner and privileges.
-- =============================================================================

create or replace function public.enforce_score_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('scores:' || new.user_id::text, 0));

  -- Adds no row (see above): let the unique constraint / ON CONFLICT handle it.
  if tg_op = 'INSERT' and exists (
    select 1 from public.scores s
    where s.user_id = new.user_id and s.played_on = new.played_on
  ) then
    return new;
  end if;

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
