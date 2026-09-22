-- =============================================================================
-- GATHER — 007: administrative audit log
--
-- Not required by the PRD (development decision, see DECISIONS): a record of who did what in
-- the admin panel. The API (service role) inserts a row alongside each admin action.
--
-- Append-only: rows can be inserted and read but never changed or removed.
-- `actor_id` is intentionally NOT a foreign key so the log outlives any user account.
-- =============================================================================

create table public.admin_audit_log (
  id          bigint generated always as identity primary key,
  actor_id    uuid,
  action      text not null
                constraint admin_audit_log_action_length check (char_length(action) between 1 and 100),
  entity_type text not null,
  entity_id   text,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index admin_audit_log_created_idx on public.admin_audit_log (created_at desc);
create index admin_audit_log_entity_idx on public.admin_audit_log (entity_type, entity_id);
create index admin_audit_log_actor_idx on public.admin_audit_log (actor_id);

alter table public.admin_audit_log enable row level security;

create function public.guard_audit_log_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'admin_audit_log is append-only'
    using errcode = 'integrity_constraint_violation';
end;
$$;

create trigger admin_audit_log_append_only
  before update or delete on public.admin_audit_log
  for each row execute function public.guard_audit_log_append_only();
