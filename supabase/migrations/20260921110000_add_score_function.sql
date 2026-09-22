-- =============================================================================
-- GATHER — 012: atomic "add a score, replacing the oldest" (Phase 3)
--
-- PRD §05: only the latest 5 scores are retained; "a new score replaces the oldest stored score
-- automatically"; one entry per date.
--
-- WHY A FUNCTION. supabase-js cannot run a multi-statement transaction, and "delete the oldest,
-- then insert" must be atomic (ARCHITECTURE §13). The Phase 1 cap trigger deliberately only REFUSES a
-- 6th row and never deletes (DECISIONS D-049); this function is the explicit, single place where
-- eviction happens, called by the API.
--
-- RULES (owner decision, DECISIONS D-061 — they resolve part of D-027):
--   * "Oldest" means the EARLIEST played_on date, regardless of the order scores were entered.
--   * A score dated OLDER than all five existing ones is REJECTED (SQLSTATE GS001) and nothing changes:
--     it would not be among the five most recent dates, and silently dropping what the user just
--     typed would be worse than telling them.
--   * A date the user already has is REJECTED as a duplicate (unique_violation) BEFORE anything is
--     evicted, so a duplicate can never cost the user their oldest score. (Editing an existing date is
--     a plain UPDATE done by the API.)
--   * Future dates, maximum age and changing a score's date are NOT decided (D-027) and NOT enforced.
--
-- CONCURRENCY. The per-user advisory lock is the SAME key the cap trigger uses (transaction-scoped,
-- re-entrant within one transaction), so two parallel adds for one user run one after the other:
-- the second sees the first's committed result. The delete happens before the insert, which is the
-- only order the cap trigger allows.
--
-- SECURITY. It takes an arbitrary user id, so — like is_active_subscriber(uuid) — it is executable
-- ONLY by service_role (the API, which derives the id from a verified token). It is deliberately NOT
-- executable by anon/authenticated: it would let one user write another's scores through /rpc.
-- =============================================================================

create function public.add_score(
  p_user_id          uuid,
  p_played_on        date,
  p_stableford_score integer
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_count    integer;
  v_oldest   public.scores%rowtype;
  v_replaced date := null;
  v_saved    public.scores%rowtype;
begin
  if p_user_id is null or p_played_on is null then
    raise exception 'A user and a date are required'
      using errcode = 'null_value_not_allowed';
  end if;

  -- PRD §05: Stableford range 1-45. Checked here for a clear error; the table CHECK still backs it up.
  if p_stableford_score is null or p_stableford_score not between 1 and 45 then
    raise exception 'A Stableford score must be an integer from 1 to 45'
      using errcode = 'check_violation', constraint = 'scores_stableford_range';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('scores:' || p_user_id::text, 0));

  -- PRD §05: one entry per date. Reject BEFORE evicting anything.
  if exists (
    select 1 from public.scores s
    where s.user_id = p_user_id and s.played_on = p_played_on
  ) then
    raise exception 'A score for this date already exists'
      using errcode = 'unique_violation', constraint = 'scores_one_per_user_per_date';
  end if;

  select count(*) into v_count from public.scores s where s.user_id = p_user_id;

  -- 5 = PRD §05 "Only the latest 5 scores are retained at any time".
  if v_count >= 5 then
    select * into v_oldest
    from public.scores s
    where s.user_id = p_user_id
    order by s.played_on asc
    limit 1;

    if p_played_on < v_oldest.played_on then
      raise exception 'This date is older than your five most recent scores'
        using errcode = 'GS001';
    end if;

    delete from public.scores where id = v_oldest.id;
    v_replaced := v_oldest.played_on;
  end if;

  insert into public.scores (user_id, played_on, stableford_score)
  values (p_user_id, p_played_on, p_stableford_score)
  returning * into v_saved;

  return jsonb_build_object('score', to_jsonb(v_saved), 'replaced_played_on', v_replaced);
end;
$$;

revoke all on function public.add_score(uuid, date, integer) from public;
revoke all on function public.add_score(uuid, date, integer) from anon, authenticated;
grant execute on function public.add_score(uuid, date, integer) to service_role;
