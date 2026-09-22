-- =============================================================================
-- GATHER — 015: the database side of the Stripe integration (Phase 5)
--
-- Stripe tells us what happened through signed webhooks (DECISIONS D-068). Two things about webhooks make
-- plain inserts and updates unsafe, so this migration adds the small amount of SQL that makes them safe:
--   * events can arrive OUT OF ORDER  -> `subscriptions.provider_event_at` + `apply_provider_subscription()`
--   * events can be REPLAYED / RACE   -> `record_subscription_payment()` is idempotent and atomic
--     (a payment and its charity contribution are written together or not at all).
-- It also states two DIFFERENT questions explicitly, side by side, so they cannot be confused (D-068):
--   * ACCESS      "may this user use the subscriber features right now?"  -> is_active_subscriber()
--   * ELIGIBILITY "may this user start ANOTHER checkout?"                 -> has_open_subscription()
-- and makes payment and charity-contribution history append-only (owner decision D-070): what was collected, and the
-- charity snapshot it was attributed to, are never rewritten.
-- Every payment also records which period it paid for, which the draw engine will need for yearly plans (D-015).
--
-- Both functions take arbitrary user ids, so — like add_score() — they are executable ONLY by the service
-- role. Money stays integer minor units, percentages basis points (D-046).
-- =============================================================================

-- ---- subscriptions: when did Stripe say this? ----------------------------------------------
-- The `created` time of the Stripe event whose state is stored here. An older event never overwrites a newer
-- one. Nullable: rows that pre-date the Stripe integration have none.
alter table public.subscriptions add column provider_event_at timestamptz;

-- ---- payments: the period a payment paid for -----------------------------------------------
-- From the invoice line. Kept per payment because subscriptions.current_period_* moves on every renewal, so
-- without this a yearly payment's coverage would be lost (D-015). NULL for donations.
alter table public.payments
  add column period_start timestamptz,
  add column period_end   timestamptz,
  add constraint payments_period_order
    check (period_start is null or period_end is null or period_end > period_start);

-- ---- ACCESS: is_active_subscriber() ----------------------------------------------------------
-- PRD §04 SUB-05 requires a real-time subscription status check on every authenticated request. This function IS that
-- check: it reads the current local state — kept in step with Stripe by webhooks — on every call.
--
-- OWNER decision D-070 (2026-09-21): a user has access exactly while their subscription is `active` AND the paid
-- period we have recorded has not ended:
--     status = 'active'  and  current_period_end > now()
-- There is NO tolerance and NO grace: nothing here grants access because a webhook is late, and nothing after the
-- recorded period ends. What that means in practice, stated so nobody is surprised:
--   * `past_due`, `unpaid`, `paused`, cancelled, lapsed and pending subscriptions have no access (their local status
--     is not 'active'); an overdue payment loses access at once, before any retry succeeds;
--   * cancelling "at period end" keeps access until `current_period_end`, then it stops — even if the "deleted"
--     webhook is late;
--   * at a renewal boundary access resumes when the renewal (the new period) is RECORDED, normally seconds after
--     Stripe advances it; during a webhook outage a user is cut off at the end of the period we last recorded.
--     This fails closed, by owner decision: Stripe is NOT asked as a fallback when the recorded period has ended.
-- Provisional pending D-026 — this function is the one place to change the rule.
create or replace function public.is_active_subscriber(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.subscriptions s
    where s.user_id = p_user_id
      and s.status = 'active'
      and s.current_period_end > now()
  );
$$;

