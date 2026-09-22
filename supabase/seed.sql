-- =============================================================================
-- GATHER — DEVELOPMENT SEED DATA. NOT PRODUCTION DATA.
--
-- Applied automatically by `supabase db reset` on a LOCAL stack only. It is deliberately not a
-- migration, so `supabase db push` (which deploys migrations to a hosted project) never runs it.
--
-- Contains only clearly fictional charities so the directory, spotlight and event listings have
-- something to show during development. It intentionally contains:
--   * no plans      — prices/currency are an open decision (DECISIONS D-024)
--   * no users      — accounts are created through Supabase Auth
--   * no payments, draws or winners, and no real personal or payment information
-- =============================================================================

insert into public.charities (slug, name, description, tags, is_featured) values
  ('example-youth-foundation', 'Example Youth Foundation',
   'A fictional charity used for development. It supports after-school coaching and mentoring for young people.',
   '{youth,education}', true),
  ('example-ocean-trust', 'Example Ocean Trust',
   'A fictional charity used for development. It funds coastal clean-ups and marine conservation projects.',
   '{environment}', false),
  ('example-community-kitchen', 'Example Community Kitchen',
   'A fictional charity used for development. It provides free meals and food parcels to local families.',
   '{community,food}', false)
on conflict (slug) do nothing;

-- Upcoming events, dated relative to "now" so they always appear as upcoming.
insert into public.charity_events (charity_id, title, description, location, starts_at)
select c.id, e.title, e.description, e.location, now() + e.starts_in
from public.charities c
join (values
  ('example-youth-foundation', 'Charity golf day', 'A fictional fundraising day.', 'Example Golf Club', interval '30 days'),
  ('example-ocean-trust', 'Beach clean-up morning', 'A fictional volunteer event.', 'Example Beach', interval '14 days'),
  ('example-community-kitchen', 'Community lunch', 'A fictional fundraising lunch.', 'Example Community Hall', interval '21 days')
) as e (slug, title, description, location, starts_in) on e.slug = c.slug
where not exists (
  select 1 from public.charity_events x where x.charity_id = c.id and x.title = e.title
);
