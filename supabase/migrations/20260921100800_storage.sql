-- =============================================================================
-- GATHER — 009: storage buckets and access policies
--
-- Two buckets, two very different exposures:
--
--   winner-proofs  PRIVATE. Screenshots of golf-platform scores uploaded by winners (PRD §09).
--                  Never publicly readable. A user may upload only into the folder named after
--                  a winner record they own; only that user and admins can read; nobody but
--                  the service role (the API) can modify or delete. Downloads are served via
--                  short-lived signed URLs created by the API — the bucket is never made public.
--
--   charity-media  PUBLIC READ. Charity images (PRD §08). Only admins can write.
--
-- Object path convention for proofs: '<winner_id>/<filename>' (also enforced on
-- winner_proofs.storage_path). No image processing/OCR is performed.
--
-- Limits below are DEVELOPMENT DEFAULTS, not PRD values: the PRD only says "screenshot"
-- (accepted formats/size are undecided, D-021). Adjust in a new migration once decided.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('winner-proofs', 'winner-proofs', false, 10485760,
     array['image/png', 'image/jpeg', 'image/webp']),
  ('charity-media', 'charity-media', true, 5242880,
     array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

-- ---- winner-proofs --------------------------------------------------------------------------
-- Upload: authenticated owner of the winner record named by the first path segment, and only
-- while that winner is still awaiting proof (resubmission after rejection is undecided, D-021;
-- the API can always issue an upload through the service role once that is decided).
create policy winner_proofs_objects_insert_owner on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'winner-proofs'
    and exists (
      select 1 from public.winners w
      where w.id::text = (storage.foldername(name))[1]
        and w.user_id = (select auth.uid())
        and w.verification_status = 'awaiting_proof'
    )
  );

create policy winner_proofs_objects_select_owner on storage.objects
  for select to authenticated
  using (
    bucket_id = 'winner-proofs'
    and exists (
      select 1 from public.winners w
      where w.id::text = (storage.foldername(name))[1]
        and w.user_id = (select auth.uid())
    )
  );

create policy winner_proofs_objects_select_admin on storage.objects
  for select to authenticated
  using (bucket_id = 'winner-proofs' and (select public.is_admin()));

-- (No UPDATE/DELETE policies for winner-proofs: proof is immutable to end users.)

-- ---- charity-media --------------------------------------------------------------------------
create policy charity_media_objects_select_public on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'charity-media');

create policy charity_media_objects_insert_admin on storage.objects
  for insert to authenticated
  with check (bucket_id = 'charity-media' and (select public.is_admin()));

create policy charity_media_objects_update_admin on storage.objects
  for update to authenticated
  using (bucket_id = 'charity-media' and (select public.is_admin()))
  with check (bucket_id = 'charity-media' and (select public.is_admin()));

create policy charity_media_objects_delete_admin on storage.objects
  for delete to authenticated
  using (bucket_id = 'charity-media' and (select public.is_admin()));