-- ---- ELIGIBILITY: has_open_subscription() -----------------------------------------------------
-- "Open" = a subscription Stripe could still bill or bring back, so a SECOND one must not be started: it could
-- charge the user twice. This is deliberately NOT the access rule above. The two differ exactly where they should:
--
--   local status / Stripe status        access (is_active_subscriber)   open (blocks a new checkout)
--   active (period current)             yes                             yes
--   active (period ended, no renewal)   NO                              yes  (Stripe may still bill it)
--   pending  / incomplete               no                              yes
--   lapsed   / past_due                 NO                              YES  (Stripe is retrying it)
--   lapsed   / unpaid, paused           no                              yes  (it can be reactivated)
--   lapsed   / incomplete_expired       no                              no   (it never became active: over)
--   cancelled / canceled                no                              no   (over)
--
-- It is defined by what is OVER at Stripe (`canceled`, `incomplete_expired`), so any status Stripe adds later counts
-- as open — failing safe against a double charge. A row with no provider status (created before Stripe existed)
-- falls back to the local status.
create function public.has_open_subscription(p_user_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.subscriptions s
    where s.user_id = p_user_id
      and (
        s.status in ('pending', 'active')
        or (s.provider_status is not null and s.provider_status not in ('canceled', 'incomplete_expired'))
      )
  );
$$;

revoke all on function public.has_open_subscription(uuid) from public;
revoke all on function public.has_open_subscription(uuid) from anon, authenticated;
grant execute on function public.has_open_subscription(uuid) to service_role;

