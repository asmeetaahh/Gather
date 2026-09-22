-- =============================================================================
-- GATHER — 002: charity directory
--
-- PRD §08: charity listing with search and filter; profiles with description, images and
-- upcoming events (e.g. golf days); a featured charity on the homepage. Admins can add,
-- edit and delete charities and manage content and media (PRD §11).
-- =============================================================================

create table public.charities (
  id           uuid primary key default gen_random_uuid(),
  -- URL-friendly identifier for the public profile page.
  slug         text not null unique
                 constraint charities_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name         text not null
                 constraint charities_name_length check (char_length(btrim(name)) between 1 and 200),
  description  text not null
                 constraint charities_description_present check (char_length(btrim(description)) > 0),
  -- AFFORDANCE, NOT A PRD FIELD: the PRD asks for "filter" but names no filter dimension
  -- (DECISIONS D-033). Free-form tags let admins classify charities without hard-coding a
  -- taxonomy. Revisit once D-033 is answered.
  tags         text[] not null default '{}',
  -- "Featured charity section on the homepage" (PRD §08). Not constrained to a single row
  -- because the PRD does not say whether one or several are featured.
  is_featured  boolean not null default false,
  -- Soft delete. The PRD requires admins to be able to delete charities, but contribution
  -- history and reports must survive (FKs from contributions are RESTRICT). Archiving hides
  -- a charity from public reads while preserving history; a charity with no history can be
  -- hard-deleted.
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Full-text search over name + description for the directory search box.
  -- The 'english' configuration is a development default.
  search       tsvector generated always as (
                 to_tsvector('english'::regconfig, name || ' ' || description)
               ) stored
);

create index charities_search_idx on public.charities using gin (search);
create index charities_tags_idx on public.charities using gin (tags);
-- Homepage spotlight + default listing only ever read visible rows.
create index charities_featured_idx on public.charities (name)
  where is_featured and archived_at is null;

create trigger charities_set_updated_at
  before update on public.charities
  for each row execute function public.set_updated_at();

alter table public.charities enable row level security;

-- Images live in the public `charity-media` storage bucket; this table records which
-- object belongs to which charity and in what order.
create table public.charity_images (
  id            uuid primary key default gen_random_uuid(),
  charity_id    uuid not null references public.charities (id) on delete cascade,
  storage_path  text not null
                  constraint charity_images_path_present check (char_length(storage_path) > 0),
  alt_text      text not null default '',
  -- Lowest sort_order is shown first (treated as the cover image by the UI).
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  unique (charity_id, storage_path)
);

create index charity_images_charity_idx on public.charity_images (charity_id, sort_order);

alter table public.charity_images enable row level security;

-- "Upcoming" is a query-time notion (starts_at >= now()), not a stored flag.
create table public.charity_events (
  id           uuid primary key default gen_random_uuid(),
  charity_id   uuid not null references public.charities (id) on delete cascade,
  title        text not null
                 constraint charity_events_title_length check (char_length(btrim(title)) between 1 and 200),
  description  text,
  location     text,
  starts_at    timestamptz not null,
  ends_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint charity_events_end_after_start check (ends_at is null or ends_at >= starts_at)
);

create index charity_events_charity_start_idx on public.charity_events (charity_id, starts_at);

create trigger charity_events_set_updated_at
  before update on public.charity_events
  for each row execute function public.set_updated_at();

alter table public.charity_events enable row level security;
