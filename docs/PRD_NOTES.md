# PRD Notes

This file separates **what the PRD says**, **what the PRD does not say**, and **what the
development team assumes or recommends**. Those three things must never be blended: only Section 2
is a requirement.

- Section 0 — Source, reconciliation with the actual PDF, and known limitations
- Section 1 — Discrepancies found between the PDF and the earlier (Phase 0) notes
- Section 2 — Explicit PRD requirements
- Section 3 — PRD ambiguities and gaps (each linked to a decision in
  [DECISIONS.md](./DECISIONS.md))
- Section 4 — Development assumptions and recommendations (**not** requirements)
- Section 5 — Database traceability: every database-affecting requirement classified A / B / C
- Appendix A — Constraints from the project brief (not PRD text)

## 0. Source and known limitations

- **Source of truth.** The _Digital Heroes Product Requirements Document — Level 1_, version 1.0,
  March 2026 (`docs/Digital-Heroes-PRD.pdf`). The PDF is **local only** and git-ignored; it is not
  copied into the repository. This file summarises it and cites its section numbers (§).
- **How it was read in Phase 1.** All 13 physical pages were read. The environment had no PDF
  tooling, so text was extracted with `pypdf` and the layout-sensitive pages (2, 4, 5, 6, 8, 9) were
  additionally rendered to images with PyMuPDF and read visually, to confirm which bullet belongs
  under which column heading. Both tools were installed in a throw-away virtual environment outside
  the project; nothing was added to the repository. Only the cover page contains an image.
- **Missing PRD pages (confirmed).** The table of contents lists §13 _Technical requirements_ and §14
  _Scalability considerations_ on page 11. The PDF has **13 pages whose footers read `N / 14`, and
  the page numbered 11 / 14 is not in the file** (footers run …09, 10, 12, 13, 14). Their contents
  are unknown and have **not** been invented. Consequently the project has _no_ PRD-defined
  non-functional requirements (performance, scale, availability, security, compliance, browser
  support). Anything in the architecture docs on those topics is a development recommendation only.
  The only scalability-related text in the PDF is the evaluation criterion "Scalability thinking —
  extensibility of the codebase and data structures" (§16), which is a grading criterion, not a
  requirement. Tracked as decision D-032.
- **Minor internal inconsistencies in the PDF (harmless).** The contents page says "Sixteen
  sections" although a §17 exists; the contents page lists §02 as _Core objectives_ while page 2
  labels the document summary "§ 02" and page 3 labels core objectives "§ 02".
- **ID scheme.** IDs such as `SCR-04` are assigned by the development team purely so requirements can
  be referenced in tests, code comments and decisions. They are not numbering from the PRD.

## 1. Discrepancies between the PDF and the Phase 0 notes

The Phase 0 notes were written from a summary, before the PDF was available. Comparing them with the
PDF found the following. Each has been corrected below.