-- ---- payment history is append-only ---------------------------------------------------------
-- A payment records money that was actually collected. Once it has SUCCEEDED its facts are frozen: the amount, the
-- currency, who paid, which subscription and invoice it belongs to, when it was paid, and the period it paid for never
-- change, and it can never be deleted. The only things that may still happen to a payment are:
--   * an attempt that has not succeeded (pending / failed) evolving — a failed attempt becoming the success when the
--     invoice is retried and paid (its amount, state, paid_at, intent and period may be set);
--   * a succeeded payment becoming `refunded` (state only) — a refund is a new fact about the same money, and the
--     charity contribution it produced stays as it was (D-026 decides what a refund means for a charity's total).
-- Who paid, the kind, the subscription, the currency and the Stripe invoice never change, in any state. As with the
-- audit log, removing dev/test rows needs the database owner (`alter table … disable trigger payments_history_guard`).
create function public.guard_payments_history()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'payments is append-only: a payment is history'
      using errcode = 'integrity_constraint_violation';
  end if;

  if new.user_id <> old.user_id
     or new.kind <> old.kind
     or new.subscription_id is distinct from old.subscription_id
     or new.currency <> old.currency
     or new.stripe_invoice_id is distinct from old.stripe_invoice_id then
    raise exception 'A payment''s owner, kind, subscription, currency and invoice never change'
      using errcode = 'integrity_constraint_violation';
  end if;

  if old.state in ('succeeded', 'refunded') then
    if not (new.state = old.state or (old.state = 'succeeded' and new.state = 'refunded')) then
      raise exception 'A payment that has succeeded can only become refunded'
        using errcode = 'integrity_constraint_violation';
    end if;
    if new.amount_minor <> old.amount_minor
       or new.paid_at is distinct from old.paid_at
       or new.stripe_payment_intent_id is distinct from old.stripe_payment_intent_id
       or new.period_start is distinct from old.period_start
       or new.period_end is distinct from old.period_end then
      raise exception 'The amount, date and period of money already collected never change'
        using errcode = 'integrity_constraint_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger payments_history_guard
  before update or delete on public.payments
  for each row execute function public.guard_payments_history();

-- ---- charity contribution history is append-only ---------------------------------------------
-- A contribution records the charity, percentage, basis and amount that applied WHEN THE PAYMENT WAS MADE (owner
-- decision D-070).
-- Archiving a charity, or the user changing their charity or percentage, must never change it — and neither may a
-- bug or a careless script. So a row can be neither updated nor deleted (the same rule as the audit log). A refund
-- (D-026, open) will have to be recorded as a new fact, not by editing this one. Removing dev/test rows needs the
-- database owner (`alter table … disable trigger charity_contributions_append_only`).
create function public.guard_charity_contributions_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'charity_contributions is append-only: a payment''s charity snapshot is history'
    using errcode = 'integrity_constraint_violation';
end;
$$;

create trigger charity_contributions_append_only
  before update or delete on public.charity_contributions
  for each row execute function public.guard_charity_contributions_append_only();

-- ---- apply_provider_subscription() ----------------------------------------------------------
-- Upserts the local copy of a Stripe subscription from ONE event, ignoring events older than the state
-- already stored.
--   'applied'  the row was inserted or updated
--   'stale'    a newer event was already applied; nothing changed
--   'conflict' the user already has ANOTHER pending/active subscription (D-044); nothing changed
-- SQLSTATE GS003: the Stripe subscription is already recorded for a different user (data corruption guard).
create function public.apply_provider_subscription(
  p_user_id               uuid,
  p_plan_id               uuid,
  p_stripe_subscription_id text,
  p_status                public.subscription_status,
  p_provider_status       text,
  p_period_start          timestamptz,
  p_period_end            timestamptz,
  p_cancel_at_period_end  boolean,
  p_cancelled_at          timestamptz,
  p_ended_at              timestamptz,
  p_event_at              timestamptz
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  existing     public.subscriptions%rowtype;
  v_constraint text;
begin
  loop
    select * into existing
    from public.subscriptions
    where stripe_subscription_id = p_stripe_subscription_id
    for update;

    if found then
      if existing.user_id <> p_user_id then
        raise exception 'Stripe subscription % belongs to another user', p_stripe_subscription_id
          using errcode = 'GS003';
      end if;
      if existing.provider_event_at is not null and existing.provider_event_at > p_event_at then
        return 'stale';
      end if;
      begin
        update public.subscriptions
           set plan_id              = p_plan_id,
               status               = p_status,
               provider_status      = p_provider_status,
               current_period_start = p_period_start,
               current_period_end   = p_period_end,
               cancel_at_period_end = p_cancel_at_period_end,
               cancelled_at         = p_cancelled_at,
               ended_at             = p_ended_at,
               provider_event_at    = p_event_at
         where id = existing.id;
        return 'applied';
      exception when unique_violation then
        return 'conflict'; -- moving to pending/active while another live subscription exists
      end;
    else
      begin
        insert into public.subscriptions
          (user_id, plan_id, status, provider_status, stripe_subscription_id, current_period_start,
           current_period_end, cancel_at_period_end, cancelled_at, ended_at, provider_event_at)
        values
          (p_user_id, p_plan_id, p_status, p_provider_status, p_stripe_subscription_id, p_period_start,
           p_period_end, p_cancel_at_period_end, p_cancelled_at, p_ended_at, p_event_at);
        return 'applied';
      exception when unique_violation then
        get stacked diagnostics v_constraint = constraint_name;
        if v_constraint = 'subscriptions_one_current_per_user' then
          return 'conflict';
        end if;
        -- Same Stripe subscription inserted concurrently by another delivery: go round and update it.
      end;
    end if;
  end loop;
end;
$$;

revoke all on function public.apply_provider_subscription(uuid, uuid, text, public.subscription_status, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz, timestamptz) from public;
revoke all on function public.apply_provider_subscription(uuid, uuid, text, public.subscription_status, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz, timestamptz) from anon, authenticated;
grant execute on function public.apply_provider_subscription(uuid, uuid, text, public.subscription_status, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz, timestamptz) to service_role;

-- ---- record_subscription_payment() ----------------------------------------------------------
-- Records one Stripe invoice as a `payments` row and, once it has succeeded, its `charity_contributions` row —
-- atomically and idempotently (keyed by the Stripe invoice id; replaying it changes nothing).
--   * a failed attempt may later become succeeded (the invoice is retried and paid);
--   * a succeeded payment is never downgraded by a late "failed" event;
--   * a succeeded payment MUST carry its contribution (SQLSTATE GS004): money is never left unattributed.
-- The percentage, basis and amount are the SNAPSHOT applied at payment time, so later changes to the user's
-- charity or percentage never rewrite history (PRD §11 contribution totals). HOW the amount is computed is
-- application code (D-069); the table constraints still guard the invariants (>= 10%, amount <= basis).
-- SQLSTATE GS003: the subscription or an existing payment belongs to a different user.
create function public.record_subscription_payment(
  p_user_id                  uuid,
  p_subscription_id          uuid,
  p_stripe_invoice_id        text,
  p_stripe_payment_intent_id text,
  p_amount_minor             bigint,
  p_currency                 text,
  p_state                    public.payment_state,
  p_paid_at                  timestamptz,
  p_period_start             timestamptz,
  p_period_end               timestamptz,
  p_charity_id               uuid,
  p_percentage_bps           integer,
  p_basis_minor              bigint,
  p_contribution_minor       bigint
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_owner          uuid;
  v_payment        public.payments%rowtype;
  v_payment_id     uuid;
  v_created        boolean := false;
  v_final_state    public.payment_state;
  v_contribution   boolean := false;
  v_rows           integer;
begin
  select user_id into v_owner from public.subscriptions where id = p_subscription_id;
  if v_owner is distinct from p_user_id then
    raise exception 'Subscription % does not belong to the paying user', p_subscription_id
      using errcode = 'GS003';
  end if;

  if p_state = 'succeeded'
     and (p_charity_id is null or p_percentage_bps is null or p_basis_minor is null or p_contribution_minor is null) then
    raise exception 'A succeeded subscription payment must carry its charity contribution'
      using errcode = 'GS004';
  end if;

  select * into v_payment from public.payments where stripe_invoice_id = p_stripe_invoice_id for update;

  if not found then
    insert into public.payments
      (user_id, kind, subscription_id, amount_minor, currency, state, stripe_payment_intent_id,
       stripe_invoice_id, paid_at, period_start, period_end)
    values
      (p_user_id, 'subscription', p_subscription_id, p_amount_minor, p_currency, p_state,
       p_stripe_payment_intent_id, p_stripe_invoice_id, p_paid_at, p_period_start, p_period_end)
    returning id, state into v_payment_id, v_final_state;
    v_created := true;
  else
    if v_payment.user_id <> p_user_id then
      raise exception 'Invoice % is already recorded for a different user', p_stripe_invoice_id
        using errcode = 'GS003';
    end if;
    v_payment_id  := v_payment.id;
    v_final_state := v_payment.state;
    -- Never downgrade money already received; otherwise the latest attempt wins.
    if v_payment.state not in ('succeeded', 'refunded') then
      update public.payments
         set state                    = p_state,
             amount_minor             = p_amount_minor,
             stripe_payment_intent_id = coalesce(p_stripe_payment_intent_id, stripe_payment_intent_id),
             paid_at                  = p_paid_at,
             period_start             = p_period_start,
             period_end               = p_period_end
       where id = v_payment.id
      returning state into v_final_state;
    end if;
  end if;

  if v_final_state = 'succeeded' and p_charity_id is not null then
    insert into public.charity_contributions
      (user_id, charity_id, payment_id, source, currency, amount_minor, basis_minor, percentage_bps)
    values
      (p_user_id, p_charity_id, v_payment_id, 'subscription', p_currency, p_contribution_minor,
       p_basis_minor, p_percentage_bps)
    on conflict (payment_id) do nothing;
    get diagnostics v_rows = row_count;
    v_contribution := v_rows > 0;
  end if;

  return jsonb_build_object(
    'payment_id', v_payment_id,
    'payment_created', v_created,
    'contribution_created', v_contribution
  );
end;
$$;

revoke all on function public.record_subscription_payment(uuid, uuid, text, text, bigint, text, public.payment_state, timestamptz, timestamptz, timestamptz, uuid, integer, bigint, bigint) from public;
revoke all on function public.record_subscription_payment(uuid, uuid, text, text, bigint, text, public.payment_state, timestamptz, timestamptz, timestamptz, uuid, integer, bigint, bigint) from anon, authenticated;
grant execute on function public.record_subscription_payment(uuid, uuid, text, text, bigint, text, public.payment_state, timestamptz, timestamptz, timestamptz, uuid, integer, bigint, bigint) to service_role;
