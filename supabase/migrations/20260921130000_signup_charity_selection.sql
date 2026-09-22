-- =============================================================================
-- GATHER — 014: choose a charity at signup (PRD §08 CHR-01)
--
-- CHR-01: "Users select a charity at signup." The signup form sends the chosen charity in the signup data
-- (`raw_user_meta_data.selected_charity_id`), which — unlike a session — exists even when the project requires
-- email confirmation, so the choice survives the round trip through the confirmation email.
--
-- This replaces `handle_new_user()` from migration 003, which read NO signup metadata at all. It now reads
-- exactly ONE key, and treats it as untrusted input:
--   * it must look like a UUID (checked BEFORE the cast, so malformed input can never make a signup fail);
--   * it must name an existing, listed (non-archived) charity — anything else is ignored, not an error;
--   * nothing else in the metadata is read: role, charity percentage and everything else still come from
--     defaults (D-057/D-059: an administrator is made only by a service-role/SQL operation).
-- A signup without a valid charity still succeeds and leaves `selected_charity_id` NULL: the API refuses to
-- start a subscription for a user with no active selected charity (D-065), so this is not the enforcement
-- point — it is the place the signup form's choice is recorded.
--
-- `create or replace` keeps the existing trigger and the function's privileges (revoked from public).
-- =============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested text := new.raw_user_meta_data ->> 'selected_charity_id';
  chosen    uuid;
begin
  if requested ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select c.id into chosen
    from public.charities c
    where c.id = requested::uuid and c.archived_at is null;
  end if;

  insert into public.profiles (id, selected_charity_id)
  values (new.id, chosen)
  on conflict (id) do nothing;
  return new;
end;
$$;
