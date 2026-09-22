-- =============================================================================
-- GATHER — 016: draw engine foundation (Phase 6)
--
-- Phase 1 stored the draw schema but deliberately left the ENGINE unimplemented (migration 006's own
-- words: "The draw ENGINE is not implemented in Phase 1... each [open point] is recorded in
-- docs/DECISIONS.md and enforced by domain code once decided."). This migration:
--
--   * locks the draw number range at 1-45 (owner decision, 2026-09-22, DECISIONS D-071) using the exact
--     configuration column the schema was designed for (D-012: platform_settings.draw_number_min/max).
--   * adds public.active_subscriber_ids(): the SAME condition as is_active_subscriber(uuid), as a set,
--     so the engine reads eligibility once instead of one RPC call per candidate user.
--   * adds two atomic, service-role-only functions that WRITE an already-computed result. All matching,
--     weighting, pool and tier maths happens in TypeScript pure functions
--     (apps/api/src/draws/domain.ts) — these functions never compute anything themselves, only apply
--     it, atomically, so a reader can never see a half-written draw:
--       - simulate_draw()  replaces a draw's candidate snapshot (numbers + entries + tier results)
--       - publish_draw()   freezes a simulated draw and creates its winners; idempotent (a second call
--                          on an already-published draw is a safe no-op, never a silent second write)
-- =============================================================================

-- D-071: the range is now decided (1-45, mirroring the score range) — configured, not hard-coded.
update public.platform_settings set draw_number_min = 1, draw_number_max = 45 where id = true;

-- ---- active_subscriber_ids() ------------------------------------------------------------------
-- Exactly is_active_subscriber(uuid)'s condition (D-068/D-070: status = 'active' and the recorded
-- period has not ended — no tolerance), as a set. SERVICE ROLE ONLY: unlike the per-user function,
-- this reveals every user's subscription status in bulk.
create function public.active_subscriber_ids()
returns table (user_id uuid)
language sql
stable
set search_path = ''
as $$
  select s.user_id
  from public.subscriptions s
  where s.status = 'active' and s.current_period_end > now();
$$;

revoke all on function public.active_subscriber_ids() from public;
revoke all on function public.active_subscriber_ids() from anon, authenticated;
grant execute on function public.active_subscriber_ids() to service_role;

-- ---- simulate_draw() ----------------------------------------------------------------------------
-- Atomically REPLACES a draw's candidate snapshot (PRD §06 "simulation"; DECISIONS D-018: candidate
-- rows are replaceable while unpublished). `p_entries`/`p_tier_results` are jsonb arrays of
-- already-computed rows. Refuses a published draw (SQLSTATE GS005) rather than silently doing nothing
-- or corrupting history — the caller decides what "already published" means for its own flow.
create function public.simulate_draw(
  p_draw_id                      uuid,
  p_winning_numbers               smallint[],
  p_active_subscriber_count       integer,
  p_currency                      text,
  p_prize_pool_minor              bigint,
  p_pool_contribution_bps         integer,
  p_pool_contribution_fixed_minor bigint,
  p_entries                       jsonb,
  p_tier_results                  jsonb
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_status public.draw_status;
begin
  -- Row lock: serialises concurrent simulate/publish attempts on the SAME draw so neither can ever
  -- observe or act on a half-written state.
  select status into v_status from public.draws where id = p_draw_id for update;
  if not found then
    raise exception 'No such draw' using errcode = '23503';
  end if;
  if v_status = 'published' then
    raise exception 'A published draw cannot be re-simulated' using errcode = 'GS005';
  end if;

  delete from public.draw_entries where draw_id = p_draw_id;
  delete from public.draw_tier_results where draw_id = p_draw_id;

  insert into public.draw_entries (draw_id, user_id, entry_numbers, match_count)
  select
    p_draw_id,
    (e ->> 'user_id')::uuid,
    array(select jsonb_array_elements_text(e -> 'entry_numbers'))::smallint[],
    (e ->> 'match_count')::smallint
  from jsonb_array_elements(p_entries) as e;

  insert into public.draw_tier_results
    (draw_id, match_count, share_bps, rolls_over, base_pool_minor, rollover_in_minor,
     winners_count, prize_per_winner_minor, remainder_minor, rollover_out_minor)
  select
    p_draw_id,
    (t ->> 'match_count')::smallint,
    (t ->> 'share_bps')::integer,
    (t ->> 'rolls_over')::boolean,
    (t ->> 'base_pool_minor')::bigint,
    (t ->> 'rollover_in_minor')::bigint,
    (t ->> 'winners_count')::integer,
    (t ->> 'prize_per_winner_minor')::bigint,
    (t ->> 'remainder_minor')::bigint,
    (t ->> 'rollover_out_minor')::bigint
  from jsonb_array_elements(p_tier_results) as t;

  update public.draws
     set winning_numbers               = p_winning_numbers,
         status                        = 'simulated',
         simulated_at                  = now(),
         active_subscriber_count       = p_active_subscriber_count,
         currency                      = p_currency,
         prize_pool_minor              = p_prize_pool_minor,
         pool_contribution_bps         = p_pool_contribution_bps,
         pool_contribution_fixed_minor = p_pool_contribution_fixed_minor
   where id = p_draw_id;
end;
$$;

revoke all on function public.simulate_draw(uuid, smallint[], integer, text, bigint, integer, bigint, jsonb, jsonb) from public;
revoke all on function public.simulate_draw(uuid, smallint[], integer, text, bigint, integer, bigint, jsonb, jsonb) from anon, authenticated;
grant execute on function public.simulate_draw(uuid, smallint[], integer, text, bigint, integer, bigint, jsonb, jsonb) to service_role;

-- ---- publish_draw() -----------------------------------------------------------------------------
-- Atomically freezes a simulated draw and creates its winners (PRD §06: admin "publishes"; winners are
-- created ONLY here, never at simulate time — DECISIONS D-045). IDEMPOTENT: a second call on an
-- already-published draw changes nothing and returns 'already_published' rather than erroring or
-- writing a second set of winners, so a retried or duplicated request is safe. The row lock above
-- serialises a genuine race between two concurrent publish attempts.
create function public.publish_draw(p_draw_id uuid, p_published_by uuid)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_status public.draw_status;
begin
  select status into v_status from public.draws where id = p_draw_id for update;
  if not found then
    raise exception 'No such draw' using errcode = '23503';
  end if;
  if v_status = 'published' then
    return 'already_published';
  end if;
  if v_status <> 'simulated' then
    raise exception 'A draw can only be published once it has been simulated' using errcode = 'GS006';
  end if;

  update public.draws
     set status = 'published', published_at = now(), published_by = p_published_by
   where id = p_draw_id;

  insert into public.winners (draw_id, user_id, draw_entry_id, match_count, prize_minor, currency)
  select e.draw_id, e.user_id, e.id, e.match_count, t.prize_per_winner_minor, d.currency
  from public.draw_entries e
  join public.draw_tier_results t on t.draw_id = e.draw_id and t.match_count = e.match_count
  join public.draws d on d.id = e.draw_id
  where e.draw_id = p_draw_id and e.match_count in (3, 4, 5);

  return 'published';
end;
$$;

revoke all on function public.publish_draw(uuid, uuid) from public;
revoke all on function public.publish_draw(uuid, uuid) from anon, authenticated;
grant execute on function public.publish_draw(uuid, uuid) to service_role;