| #     | Phase 0 notes said                                           | The PDF actually says                                                                                                                                                                              | Effect                                                                                                                  |
| ----- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| PD-01 | "A draw contains 5 numbers" was an explicit requirement      | It never says this. It lists "5-number match / 4-number match / 3-number match" as draw types (§06).                                                                                               | Downgraded to **derived (B)**: a 5-number match implies a 5-number draw. See DRW-02 (derived) in Section 5.             |
| PD-02 | Users' scores are matched against the draw's numbers         | It never says so. It only says scores are entered, the draw has 5/4/3-number matches, and the algorithmic draw is "weighted by score frequency".                                                   | Still **undecided (C)**, now stated more strongly (AMB-01, D-011). The schema stores a per-entry number snapshot.       |
| PD-03 | Algorithmic mode is completely undefined                     | "Algorithmic — weighted by score frequency"; "Random — standard lottery-style" (§06).                                                                                                              | Partly resolved: the weighting **basis** is score frequency. Direction and population remain open (AMB-03, D-013).      |
| PD-04 | Subscription status is "validated in real time"              | "Real-time subscription status check **on every authenticated request**" (§04).                                                                                                                    | Resolved: the check happens per request (SUB-05, D-039). _How_ (live provider call vs synchronised state) stays open.   |
| PD-05 | "Jackpot can roll over"; unclear whether other tiers do      | The table marks **only 5-match as rolling over**; 4- and 3-match are "No". Wording is "rollover **if unclaimed**" (§06/§07).                                                                       | Which tiers roll over is **explicit (A)**. What "unclaimed" means and where 4/3 money goes remain open (AMB-05, D-019). |
| PD-06 | Scores could be edited; deletion unspecified                 | "an existing entry may only be **edited or deleted**" (§05 note).                                                                                                                                  | Deletion is **explicit** (SCR-08). Partly resolves AMB-15.                                                              |
| PD-07 | Admin permissions unknown                                    | Admin can "view and edit user profiles", "**edit golf scores**", "manage subscriptions", "**mark payouts as completed**", add/edit/**delete** charities and "manage content and media" (§03, §11). | Capability list is **explicit**. Granularity of permissions is still open (AMB-18, D-023).                              |
| PD-08 | Role capabilities not listed                                 | §03 lists them, e.g. a public visitor can "**initiate subscription**"; a subscriber can "select charity recipient", "upload winner proof".                                                         | Added as ROL-02..04.                                                                                                    |
| PD-09 | "Prize pool depends on active subscribers"                   | "**A fixed portion of each subscription** contributes to the prize pool"; tiers are calculated "based on active subscriber count" (§07).                                                           | Explicit, but "fixed portion" may be a percentage **or** a fixed amount; the schema supports both (AMB-08, D-014).      |
| PD-10 | Dashboard shows "subscription status and renewal date"       | "active / inactive / renewal date" (§10).                                                                                                                                                          | Wording refined (DSH-01).                                                                                               |
| PD-11 | "Responsive" and "error handling" are mandatory deliverables | §15 lists live site, user panel, admin panel, database and source code. Responsive design and error handling appear only in the §16 **testing checklist**.                                         | Moved to the evaluation checklist (Section 2, EVAL-01). They remain in scope as things that will be tested.             |
| PD-12 | (not recorded)                                               | "**CTA:** Subscribe button / flow must be prominent and persuasive" (§12).                                                                                                                         | Added as UX-06.                                                                                                         |
| PD-13 | (not recorded)                                               | "Verification process applies to **winners only**" (§09).                                                                                                                                          | Added to DRW-10.                                                                                                        |
| PD-14 | (not recorded)                                               | "Simulation before publish" is listed under draw operations (§06).                                                                                                                                 | Whether simulation is a **mandatory** step before publishing is unclear (AMB-04).                                       |

No Phase 0 requirement was found to be _contradicted_ outright except PD-01 (presented as explicit
but only derivable) and PD-11 (deliverable vs checklist).

## 2. Explicit PRD requirements

Citations are to PDF sections. Only what the PDF states is listed here.

### Roles (§03)

- **ROL-01** Three roles: public visitor, registered subscriber, administrator — "a defined boundary
  of access".
- **ROL-02** Public visitor: view platform concept; explore listed charities; understand draw
  mechanics; initiate subscription.
- **ROL-03** Registered subscriber: manage profile and settings; enter/edit golf scores; select
  charity recipient; view participation and winnings; upload winner proof.
- **ROL-04** Administrator: manage users and subscriptions; configure and run draws; manage charity
  listings; verify winners and payouts; access reports and analytics.

### Subscription and payment (§04)

- **SUB-01** Monthly plan and yearly plan (discounted rate).
- **SUB-02** Gateway: Stripe (or an equivalent PCI-compliant provider).
- **SUB-03** Non-subscribers receive restricted access to platform features.
- **SUB-04** Handles renewal, cancellation and lapsed-subscription states.
- **SUB-05** Real-time subscription status check on every authenticated request.

### Charity (§08)

- **CHR-01** Users select a charity at signup.
- **CHR-02** Minimum contribution: 10% of subscription fee.
- **CHR-03** Users may voluntarily increase their charity percentage.
- **CHR-04** Independent donation option, not tied to gameplay.
- **DIR-01** Charity listing page with search and filter.
- **DIR-02** Charity profiles: description, images, and upcoming events such as golf days.
- **DIR-03** Featured charity section on the homepage.

### Scores (§05)

- **SCR-01** Users must enter their last 5 golf scores.
- **SCR-02** Score range 1–45 (Stableford format).
- **SCR-03** Each score must include a date.
- **SCR-04** Only one score entry is permitted per date; duplicates for the same date are not allowed.
- **SCR-05** Only the latest 5 scores are retained at any time.
- **SCR-06** A new score replaces the oldest stored score automatically.
- **SCR-07** Scores display in reverse chronological order (most recent first).
- **SCR-08** An existing entry (for a date) may be edited or deleted.

### Draw and prize pool (§06, §07)

Requirement IDs are unchanged from Phase 0 so existing references stay valid. **DRW-02 is reserved:**
the Phase 0 notes listed "a draw contains 5 numbers" as explicit, but the PDF never says it (PD-01);
it is now a _derived_ rule in Section 5.

- **DRW-01** Operations: monthly cadence (§06).
- **DRW-03** Draw types: 5-number match, 4-number match, 3-number match — prize tiers for each.
- **DRW-04** Draw logic: Random (standard lottery-style) or Algorithmic (weighted by score
  frequency). The admin configures the mode (§11).
- **DRW-05** Admin controls publishing; simulation before publish; the admin can run simulations and
  publish results.
- **DRW-06** Rollover: 5-match **Yes — jackpot** ("carries forward if unclaimed"); 4-match **No**;
  3-match **No**.
- **DRW-07** A fixed portion of each subscription contributes to the prize pool; each pool tier is
  calculated automatically based on active subscriber count. Distribution is pre-defined and enforced
  automatically.
- **DRW-08** Prizes are split equally among multiple winners in the same tier.
- **DRW-09** Pool shares: 5-number match 40%, 4-number match 35%, 3-number match 25%.

### Winner verification (§09)

- **DRW-10** Verification applies to winners only; proof is a screenshot of scores from the golf
  platform.
- **DRW-11** Admin review: approve or reject the submission.
- **DRW-12** Payment states: Pending → Paid.

### User dashboard (§10) — must include all of the following

- **DSH-01** Subscription status — active / inactive / renewal date.
- **DSH-02** Score entry and edit interface.
- **DSH-03** Selected charity and contribution percentage.
- **DSH-04** Participation summary — draws entered, upcoming draws.
- **DSH-05** Winnings overview — total won and current payment status.

### Admin dashboard (§11)

- **ADM-01** User management: view and edit user profiles; edit golf scores; manage subscriptions.
- **ADM-02** Draw management.
- **ADM-03** Configure draw logic (random vs algorithm).
- **ADM-04** Run simulations; publish results.
- **ADM-05** Charity management: add, edit, delete charities; manage content and media.
- **ADM-06** Winners management: view full winners list; verify submissions; mark payouts as
  completed.
- **ADM-07** Reports and analytics: total users; total prize pool; charity contribution totals; draw
  statistics.

### UI / UX (§12)

- **UX-01** "Feel, not fairway": must not resemble a traditional golf website; emotion-driven,
  leading with charitable impact, not sport.
- **UX-02** Clean, modern, motion-enhanced interface.
- **UX-03** Avoid golf clichés — fairways, plaid, club imagery — as the primary design language.
- **UX-04** Homepage clearly communicates what the user does, how they win, charity impact, and the
  call to action.
- **UX-05** Subtle transitions and micro-interactions throughout.
- **UX-06** The subscribe button/flow must be prominent and persuasive.

### Deliverables and evaluation (§15, §16)

- **DEL-01** Live website: fully deployed, publicly accessible URL.
- **DEL-02** User panel: test credentials; signup / login / score entry / dashboard all functional.
- **DEL-03** Admin panel: admin credentials; user management, draw system, charities, winner
  verification.
- **DEL-04** Database: backend connected (e.g. Supabase) with proper schema.
- **DEL-05** Source code: clean, structured, well-commented.
- **DEL-06** Deployment constraints: a **new** Vercel account and a **new** Supabase project (not
  personal/existing); environment variables properly configured.
- **EVAL-01** The testing checklist includes: signup and login; subscription flow (monthly and
  yearly); score entry with 5-score rolling logic; draw system logic and simulation; charity selection
  and contribution calculation; winner verification flow and payout tracking; dashboard modules; admin
  panel; data accuracy across modules; responsive design on mobile and desktop; error handling and
  edge cases.
- **EVAL-02** Evaluation criteria: requirements interpretation; system design (architecture and data
  modelling); UI/UX creativity; data handling (score logic, draw engine, prize calculations);
  scalability thinking (extensibility of the codebase and data structures); problem-solving on
  ambiguous requirements. The PDF states that "ambiguity is part of the test".

## 3. PRD ambiguities and gaps

Each item lists what is unclear and why it matters. **None of these has been resolved by
implementation.** Where the PDF partly answered an item, the answered part is stated. The linked
decision in [DECISIONS.md](./DECISIONS.md) must be resolved before code encodes a behaviour.

### Draw mechanics

- **AMB-01 What "matching 5/4/3 numbers" means.** The PDF never states that a user's scores are the
  numbers being matched (PD-02), nor how matching works: set membership vs position; whether a
  repeated score value counts once or twice; whether "exact" or "at least" matches define a tier (does
  a 5-number match also count as a 3-number match?); whether the draw may contain duplicate numbers.
  → D-011
- **AMB-02 Number range and generation.** No range for draw numbers (scores are 1–45, which suggests
  but does not state 1–45). "Standard lottery-style" suggests unique numbers drawn without replacement
  but does not define it. → D-012
- **AMB-03 Algorithmic weighting.** _Partly answered:_ "weighted by score frequency". Open: frequency
  of which scores (all users', current entries, historical); whether frequent or rare numbers are
  favoured; how weights turn into selection; whether scores influence the random mode at all (the PDF
  suggests not). → D-013
- **AMB-04 Simulation semantics.** Whether a simulation uses live data or a snapshot, whether it is
  stored, repeated, or affects rollover; whether publishing must reproduce the simulated result;
  whether simulation is a **mandatory** step before publish; whether a published draw can be
  corrected. → D-018
- **AMB-05 Rollover details.** _Partly answered:_ only 5-match rolls over. Open: "unclaimed" could
  mean no winner _or_ a winner who never completes verification; whether rolled-over money carries only
  to the next month; any cap; and what happens to the 4- and 3-match shares when those tiers have no
  winners (they do not roll over, but the PDF does not say where the money goes). → D-019
- **AMB-06 Equal split remainder.** Winners split "equally", but integer minor units can leave a
  remainder. → D-020
- **AMB-07 Draw cadence, cutoff and timezone.** No day or time for the draw, the score/entry cutoff,
  or the timezone defining "month". Unclear whether an admin triggers each draw or it is scheduled, and
  whether scores added after the cutoff count. → D-017

### Prize pool and money

- **AMB-08 Exact prize-pool amount.** _Partly answered:_ "a fixed portion of each subscription". Open:
  whether that portion is a percentage of the fee or a fixed amount per subscription; its value; and
  whether it is measured before or after provider fees and the charity share. → D-014
- **AMB-09 Yearly plans in monthly pools.** How a yearly payment contributes to monthly pools (spread
  over 12 months, counted at payment time, …). → D-015 _(**Owner decision D-070, an implementation rule and not a PRD requirement:** a yearly payment funds the pool by allocating
  1/12 of the applicable pool basis to each monthly draw it covers. Not built — there is no draw engine; every payment
  records its amount, currency and covered period.)_
- **AMB-10 Plan pricing and currency.** Prices, the size of the yearly discount, currency, tax/VAT and
  any trial are not stated. → D-024 _(**Owner decision D-070:** prices and currency are configuration — Stripe prices and `plans` rows — not PRD
  requirements and not code; the values are still to be chosen. Only "yearly is cheaper than 12 monthly" is enforced, D-067.)_
- **AMB-11 Charity contribution mechanics.** "10% of subscription fee": gross or net of provider fees
  and taxes; rounding; how it applies to yearly plans; any maximum; whether users can lower it back
  towards 10% or change charity later, and the effect on past payments; how independent donations work
  (amounts, minimums, whether visitors without an account can donate); how the platform actually pays
  charities out. → D-025 _(Phase 4: the owner decided the percentage may be any value from 10% up and can be
  raised **or lowered**, D-064. **Owner decision D-070:** the basis is the amount actually collected, before tax, after discounts/coupons, gross of Stripe's
  fees, rounded up to the smallest currency unit; payouts, refunds and donation rules remain open.)_

### Eligibility and subscription

- **AMB-12 Draw eligibility and users with fewer than five scores.** "Active subscriber" at draw time is
  undefined (status at cutoff? at publish?). §05 says users "must enter their last 5 scores" but not
  whether someone with 0–4 scores may enter a draw, or win the 5-match tier. → D-016
- **AMB-13 Subscription lifecycle.** _Partly answered:_ status is checked on every authenticated
  request. Open: cancellation immediate or at period end; what "lapsed" means and any grace period;
  plan switching; refunds/chargebacks; fate of a lapsed user's scores and pending winnings; whether the
  check queries the provider live or a synchronised copy. → D-026 _(Phase 5: **owner decision D-070** — no grace for `past_due`; access requires `status = 'active'` and `current_period_end >
now()`; fail closed, never a Stripe fallback. Implementation decisions, still provisional (D-068): cancellation at the end
  of the paid period; refunds/chargebacks not handled.)_
- **AMB-14 Scope of "restricted access".** Which features are blocked for non-subscribers and what
  registered but unsubscribed users can still see. → D-030

### Scores

- **AMB-15 Meaning of "oldest" and remaining edit rules.** _Partly answered by the PDF, then by the owner
  (D-061):_ editing and deletion are allowed; "oldest" means the earliest round **date**; a back-dated score
  older than all five is rejected. **Still open:** future dates; a maximum age; changing a score's date (Phase 3
  supports editing the value only). → D-027

### Winners and payment

- **AMB-16 Proof and claim rules.** No claim deadline; no rule for rejected proof (resubmit? how
  often?); no accepted file types or size; no statement of what the admin checks the screenshot
  against; unclaimed prizes. Only winners are verified (explicit). → D-021
- **AMB-17 Payout mechanism.** _Partly answered:_ admins "mark payouts as completed" and the states are
  Pending → Paid. Open: how money actually reaches winners; whether other states exist (rejected,
  expired); whether payment may be marked Paid before proof is approved. → D-022

### Administration and reporting

- **AMB-18 Admin permissions.** _Partly answered:_ a single Administrator role with the capabilities
  listed in §11. Open: whether finer permissions exist; how admins are created; audit expectations.
  → D-023
- **AMB-19 Analytics definitions.** The four report items are named (total users, total prize pool,
  charity contribution totals, draw statistics) but not defined: registered vs active users; per-draw vs
  cumulative pool and treatment of rollover; accrued vs paid-out contributions and inclusion of
  donations; which draw statistics. → D-029

### Accounts, content and platform

- **AMB-20 Authentication method.** Login method, email verification and password reset are not
  specified. → D-028 _(Phase 2 implements email + password as a
  provisional development choice, D-056; verification policy, reset and social login remain open.)_
- **AMB-21 Charity content model.** Filter dimensions (name? category? location?); what an event
  contains; where images come from; who edits profiles; how the spotlight charity is chosen and
  whether it is one or several. → D-033 _(Phase 4 builds a provisional design — tags + featured filters, several
  featured, admin-edited profiles, D-065 — still awaiting the owner.)_
  _CHR-01 "at signup" was resolved by the owner (2026-09-21, D-066): the signup form collects the charity, a
  pre-signup choice is carried through, and a selected, active charity is required to subscribe._
- **AMB-22 Missing technical and scalability pages.** See Section 0. → D-032
- **AMB-23 Legal and regulatory.** The PDF is silent on the regulatory treatment of a paid prize draw
  (age limits, eligibility by region, prize-draw or gambling rules), data protection/consent and tax on
  winnings. The development team makes no legal claims. → D-032
- **AMB-24 Hosting shape on Vercel.** The PDF requires a new Vercel account but not how an Express API
  is hosted there. → D-031

## 4. Development assumptions and recommendations

These are **not** PRD requirements. They are working assumptions or recommendations by the
development team, listed so nobody mistakes them for requirements. Each can be overridden.

- **ASM-01 Tooling.** npm workspaces, ESM, strict TypeScript, ESLint, Prettier and Vitest. No product
  impact. (D-001, D-008)
- **ASM-02 Money in integer minor units and percentages in basis points.** Applies the brief's
  constraint (D-003); the choice of basis points and of a currency stored on every monetary record is a
  development decision (D-046).
- **ASM-03 Business rules live in pure domain modules** with injected clock and random source, so draw
  and score rules are deterministic and testable.
- **ASM-04 PRD invariants are enforced twice**: in the domain module and in the database (score range,
  one score per date, 10% minimum, tier structure), so a bug in one layer cannot silently break them.
- **ASM-05 Published draws are immutable snapshots** (numbers, mode, entries, pool inputs, tier shares),
  so a result can be audited and reproduced. Implemented in the database (D-042).
- **ASM-06 Stripe webhooks are the synchronisation source** for subscription state, processed
  idempotently (`stripe_events` ledger exists). Recommended, pending D-026.
- **ASM-07 Plans, prices and pool portions are data/config, not hard-coded.** No plan rows exist; the
  pool portion, draw number range and charity cap live in `platform_settings` as NULL until decided.
  Any demo value must be labelled a placeholder.
- **ASM-08 Timestamps are UTC** (`timestamptz`). A draw's month is a plain date so no timezone is
  assumed (D-017).
- **ASM-09 Winner proof is a private storage object**, readable only by its owner and admins. Upload
  limits (10 MiB; PNG/JPEG/WebP) and charity-media limits (5 MiB) are **development defaults**, not PRD
  values (D-051).
- **ASM-10 Admin actions are audited** in an append-only log written by the API. Not in the PDF
  (D-052).
- **ASM-11 Test credentials come from a non-production seed**, clearly labelled, with Stripe test mode
  only. The Phase 1 seed contains only fictional charities (D-055).
- **ASM-12 Legal/regulatory review** of the prize-draw mechanics is recommended before any real launch
  (AMB-23).
- **ASM-13 Restrictive default for draw visibility.** Until D-030 is answered, published draws are
  visible to active subscribers and to users who were entered in that draw; drafts and simulations are
  admin-only (D-050).
- **ASM-14 Users cannot write directly to the database.** Apart from three profile preferences, every
  write goes through the API with the service role, which also applies business rules and audit (D-048).
- **ASM-15 Charity `tags`** are a free-form affordance for the unspecified "filter" (D-033); full-text
  search uses the `english` configuration. Neither is a PRD attribute.
- **ASM-17 Email + password authentication** through Supabase Auth is a provisional development choice
  (D-056). The signup UI works whether or not the project requires email confirmation.
- **ASM-18 Roles are read from the database on every request**, never from token claims, and admins can
  only be created by a service-role/SQL operation (D-057, D-059).
- **ASM-19 Score writes need an active subscription; reading one's own scores does not** (checked per
  request). Provisional pending D-030 (D-062).
- **ASM-20 No future-date or maximum-age rule for scores**, and editing changes a score's value only, not its
  date (D-027 remainder, D-062).
- **ASM-21 Charity directory and profiles are public; choosing a charity needs sign-in but no subscription.**
  Archived charities are invisible to the public and cannot be newly chosen; search is prefix-word full-text
  (D-065).
- **ASM-23 CHR-01 is read strictly (owner decision, D-066).** The charity is chosen **on the signup form**
  (pre-selected when the visitor chose one earlier), recorded from the signup data by the database, and changeable
  later on `/account/charity`. **Subscribing requires a currently selected, active charity**; an archived one blocks
  subscribing until replaced, and no charity is ever substituted. The signup form is UX; the requirement is
  enforced where money starts (the API's `requireSubscribableCharity`, called by Checkout — D-067).
- **ASM-22 Phase 4 stores and validates the charity choice and percentage but computes no contribution amounts
  and executes no donations** — those are payment concerns (Phase 5) and D-025 is still open. The donation
  request contract is validated only.
- **ASM-24 Stripe in TEST mode only; no card data is ever handled here.** _Implementation._ The PRD requires Stripe
  (SUB-02); card entry happens on Stripe's hosted Checkout and Billing Portal. Only test-mode keys are accepted and
  live-mode events are refused (D-067, D-068).
- **ASM-25 Access is the recorded paid period, with no tolerance and no Stripe fallback; eligibility to start another
  checkout is a separate rule.** _Owner decision D-070_ (giving effect to PRD SUB-04/SUB-05). Access = `active` and
  `current_period_end > now()`; `past_due` has no grace; nothing is granted for a late webhook and Stripe is never asked as a
  fallback. A `past_due` subscription has no access **and** blocks a second checkout while Stripe retries it (no double
  charge). _Implementation, still provisional:_ cancellation ends at the end of the paid period; refunds and chargebacks are
  not handled (D-068).
- **ASM-26 The charity share is the percentage of the amount actually collected, before tax, after discounts, gross of
  Stripe's fees, rounded up — with an append-only snapshot per payment.** _Owner decision D-070_ (giving effect to CHR-02/03:
  the PRD says only "10% of the subscription fee"). Payments are frozen once succeeded. The first payment uses the Checkout
  snapshot even if the charity was archived since (D-069).
- **ASM-27 A yearly payment funds the prize pool by 1/12 of the applicable pool basis per covered monthly draw.**
  _Owner decision D-070 — an implementation rule, NOT a PRD requirement_ (DRW-07 says only "a fixed portion of each
  subscription"). Not built; each payment records its amount, currency and covered period. The pool basis (D-014) and the
  remainder rule stay open.
- **ASM-28 Prices and currency are configuration.** _Owner decision D-070._ Stripe prices and `plans` rows; never a PRD
  requirement, never code; no plan rows in migrations or seed; a read-only readiness check compares the two sides.
- **ASM-16 Accounts with financial history cannot be hard-deleted** (foreign keys are RESTRICT) until an
  erasure/retention policy is decided (D-053).

## 5. Database traceability (Phase 1)

Every database-affecting requirement is classified:

- **A — Explicit:** the PDF states it; the schema enforces it.
- **B — Derivable:** follows from the PDF without inventing behaviour; the derivation is stated.
- **C — Product decision required:** the PDF is silent or ambiguous. The schema is kept **neutral** (no
  constraint that presumes an answer) or exposes the value as configuration. These are **not**
  presented as PRD requirements.

### A — Explicit

| Requirement                                | Database treatment                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SCR-02 score 1–45                          | `CHECK (stableford_score BETWEEN 1 AND 45)`                                                                                                                                                                                                                                                                                                                 |
| SCR-03 each score has a date               | `played_on date NOT NULL`                                                                                                                                                                                                                                                                                                                                   |
| SCR-04 one score per date                  | `UNIQUE (user_id, played_on)`                                                                                                                                                                                                                                                                                                                               |
| SCR-05 at most 5 retained                  | Reject-only trigger refuses a 6th row per user (serialised by an advisory lock); never deletes                                                                                                                                                                                                                                                              |
| SCR-06 new score replaces the oldest       | `add_score()` SQL function: atomic, oldest = earliest date, back-dated rejected (D-061)                                                                                                                                                                                                                                                                     |
| SCR-07 newest first                        | `ORDER BY played_on DESC`, served by the unique index                                                                                                                                                                                                                                                                                                       |
| SCR-08 edit or delete an entry             | Ordinary UPDATE/DELETE (through the API)                                                                                                                                                                                                                                                                                                                    |
| SUB-01 monthly and yearly plans            | `billing_interval` enum; one active plan per interval (partial unique index); `GET /api/plans`; the yearly plan is sold only if cheaper than 12 × monthly (`purchasablePlans`, D-067)                                                                                                                                                                       |
| SUB-02 Stripe gateway                      | Stripe Checkout and Billing Portal (hosted; **no card data touches or is stored by us**), signature-verified idempotent webhooks, `stripe_events` ledger; test mode only (D-067, D-068)                                                                                                                                                                     |
| SUB-04 renewal / cancellation / lapsed     | `subscription_status` (`pending, active, cancelled, lapsed`), period start/end, `cancel_at_period_end`, stamps; driven by verified Stripe webhooks (`apply_provider_subscription`, D-068)                                                                                                                                                                   |
| SUB-05 check on every request              | Single `is_active_subscriber(uuid)` definition, evaluated on every request against the current local state (service role): `status = 'active'` and `current_period_end > now()` — **no tolerance, no grace, no Stripe fallback (owner D-070)**; `current_user_is_active_subscriber()` for RLS. Checkout eligibility is a separate `has_open_subscription()` |
| CHR-01 select charity at signup            | Signup form field → signup data → `handle_new_user()` sets `profiles.selected_charity_id` (validated; NULL if none valid, D-066); `GET/PATCH /api/me/charity` to change it; archived-charity guard trigger (`GS002`); subscribing requires a selected, active charity (`requireSubscribableCharity`)                                                        |
| CHR-02 minimum 10%                         | `CHECK (charity_bps >= 1000)` on profiles; `>= 1000` on subscription contributions; API `422 percentage_below_minimum`; shared `checkCharityPercentage`; the contribution amount is the percentage of the amount collected before tax (after discounts, gross of Stripe fees), rounded up, in an append-only per-payment snapshot (owner D-070)             |
| CHR-03 may increase                        | User-editable `charity_bps` in `[1000, 10000]`; raise **or lower** allowed (D-064)                                                                                                                                                                                                                                                                          |
| CHR-04 independent donation                | `payments.kind = 'donation'`; `charity_contributions.source = 'donation'`; Phase 4: request contract + read-only `GET /api/me/contributions` (execution = Phase 5)                                                                                                                                                                                          |
| DRW-03 tiers 5/4/3                         | `prize_tiers` (match_count IN (3,4,5))                                                                                                                                                                                                                                                                                                                      |
| DRW-04 random or algorithmic               | `draw_mode` enum on each draw                                                                                                                                                                                                                                                                                                                               |
| DRW-05 admin simulates and publishes       | `draw_status` (`draft, simulated, published`); candidate rows live in the same tables                                                                                                                                                                                                                                                                       |
| DRW-09 40/35/25                            | Seeded in `prize_tiers` (4000/3500/2500 bps); each draw snapshots the share it used                                                                                                                                                                                                                                                                         |
| DRW-06 only 5-match rolls over             | `prize_tiers.rolls_over`; `CHECK` forbids rollover amounts on non-rolling tiers                                                                                                                                                                                                                                                                             |
| DRW-08 equal split                         | `winners_count`, `prize_per_winner_minor`; allocation can never exceed the tier pool                                                                                                                                                                                                                                                                        |
| DRW-10 proof screenshot                    | `winner_proofs` + private `winner-proofs` bucket                                                                                                                                                                                                                                                                                                            |
| DRW-11 approve or reject                   | `winners.verification_status`, `reviewed_at/by`                                                                                                                                                                                                                                                                                                             |
| DRW-12 Pending → Paid                      | `payout_status`; `paid_at` required when paid; a paid winner cannot revert                                                                                                                                                                                                                                                                                  |
| ADM-06 mark payouts completed              | `payout_status`, `paid_at`, `paid_by` (written by the API)                                                                                                                                                                                                                                                                                                  |
| DIR-01/02/03 directory, profile, spotlight | `charities` (+ full-text search), `charity_images`, `charity_events`, `is_featured`; `GET /api/charities`, `/api/charities/:slug`, `/api/charity-spotlight`                                                                                                                                                                                                 |
| ROL-01 three roles                         | `app_role` (`user`, `admin`); "registered subscriber" is derived from an active subscription                                                                                                                                                                                                                                                                |

### B — Derivable (derivation stated)

| Derived rule                                                       | Derivation                                                                        | Database treatment                                                      |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| DRW-02 (derived) a stored draw has exactly 5 numbers               | A "5-number match" is the top tier, implying a 5-number draw (PD-01)              | `CHECK (cardinality(winning_numbers) = 5)`; range and repeats left open |
| A draw belongs to one calendar month                               | "Monthly cadence"                                                                 | `draw_month` = first-of-month date, unique                              |
| Published results are frozen                                       | "Distribution is pre-defined and enforced automatically"; admin "publishes"       | Guard triggers on draws, entries, tier results, winners                 |
| A draw's tier shares/rollover flags are snapshotted                | Historical prize information must stay explainable                                | Copied into `draw_tier_results`                                         |
| One entry per user per draw; one prize per user per draw           | An entry has a single match count                                                 | `UNIQUE (draw_id, user_id)` on entries and winners                      |
| Winners exist only for published draws                             | Verification "applies to winners only"; winners are known only after publishing   | Trigger rejects winner rows for unpublished draws                       |
| A user has at most one live subscription                           | One plan at a time                                                                | Partial unique index on `(user_id)` for `pending`/`active`              |
| An active subscription has a renewal date                          | Dashboard shows the renewal date                                                  | `CHECK (status <> 'active' OR current_period_end IS NOT NULL)`          |
| A charity with history is archived rather than erased              | Admins can "delete" charities, while contribution totals must survive             | `archived_at`; contribution FKs are `RESTRICT`                          |
| A charity can be featured                                          | "Featured charity section"                                                        | `is_featured` (one or many is undecided, D-033)                         |
| Verification passes through "awaiting proof" and "pending review"  | Proof is uploaded, _then_ reviewed                                                | `verification_status` enum                                              |
| Contribution is recorded per payment with its basis and percentage | "Charity contribution totals" and "contribution calculation" must be reproducible | `charity_contributions` (basis, bps, amount)                            |

### C — Product decision required (schema stays neutral)

| Open point                                           | Decision | How the schema stays neutral                                                                                                                                  |
| ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What "match" means; whether scores are the numbers   | D-011    | `draw_entries.entry_numbers` is a snapshot array; `match_count` (0–5) is stored, not derived                                                                  |
| Number range and repetition                          | D-012    | No range/uniqueness check; optional `platform_settings.draw_number_min/max`                                                                                   |
| Algorithmic weighting                                | D-013    | Only `mode = 'algorithmic'` is stored                                                                                                                         |
| Pool portion (percentage or fixed amount) and value  | D-014    | `platform_settings.prize_pool_bps` **or** `prize_pool_per_subscription_minor`, NULL until decided                                                             |
| Yearly plans in monthly pools                        | D-015    | Nothing encoded; `draws.prize_pool_minor` is an engine-computed snapshot                                                                                      |
| Eligibility; users with fewer than five scores       | D-016    | Entries may hold 0–5 numbers; eligibility is not a constraint                                                                                                 |
| Cadence, cutoff, timezone, trigger                   | D-017    | `scheduled_at` nullable; month is a plain date                                                                                                                |
| Simulation semantics; corrections                    | D-018    | Candidate rows are replaceable while unpublished; published is frozen (correction needs a migration)                                                          |
| Rollover trigger, cap, where 4/3 money goes          | D-019    | `rollover_out_minor` is recorded by the engine; no rule about winners vs claims                                                                               |
| Remainder of an equal split                          | D-020    | `remainder_minor` records whatever the decided rule yields                                                                                                    |
| Proof/claim rules; resubmission                      | D-021    | Multiple proof rows per winner allowed; direct upload only while `awaiting_proof`                                                                             |
| Payout mechanism; paid before approval?              | D-022    | Not enforced: `paid` does not require `approved`                                                                                                              |
| Admin permission granularity                         | D-023    | A single `admin` role; API can add finer checks later                                                                                                         |
| Plan prices, discount, currency, tax                 | D-024    | No plan rows; currency stored on each monetary row; one-active-plan rule only                                                                                 |
| Charity basis (gross/net), rounding, cap, donors     | D-025    | Stores basis, bps and amount; only "bps ≥ 1000" and "amount ≤ basis" are enforced; optional cap in settings                                                   |
| Cancellation timing, lapse/grace, "real time" method | D-026    | `provider_status` keeps raw Stripe state; `cancel_at_period_end`; access (`is_active_subscriber`) and eligibility (`has_open_subscription`) are two functions |
| Which "oldest" score is replaced                     | D-027    | Eviction is not in the database; the cap only refuses a 6th row                                                                                               |
| Authentication method                                | D-028    | Profile hangs off `auth.users`; no auth logic in the schema                                                                                                   |
| Analytics definitions                                | D-029    | All raw facts are stored; no aggregates are baked in                                                                                                          |
| Scope of "restricted access"                         | D-030    | Restrictive default in one RLS policy and one function (ASM-13)                                                                                               |
| Missing PRD pages; legal scope; erasure              | D-032    | Financial history uses RESTRICT foreign keys (ASM-16)                                                                                                         |
| Charity filters, events, images, spotlight rules     | D-033    | Free-form `tags`; `is_featured` not unique                                                                                                                    |

## Appendix A. Constraints from the brief (not PRD text)

**Deployment:** the PDF requires a **new** Vercel account and a **new** Supabase project. The project
owner additionally stated that the existing personal Supabase project must not be used, and that git
operations and GitHub are managed by the owner. Nothing has been provisioned.

**Architecture direction (from the owner's brief):** React + Vite + TypeScript frontend; Node.js +
Express + TypeScript backend; Supabase/PostgreSQL for database, auth and storage; Stripe for payments;
a shared TypeScript contracts package; a clean monorepo without over-engineering. Money is always
stored as integer minor units; service-role credentials never reach the frontend; admin authorization
is enforced server-side; critical business rules get automated tests; Stripe uses a real test-mode
integration rather than a fake.
