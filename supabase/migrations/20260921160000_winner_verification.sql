-- =============================================================================
-- GATHER — 017: winner verification and payout tracking (Phase 7)
--
-- Winner rows themselves already exist (migration 006) and are already created atomically by
-- publish_draw() (migration 016). This migration adds the four state transitions PRD §09/§11
-- describe, each as an atomic, service-role-only function — the same shape as add_score(),
-- simulate_draw() and publish_draw(): a row lock, an explicit state check, then the write.
-- Domain rules stay in code (there is none here beyond the state machine itself); the database
-- guarantees nothing invalid is ever stored.
--
-- Lifecycle (verification_status): awaiting_proof -> pending_review -> approved | rejected
--   rejected -> (reopen) -> awaiting_proof            -- resubmission (DECISIONS D-021/D-037)
-- Lifecycle (payout_status): pending -> paid, once verification_status = 'approved'
--   (IMPLEMENTATION DECISION extending D-022, documented in DECISIONS.md: the PRD does not say
--   whether a payout may be marked paid before proof is approved; the schema itself deliberately
--   does not enforce it (see migration 006's comment on winners). This function is where the
--   ordering IS enforced, so it can be relaxed in one place if the owner decides otherwise.)
--
-- Proof BYTES are uploaded directly browser -> Supabase Storage under RLS (migration 009: the
-- owner of a winner record, into '<winner_id>/...', only while awaiting_proof). These functions
-- only ever handle METADATA and state — never file bytes — matching every other write in this
-- schema going through the service role (D-048).
-- =============================================================================

-- ---- register_winner_proof() ---------------------------------------------------------------
-- Records a proof screenshot the winner has ALREADY uploaded to storage (the API defers to the
-- storage RLS policy to decide WHETHER the upload itself was allowed; this function only trusts
-- that an object at the given path exists, and that it sits under the caller's own winner
-- folder — belt and braces alongside the winner_proofs_path_under_winner CHECK). Idempotent for
-- an exact repeat of an already-registered path (a client retry), so a duplicate network
-- request can never be reported as a failure.
create function public.register_winner_proof(
  p_winner_id    uuid,
  p_user_id      uuid,
  p_storage_path text
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_status public.verification_status;
begin
  select verification_status into v_status
    from public.winners
   where id = p_winner_id and user_id = p_user_id
     for update;
  if not found then
    raise exception 'No such winner' using errcode = '23503';
  end if;

  -- A client retry of a call that already succeeded: nothing left to do.
  if exists (
    select 1 from public.winner_proofs
     where winner_id = p_winner_id and storage_path = p_storage_path
  ) then
    return;
  end if;

  if v_status <> 'awaiting_proof' then
    raise exception 'This winner is not awaiting proof' using errcode = 'GS007';
  end if;
  if p_storage_path !~ ('^' || p_winner_id::text || '/') then
    raise exception 'The storage path must be inside the winner''s own folder' using errcode = 'GS009';
  end if;
  if not exists (
    select 1 from storage.objects where bucket_id = 'winner-proofs' and name = p_storage_path
  ) then
    raise exception 'No such storage object; upload the file before registering it' using errcode = 'GS008';
  end if;

  insert into public.winner_proofs (winner_id, storage_path) values (p_winner_id, p_storage_path);
  update public.winners set verification_status = 'pending_review' where id = p_winner_id;
end;
$$;

revoke all on function public.register_winner_proof(uuid, uuid, text) from public;
revoke all on function public.register_winner_proof(uuid, uuid, text) from anon, authenticated;
grant execute on function public.register_winner_proof(uuid, uuid, text) to service_role;

-- ---- reopen_winner_proof() ------------------------------------------------------------------
-- Re-opens a REJECTED winner for resubmission: moves verification back to awaiting_proof, which
-- is what the storage RLS policy requires before the browser may upload again (migration 009).
-- Winner-triggered ("let me try again"), not automatic: `rejected` stays a real, queryable state
-- until the winner acts (DECISIONS D-021/D-037). `reviewed_at`/`reviewed_by`/`review_note` are
-- cleared back to "nothing decided yet" (the winners_review_timestamp CHECK requires this: those
-- three columns describe the CURRENT decision, not history — the permanent record of who
-- rejected what, and why, lives in admin_audit_log, written by the API alongside this call).
create function public.reopen_winner_proof(p_winner_id uuid, p_user_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_status public.verification_status;
begin
  select verification_status into v_status
    from public.winners
   where id = p_winner_id and user_id = p_user_id
     for update;
  if not found then
    raise exception 'No such winner' using errcode = '23503';
  end if;
  if v_status <> 'rejected' then
    raise exception 'Only a rejected winner can be reopened for resubmission' using errcode = 'GS010';
  end if;

  update public.winners
     set verification_status = 'awaiting_proof', reviewed_by = null, reviewed_at = null, review_note = null
   where id = p_winner_id;
end;
$$;

revoke all on function public.reopen_winner_proof(uuid, uuid) from public;
revoke all on function public.reopen_winner_proof(uuid, uuid) from anon, authenticated;
grant execute on function public.reopen_winner_proof(uuid, uuid) to service_role;

-- ---- review_winner() -------------------------------------------------------------------------
-- An admin's approve/reject decision (PRD §09 DRW-11). Only ever decides a submission that is
-- actually PENDING REVIEW — not a fresh awaiting_proof winner (nothing submitted yet) and not
-- one already decided (an approved or rejected decision is not silently overwritten; the audit
-- log records who decided what and when).
create function public.review_winner(
  p_winner_id uuid,
  p_admin_id  uuid,
  p_decision  public.verification_status,
  p_note      text
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_status public.verification_status;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected' using errcode = '22023';
  end if;

  select verification_status into v_status from public.winners where id = p_winner_id for update;
  if not found then
    raise exception 'No such winner' using errcode = '23503';
  end if;
  if v_status <> 'pending_review' then
    raise exception 'This winner is not pending review' using errcode = 'GS011';
  end if;

  update public.winners
     set verification_status = p_decision,
         reviewed_by = p_admin_id,
         reviewed_at = now(),
         review_note = p_note
   where id = p_winner_id;
end;
$$;

revoke all on function public.review_winner(uuid, uuid, public.verification_status, text) from public;
revoke all on function public.review_winner(uuid, uuid, public.verification_status, text) from anon, authenticated;
grant execute on function public.review_winner(uuid, uuid, public.verification_status, text) to service_role;

-- ---- mark_winner_paid() --------------------------------------------------------------------
-- "Admin can mark payouts as completed" (PRD §11 ADM-06); states Pending -> Paid (DRW-12).
-- IMPLEMENTATION DECISION (extends D-022): a payout may only be marked paid once verification
-- is 'approved' — the schema itself does not force this (see migration 006), so it is enforced
-- HERE, in one place, in case the owner later decides otherwise. Idempotent: marking an
-- already-paid winner paid again is a safe no-op (mirrors publish_draw()'s idempotency), so a
-- retried admin click can never report a false failure or move paid_at/paid_by.
create function public.mark_winner_paid(p_winner_id uuid, p_admin_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_verification public.verification_status;
  v_payout       public.payout_status;
begin
  select verification_status, payout_status into v_verification, v_payout
    from public.winners where id = p_winner_id for update;
  if not found then
    raise exception 'No such winner' using errcode = '23503';
  end if;
  if v_payout = 'paid' then
    return;
  end if;
  if v_verification <> 'approved' then
    raise exception 'A payout can only be marked paid once verification is approved' using errcode = 'GS012';
  end if;

  update public.winners
     set payout_status = 'paid', paid_at = now(), paid_by = p_admin_id
   where id = p_winner_id;
end;
$$;

revoke all on function public.mark_winner_paid(uuid, uuid) from public;
revoke all on function public.mark_winner_paid(uuid, uuid) from anon, authenticated;
grant execute on function public.mark_winner_paid(uuid, uuid) to service_role;
