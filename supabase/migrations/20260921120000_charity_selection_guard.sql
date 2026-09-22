-- =============================================================================
-- GATHER — 013: a user can only SELECT a charity that is still listed (Phase 4)
--
-- PRD §08: users select a charity (CHR-01) and admins can delete charities (§11). Phase 1 keeps charities
-- that have history by ARCHIVING them (archived_at, D-043), which hides them from the public.
--
-- PROBLEM. `profiles.selected_charity_id` only has a foreign key, so it accepts an archived charity. The
-- API checks this, but Phase 1 also lets a signed-in user update their own `selected_charity_id` DIRECTLY
-- (column grant, D-048). Without a database rule that path could point a user's contributions at a charity
-- that is no longer listed.
--
-- FIX. A guard trigger rejects selecting an archived charity, on both paths. It fires only when the
-- selection actually CHANGES, so a user who already selected a charity that is archived LATER is not blocked
-- from editing their percentage or choosing a different charity. The rejection uses a custom SQLSTATE
-- (GS002) so the API can tell it apart from other check violations.
--
-- SECURITY DEFINER because archived charities are invisible to the caller under RLS: an invoker-rights
-- check would simply not see them and would wrongly allow the selection. search_path is pinned; the
-- function is not executable by browser roles (it is a trigger function).
-- =============================================================================

create function public.enforce_selectable_charity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.selected_charity_id is null then
    return new;
  end if;

  -- Only a CHANGE of selection is checked (see above).
  if tg_op = 'UPDATE' and new.selected_charity_id is not distinct from old.selected_charity_id then
    return new;
  end if;

  if exists (
    select 1 from public.charities c
    where c.id = new.selected_charity_id and c.archived_at is not null
  ) then
    raise exception 'An archived charity cannot be selected'
      using errcode = 'GS002';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_selectable_charity() from public;

create trigger profiles_enforce_selectable_charity
  before insert or update of selected_charity_id on public.profiles
  for each row execute function public.enforce_selectable_charity();
