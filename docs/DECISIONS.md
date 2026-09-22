# Decision Log

The PRD is the single source of truth ([PRD_NOTES.md](./PRD_NOTES.md)). Where it is silent or
ambiguous, we **record a decision** — we do not silently pick a behaviour in code.

**Read this file before implementing any ambiguous business logic.** If the rule you need is `OPEN`,
stop and ask the project owner; do not implement your own interpretation.

## Status legend

| Status               | Meaning                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ACCEPTED (PRD)`     | The PRD states it explicitly. Not a choice; recorded so code and tests can cite it.                                                      |
| `ACCEPTED (derived)` | Follows from the PRD without inventing behaviour; the derivation is written down.                                                        |
| `ACCEPTED (project)` | Set by the project owner: the brief (architecture, deployment, security rules) or an explicit answer to a question (dated in the entry). |
| `ACCEPTED (dev)`     | A development/tooling/design choice made by the team. **Not** a product requirement.                                                     |
| `PARTIALLY RESOLVED` | The PDF settled part of the question. The residual question is still **open** and listed.                                                |
| `OPEN`               | **Unresolved.** Needs an answer from the project owner before it is built.                                                               |

Nothing marked `OPEN` or `PARTIALLY RESOLVED` has been decided. Options are for discussion, and
"leaning" notes are non-binding development input. Each open decision states its **schema impact** —
how the Phase 1 database stays neutral so the eventual answer needs no redesign.

## Index

| ID                  | Topic                                                                           | Status             |
| ------------------- | ------------------------------------------------------------------------------- | ------------------ |
| D-034               | Score rules                                                                     | ACCEPTED (PRD)     |
| D-035               | Prize tiers, shares, rollover tiers, equal split                                | ACCEPTED (PRD)     |
| D-036               | Charity minimum, increase, independent donations                                | ACCEPTED (PRD)     |
| D-037               | Winner verification and payout workflow                                         | ACCEPTED (PRD)     |
| D-038               | Roles and admin capabilities                                                    | ACCEPTED (PRD)     |
| D-039               | Subscription status checked on every authenticated request                      | ACCEPTED (PRD)     |
| D-040               | A draw has exactly 5 numbers                                                    | ACCEPTED (derived) |
| D-041               | One draw per calendar month                                                     | ACCEPTED (derived) |
| D-042               | Published draws are immutable; tier results snapshotted                         | ACCEPTED (derived) |
| D-043               | Charities are archived, not erased, once they have history                      | ACCEPTED (derived) |
| D-044               | One live subscription per user; active has a renewal date                       | ACCEPTED (derived) |
| D-045               | Entries/winners: one per user per draw; winners only after publish              | ACCEPTED (derived) |
| D-001, D-007..D-010 | Tooling, shared package, ports, error envelope                                  | ACCEPTED (dev)     |
| D-002..D-006        | Stack, money, service role, admin authz, PRD precedence                         | ACCEPTED (project) |
| D-046               | Money as `bigint` minor units, percentages as basis points, currency per row    | ACCEPTED (dev)     |
| D-047               | Database tests run on PGlite with a Supabase shim                               | ACCEPTED (dev)     |
| D-048               | Browser roles are read-mostly; writes go through the API                        | ACCEPTED (dev)     |
| D-049               | Score cap is reject-only; eviction stays in domain code                         | ACCEPTED (dev)     |
| D-050               | Restrictive default for draw visibility                                         | ACCEPTED (dev)     |
| D-051               | Storage buckets and development limits                                          | ACCEPTED (dev)     |
| D-052               | Append-only admin audit log                                                     | ACCEPTED (dev)     |
| D-053               | Financial history blocks hard deletion of accounts                              | ACCEPTED (dev)     |
| D-054               | Database types: mirrored enums + constants, generated row types later           | ACCEPTED (dev)     |
| D-055               | Development seed contains fictional charities only                              | ACCEPTED (dev)     |
| D-056               | Email + password through Supabase Auth (provisional)                            | ACCEPTED (dev)     |
| D-057               | Server-side token verification and DB-backed roles                              | ACCEPTED (dev)     |
| D-058               | Credentials go browser → Supabase Auth; the API is a stateless token verifier   | ACCEPTED (dev)     |
| D-059               | Administrators are created only by a service-role/SQL operation                 | ACCEPTED (dev)     |
| D-060               | Authentication/authorization error semantics; UI guards are UX only             | ACCEPTED (dev)     |
| D-061               | "Oldest" score = earliest round date; back-dated scores are rejected            | ACCEPTED (project) |
| D-062               | Score API design and access rules                                               | ACCEPTED (dev)     |
| D-063               | API tests are hermetic: in-process HTTP, no sockets                             | ACCEPTED (dev)     |
| D-064               | Charity percentage: any value from 10% up, raise or lower                       | ACCEPTED (project) |
| D-065               | Charity API, access rules and search design                                     | ACCEPTED (dev)     |
| D-066               | Charity chosen at signup; required (and active) to subscribe                    | ACCEPTED (project) |
| D-067               | Plans as data, Stripe Checkout/Portal (test mode), checkout eligibility         | ACCEPTED (dev)     |
| D-068               | Webhooks: verified, idempotent, order-safe; subscription lifecycle mapping      | ACCEPTED (dev)     |
| D-069               | Charity contribution amount, attribution snapshot; yearly plans in pools        | ACCEPTED (dev)     |
| D-070               | Phase 5 owner decisions: access, contribution basis, history, prices            | ACCEPTED (project) |
| D-071               | Draw engine: matching, range, weighting, pool, tiers, rollover, lifecycle       | ACCEPTED (project) |
| D-072               | Winner verification/payout: resubmission, upload transport, payout order, audit | ACCEPTED (project) |
| D-073               | User dashboard: composition, the /api/me/draws endpoint, what stays unbuilt     | ACCEPTED (project) |
| D-011 … D-033       | Product decisions                                                               | see Section 4      |

## How to add or resolve a decision

1. Add an entry with the next free `D-###` id, the question, options, and what it blocks.
2. Link it from the relevant `AMB-##` item in [PRD_NOTES.md](./PRD_NOTES.md).
3. When the owner answers, change the status, record the answer, who decided and the date, then
   implement it with tests that reference the decision id (and add a migration if the schema must change).
4. Never delete a superseded decision; mark it `SUPERSEDED by D-###`.

---

## 1. Decisions dictated by the PRD

These are not choices. Each cites the PDF section and where the database enforces it.

### D-034 — Score rules

- **Status:** ACCEPTED (PRD) — §05, SCR-01…SCR-08.
- **Rules:** score 1–45; each has a date; one entry per date (duplicates not allowed — an existing entry
  may only be edited or deleted); only the latest 5 retained; a new score replaces the oldest
  automatically; display newest first.
- **Enforced:** `scores` CHECK (range), NOT NULL (date), UNIQUE `(user_id, played_on)`, reject-only cap of
  5 rows. **Not** in the database: _which_ score is "oldest" — see D-027 and D-049.

### D-035 — Prize tiers, shares, rollover, equal split

- **Status:** ACCEPTED (PRD) — §06, §07, DRW-03/06/08/09.
- **Rules:** tiers for 5, 4 and 3 matches with pool shares 40% / 35% / 25%; only the 5-match jackpot rolls
  over (4 and 3 do not); prizes split equally among winners in a tier.
- **Enforced:** seeded `prize_tiers` (4000/3500/2500 bps, rollover t/f/f); tier results snapshot the share
  and flag; rollover amounts forbidden on non-rolling tiers. Open residuals: D-011, D-019, D-020.

### D-036 — Charity minimum, increase, independent donations

- **Status:** ACCEPTED (PRD) — §08, CHR-02/03/04.
- **Rules:** minimum 10% of the subscription fee; users may voluntarily increase; independent donation
  option not tied to gameplay.
- **Enforced:** `charity_bps >= 1000` (profiles and subscription contributions); donations are payments of
  kind `donation`. Open residuals: basis, rounding, cap, donors — D-025.

### D-037 — Winner verification and payout workflow

- **Status:** ACCEPTED (PRD) — §09, §11, DRW-10/11/12, ADM-06.
- **Rules:** verification applies to winners only; proof is a screenshot of scores from the golf platform;
  admin approves or rejects; payment state goes Pending → Paid; admins mark payouts as completed.
- **Enforced:** `winners.verification_status`, `payout_status` (paid needs `paid_at`, never reverts); private
  `winner-proofs` bucket. Open residuals: deadlines, resubmission, formats, payout mechanism — D-021, D-022.

### D-038 — Roles and admin capabilities

- **Status:** ACCEPTED (PRD) — §03, §11, ROL-01…04, ADM-01…07.
- **Rules:** exactly three roles (visitor, registered subscriber, administrator) with the capability lists
  in §03, and a single Administrator role able to view/edit profiles, **edit golf scores**, manage
  subscriptions, configure/run/publish draws, manage charities and media, verify winners, mark payouts and
  view reports.
- **Enforced:** `app_role` (`user`, `admin`); "registered subscriber" is derived from an active
  subscription. This settles _which capabilities exist_; finer-grained permissions remain D-023.

### D-039 — Subscription status is checked on every authenticated request

- **Status:** ACCEPTED (PRD) — §04, SUB-05. (Resolves the "real time" wording from Phase 0, PD-04.)
- **Rule:** the subscription check happens per authenticated request, not once at login.
- **Enforced:** one `is_active_subscriber(uuid)` function reads live rows (indexed by user) and is the only entitlement definition; RLS reaches it through the caller-only wrapper `current_user_is_active_subscriber()`. **Not** decided: whether the API instead queries Stripe live — D-026.

---

## 2. Decisions derived from the PRD

Each follows from the PDF without inventing behaviour. If the derivation is challenged, that decision
should be revisited.

### D-040 — A draw has exactly 5 numbers

- **Status:** ACCEPTED (derived). **The PDF does not state this** (PD-01).
- **Derivation:** the top prize tier is a "5-number match" (§06), which implies the draw has (at least) 5
  numbers; five is the only natural reading.
- **Database:** `CHECK (cardinality(winning_numbers) = 5)` and no null elements. The number **range** and
  whether numbers **repeat** are _not_ constrained (D-012). Reversible with a one-line migration.

### D-041 — One draw per calendar month

- **Status:** ACCEPTED (derived) — "monthly cadence" (§06).
- **Database:** `draws.draw_month` is the first day of the month (plain `date`, no timezone), unique.

### D-042 — Published draws are immutable; tier results are snapshotted

- **Status:** ACCEPTED (derived) — "distribution is pre-defined and enforced automatically" and admin
  "controls publishing" (§06/§07), plus the owner's requirement that published history not be mutated.
- **Database:** guard triggers reject any change to a published draw, its entries and tier results, and any
  change to a winner's draw/user/tier/prize. `draw_tier_results` copies the share and rollover flag, so
  editing `prize_tiers` later cannot rewrite history. **Corrections** to a published draw are undecided
  (D-018) and today would need a deliberate migration.

### D-043 — Charities are archived, not erased, once they have history

- **Status:** ACCEPTED (derived) — admins can "delete" charities (§11) while "charity contribution totals"
  (§11) must survive.
- **Database:** `archived_at` hides a charity from public reads; contribution foreign keys are `RESTRICT`;
  a charity with no history can be hard-deleted.

### D-044 — One live subscription per user; an active one has a renewal date

- **Status:** ACCEPTED (derived) — one plan at a time (§04); dashboard shows the renewal date (§10).
- **Database:** partial unique index on `(user_id)` for `pending`/`active`; `CHECK` that `active` has
  `current_period_end`. Plan switching and cancellation timing remain open (D-026).

### D-045 — One entry and one prize per user per draw; winners exist only after publishing

- **Status:** ACCEPTED (derived) — an entry has a single match count; verification "applies to winners
  only" (§09) and winners are known only once a draw is published.
- **Database:** unique `(draw_id, user_id)` on entries and winners; a trigger rejects winner rows for
  unpublished draws; composite foreign keys keep a winner consistent with its entry, tier result and draw
  currency.

---

## 3. Development and project-brief decisions

### D-001 — Monorepo with npm workspaces

- **Status:** ACCEPTED (dev, Phase 0). `apps/web`, `apps/api`, `packages/shared`, and (Phase 1)
  `supabase/tests`, as npm workspaces (npm 11, Node ≥ 22.12). No pnpm/Turborepo/Nx.

### D-002 — Technology stack

- **Status:** ACCEPTED (project). React + Vite + TypeScript; Node.js + Express + TypeScript; Supabase
  (PostgreSQL, Auth, Storage); Stripe; a shared TypeScript package.

### D-003 — Money is stored as integer minor units

- **Status:** ACCEPTED (project). All monetary amounts are integers in the currency's minor unit; the
  currency code is stored beside the amount. Splitting a prize needs a remainder rule (D-020).

### D-004 — Service-role credentials are server-only

- **Status:** ACCEPTED (project). The service-role key exists only in the API's server environment — never
  in `apps/web`, any `VITE_*` variable, or `packages/shared`.

### D-005 — Admin authorization is enforced server-side

- **Status:** ACCEPTED (project). Every admin capability is authorized in the API and, as defence in depth,
  by database policies. Frontend guards are UX only.

### D-006 — PRD precedence and handling of ambiguity

- **Status:** ACCEPTED (project). The PRD is the source of truth; ambiguities become explicit decisions.

### D-007 — Shared package is consumed as compiled ESM

- **Status:** ACCEPTED (dev, Phase 0). `@gather/shared` compiles to `dist/`; both apps import the built
  output, so `shared` must be built first (the root scripts do this).

### D-008 — Language/tooling baseline

- **Status:** ACCEPTED (dev, Phase 0). ESM everywhere; strict TypeScript from `tsconfig.base.json`; one flat
  ESLint config with type-aware rules; Prettier; Vitest. npm 11 reports install scripts for `esbuild` and
  `fsevents` as "pending approval"; everything works without them, so they were left unapproved.
  `supabase/tests` uses `Bundler` module resolution (its files run under Vitest), like the web app.

### D-009 — Local development ports and proxy

- **Status:** ACCEPTED (dev, Phase 0). API `4000`, web `5173`; Vite proxies `/api` in development.

### D-010 — API error envelope

- **Status:** ACCEPTED (dev, Phase 0; may evolve). Failing API responses use
  `{ "error": { "code", "message" } }` (`ApiErrorBody`); internal details are never returned.

### D-046 — Money as `bigint` minor units, percentages as basis points, currency on every row

- **Status:** ACCEPTED (dev). Implements D-003.
- **Representation:** domain `minor_units` (`bigint`, ≥ 0); domain `basis_points` (`integer`, 0–10000, so
  10% = 1000); domain `currency_code` (`text`, three capital letters). No `numeric`, `real`, `double
precision` or `money` column exists — a test enforces this. Basis points avoid floating-point drift and
  are exact for every percentage the PRD mentions.
- **Currency:** stored on each monetary record because the PRD fixes none (D-024). Tables that derive it
  from a parent (`draw_tier_results` → `draws`) are documented exceptions, guarded by a test.
- **Tests:** `schema.test.ts` (column types), `constraints.test.ts` (fractional/negative rejected).

### D-047 — Database tests run on PGlite with a Supabase shim

- **Status:** ACCEPTED (dev). No Docker, Supabase CLI or PostgreSQL server is available locally, and the
  Supabase CLI installer downloads from GitHub. Migrations are therefore tested on **PGlite** (real
  PostgreSQL compiled to WASM, PostgreSQL **18.3**), with a small shim (`supabase/tests/support/
supabase-shim.sql`) for roles, `auth`, `storage` and Supabase's default privileges.
- **Consequences:** migrations use only core PostgreSQL features available in 15+ (no extensions).
  The shim is an approximation and PGlite is one major version ahead of hosted Supabase; migrations
  **must be re-run on a real local Supabase stack** (`supabase db reset`) before production use. See
  [TESTING.md](./TESTING.md).

### D-048 — Browser roles are read-mostly; every other write goes through the API

- **Status:** ACCEPTED (dev), consistent with D-004/D-005. `anon` reads public reference data;
  `authenticated` reads its own rows (admins read all) and may update only `display_name`,
  `selected_charity_id` and `charity_bps` on its own profile. Every other write — scores, subscriptions,
  payments, draws, winners, proof metadata, charities, settings — uses the service role in the API, which
  authenticates the caller, applies business rules and writes the audit log. `billing_customers` and
  `stripe_events` are service-only. Functions that take an arbitrary user id (`is_active_subscriber(uuid)`) are service-role only, so browser roles cannot probe other users through `/rpc`.
- **Why:** direct writes would bypass business rules (e.g. score eviction) and audit. Not granting them
  means a missing or wrong policy cannot become a tampering hole.
- **Enforced by:** explicit `GRANT`s (default privileges revoked), RLS policies, and tests that enumerate
  every table/column privilege.

### D-049 — The score cap is reject-only; eviction is an explicit function, not a trigger

- **Status:** ACCEPTED (dev), implementing D-034. A trigger refuses a 6th score per user (under a per-user
  advisory lock, so concurrent requests cannot both pass). It **never deletes**. It ignores an `INSERT` for a
  date the user already has (that adds no row), so edit-by-upsert and `ON CONFLICT DO NOTHING` retries work
  at the cap. Inserting _before_ deleting is rejected by design.
- **"Replace the oldest"** is done by the SQL function `public.add_score()` (migration `…110000`), which the
  API calls in one statement: it takes the same per-user lock, rejects a duplicate date, evicts the oldest,
  then inserts — atomically. The rule for "oldest" is D-061.
- **Why not a rolling trigger:** it would make rows vanish as a side effect of an `INSERT`. An explicit,
  named function called by the API keeps eviction visible and testable.

### D-050 — Restrictive default for draw visibility

- **Status:** ACCEPTED (dev), **provisional pending D-030**. Drafts and simulations (including candidate
  match counts) are admin-only. A published draw and its tier results are visible to active subscribers and
  to anyone entered in that draw (so a lapsed winner still sees their result). A user sees only their own
  entry, only once published. Relaxing this means editing one policy.

### D-051 — Storage buckets and development limits

- **Status:** ACCEPTED (dev), **limits provisional pending D-021**.
- **Buckets:** `winner-proofs` — **private**; a winner may upload only under `<winner_id>/…` for a winner
  record they own and only while it is `awaiting_proof`; only the owner and admins can read; no user
  update/delete. `charity-media` — public read, admin-only write.
- **Limits:** 10 MiB / PNG, JPEG, WebP for proof; 5 MiB / same types for charity media. **These are not PRD
  values.** Downloads use short-lived signed URLs from the API. No OCR or image processing.

### D-052 — Append-only admin audit log

- **Status:** ACCEPTED (dev). Not in the PDF. `admin_audit_log` accepts inserts (service role) and can never
  be updated or deleted; `actor_id` is deliberately not a foreign key so the log outlives accounts.

### D-053 — Financial history blocks hard deletion of accounts

- **Status:** ACCEPTED (dev), **provisional pending D-032**. Payments, contributions, subscriptions, entries
  and winners reference profiles with `ON DELETE RESTRICT`, so deleting an account with history fails
  loudly. Scores (personal data) cascade. A GDPR-style erasure/anonymisation policy is undecided.

### D-054 — Database types

- **Status:** ACCEPTED (dev). `@gather/shared` exports the enum vocabularies (`DB_ENUMS` etc.) and the
  PRD-stated constants; a test fails if they drift from the migrated schema. **Full row types are not
  hand-written** (that would duplicate the schema). Generate them with `supabase gen types typescript`
  when the CLI is available (documented in [ARCHITECTURE.md](./ARCHITECTURE.md)).

### D-055 — Development seed contains fictional charities only

- **Status:** ACCEPTED (dev). `supabase/seed.sql` runs only on `supabase db reset` (local), never with
  `db push`. It seeds three clearly fictional charities and their events. **No plans** (prices
  undecided), users, payments, draws or winners.

### D-056 — Email + password through Supabase Auth (provisional)

- **Status:** ACCEPTED (dev), **provisional pending D-028**. Phase 2 was asked to deliver signup, login,
  logout and session restoration on Supabase Auth. The PDF says only "signup / login" and "test
  credentials" (§15), so the minimal reading — an email address and password — is implemented. It is a
  development choice, **not** a PRD requirement, and adds nothing that forecloses D-028's answers.
- **Neutral by design:** the signup form handles a project with email confirmation **on** (no session yet →
  "check your email") and **off** (session returned → signed in), because that is a project setting the
  owner has not decided. No password-strength rule is invented: only non-empty is checked client-side and
  Supabase's own policy/message is shown (`weak_password`).
- **Not built (out of scope or undecided):** password reset, social login, email-change flows, and choosing
  a charity at signup (CHR-01 is a charity feature; the profile row it will update already exists).

### D-057 — Server-side token verification and database-backed roles

- **Status:** ACCEPTED (dev). Implements D-005.
- **Verification:** the API verifies the `Authorization: Bearer` access token itself, locally, against the
  public keys Supabase Auth publishes (`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`): signature, issuer,
  audience and expiry. **Only asymmetric algorithms (ES256, RS256) are accepted**, which closes
  `alg: none` and algorithm-confusion attacks. The token must also carry a UUID `sub` and
  `role = authenticated`, and not be anonymous — so Supabase's anon and service-role API keys can never
  authenticate a caller.
- **Roles:** after verification the API reads `profiles.role` from the database on **every** request (no
  cache). Nothing a client controls — token claims, `app_metadata`/`user_metadata`, headers, query, body —
  can influence it. A demoted or deleted user loses access on the next request. An unrecognised role value
  is an error, never a default.
- **Fails closed:** unconfigured auth, an unreachable key set (503), a failed profile lookup (500) or any
  unexpected error ends the request; nothing falls through to a handler.
- **Consequences / trade-offs:** (1) Projects still on Supabase's legacy shared-secret (HS256) JWT scheme
  must move to JWT signing keys, or verification will reject its tokens — **to be confirmed once the new
  project exists**. (2) Local verification cannot see a session that was signed out until its access token
  expires (Supabase default: 1 hour); logout revokes the refresh token, so no new access token is issued.
  The role/profile lookup on every request still stops deleted accounts immediately. Calling Supabase's
  `getUser` on every request would close this gap at the cost of a network round trip each time.

### D-058 — Credentials go browser → Supabase Auth; the API is a stateless token verifier

- **Status:** ACCEPTED (dev). Signup, login and logout call Supabase Auth directly from the browser with the
  public anon key; the API never receives a password. The API exposes no login/session endpoints: it only
  verifies bearer tokens (`GET /api/me`, everything under `/api/admin/*`). The browser session lives in
  supabase-js (localStorage, auto-refresh), which is what restores it after a reload. The web app then asks
  `GET /api/me` who the user is and what role they have; it never reads the role from the session.
- **Profile linking:** the Phase 1 trigger creates a least-privilege `profiles` row for every `auth.users`
  row. It originally read no signup metadata; since D-066 it reads **one** validated key (the charity chosen on the
  signup form) and still nothing that could affect role or percentage.

### D-059 — Administrators are created only by a service-role/SQL operation

- **Status:** ACCEPTED (dev). There is no signup option, API endpoint or browser-writable column that can
  produce an administrator (`profiles.role` is not writable by browser roles; the trigger ignores
  metadata). The first admin — and any later one — is promoted with SQL run by the project owner (see
  README "Creating the first administrator"). How further admins should be created is part of D-023.

### D-060 — Authentication/authorization error semantics; UI guards are UX only

- **Status:** ACCEPTED (dev). `401 unauthenticated` (no credentials) and `401 invalid_token` (bad/expired)
  carry a `WWW-Authenticate` header; `403 forbidden` = signed in but not an admin; `403 profile_missing` =
  valid account with no profile row; `503 auth_unavailable` = auth not configured or its key set is
  unreachable. Messages are generic and never say _why_ a token was rejected. Every `/api/admin/*` path is
  guarded on the **prefix**, so even unknown admin URLs answer 401/403 before any 404. The web app's route
  guards decide only what to display; each protected call is verified again by the server, and the admin
  page re-checks with `GET /api/admin/check`.

### D-061 — "Oldest" score = earliest round date; back-dated scores are rejected

- **Status:** ACCEPTED (project) — **owner decision, 2026-09-21**, answering the open questions in D-027 that
  blocked the score service.
- **Rules:**
  1. When a user who already has five scores adds a sixth, the score with the **earliest `played_on` date** is
     the "oldest" and is replaced — whatever order the scores were entered in.
  2. A new score dated **older than all five** existing ones is **rejected** (API `422 score_too_old`); nothing
     changes. The kept five are always the five most recent dates, and a score the user just typed is never
     silently dropped.
  3. A date the user already has is rejected as a duplicate (`409 score_date_exists`) **before** anything is
     evicted, so a duplicate can never cost the user their oldest score.
- **Implemented in:** `public.add_score()` (`supabase/migrations/20260921110000_add_score_function.sql`).
- **Tests:** `supabase/tests/scores-function.test.ts` (rules, ordering by date not entry, boundary at 5, isolation,
  privileges) and `apps/api/src/scores/*.test.ts` (HTTP behaviour and error mapping).

### D-062 — Score API design and access rules (provisional)

- **Status:** ACCEPTED (dev), **provisional pending D-030 and D-027's remaining questions.**
- **Endpoints** (all require a signed-in user and act only as that user):
  `GET /api/scores` (own scores, newest first), `POST /api/scores` (add; replaces the oldest at five),
  `PUT /api/scores/:playedOn` (edit the **value**), `DELETE /api/scores/:playedOn`.
- **Ownership:** the user id comes only from the verified token. A score is addressed by its **date within the
  caller's own scores**, so there is no id or user in any URL a client could swap; a `userId` in a body, query or
  header is ignored. Every repository call is scoped by user id, because the service role bypasses RLS.
- **Access:** **writes** (add/edit/delete) need an **active subscription, checked on every request** (PRD §03
  role table and SUB-05); **reading one's own scores** is allowed to any signed-in user so a lapsed user keeps
  their history. Administrators get no bypass. _Admin editing of another user's scores (ADM-01) is not built._
- **Validation:** the Stableford value must be a JSON integer 1–45 and the date a real calendar `YYYY-MM-DD`
  (shared, pure validators; the database still enforces the range and uniqueness). Future dates and a maximum age
  are **not** checked (D-027).
- **Errors:** `400 validation_failed` (with per-field errors), `403 subscription_required`,
  `404 score_not_found`, `409 score_date_exists`, `422 score_too_old`.
- **Atomicity/security:** adding is one RPC call. `add_score(uuid, date, integer)` takes an arbitrary user id, so —
  like `is_active_subscriber(uuid)` — it is executable **only by `service_role`** (tested).

### D-063 — API tests are hermetic: in-process HTTP, no sockets

- **Status:** ACCEPTED (dev). The API tests now send requests **in-process** with `light-my-request` through a
  small adapter (`apps/api/src/test-support/http.ts`) that keeps supertest's call shape; `supertest` was removed.
- **Why:** supertest opens a real server on a random port for every request. On the development machine another
  local listener (a VS Code extension helper serving Express on `127.0.0.1`) occasionally answered a request meant
  for the test server, giving rare empty-body `404`s (about 1 request in 10,000; about 1 full-suite run in 30). A
  loopback-bound test server cut that ~6× but could not remove it.
- **Evidence:** the suite passes under a guard that throws on **any** TCP `listen`/`connect` in a test worker (with
  a negative control proving the guard bites); **186 consecutive runs, 0 failures** — 50 (affected files),
  80 (full suite), 40 under CPU saturation, 16 under saturation plus the guard.
- **Trade-off:** the API tests no longer exercise real sockets. `server.ts` binding a port is covered only by manual
  smoke runs (already the case for the dev stack).

### D-064 — Charity percentage: any value from 10% up, raise or lower

- **Status:** ACCEPTED (project) — **owner decision, 2026-09-21**, answering the part of D-025 that blocked the
  charity percentage rules.
- **Rules:**
  1. The contribution percentage may be **any value from the PRD minimum (10%) up to 100%** (or the configured
     product cap, if one is ever set in `platform_settings.charity_max_bps`).
  2. The user may **raise or lower** it at any time, including back down to exactly 10%. There is no
     "increase only" rule.
- **Implemented in:** `checkCharityPercentage` (`packages/shared/src/charities.ts`), the charity service
  (`422 percentage_below_minimum` / `422 percentage_above_maximum`) and the database
  (`profiles.charity_bps` check `>= 1000`; the `basis_points` domain caps it at 10000).
- **Tests:** `packages/shared/src/charities.test.ts`, `apps/api/src/charities/{service,routes}.test.ts`,
  `supabase/tests/charity.test.ts` (direct browser path 25% → 10% → 100% → 10%), `apps/web/src/charities.test.tsx`.
- **Still open (D-025):** what the percentage is applied _to_ (gross vs net), rounding, and the effect on
  payments already made. Phase 4 stores and validates the percentage; it computes **no** amounts.

### D-065 — Charity API, access rules and search design (provisional)

- **Status:** ACCEPTED (dev), **provisional pending D-033 and the remaining questions in D-025.**
- **Endpoints.** Public (no sign-in; PRD §03 — visitors explore listed charities): `GET /api/charities` (search
  and filters, paged), `GET /api/charities/:slug` (profile), `GET /api/charity-spotlight` (homepage). Signed-in,
  acting only as the caller: `GET`/`PATCH /api/me/charity` (chosen charity and percentage) and
  `GET /api/me/contributions` (read-only history with per-currency totals).
- **What the public sees.** Only **listed** (non-archived) charities. An archived charity looks exactly like one that
  does not exist (`404`), in the list, the profile, the spotlight and in search. The filter is applied explicitly in
  the repository (the service role bypasses RLS); the browser-facing RLS policy says the same for visitors and
  non-admin users (administrators can also see archived charities).
- **Selecting a charity.** Needs a signed-in user but **not** a subscription. It is chosen at signup and can be
  changed later on `/account/charity` (D-066). An unknown charity is `404 charity_not_found`; an archived one is
  `422 charity_unavailable`. Because users can also write `profiles.selected_charity_id` directly through the
  Phase 1 column grant, migration `20260921120000_charity_selection_guard.sql` enforces "no archived charity" in the
  database too (SQLSTATE `GS002`); the API maps it. Archiving a charity **after** it was chosen does not block the
  user editing their percentage; it does block starting a subscription until they choose another (D-066), and the
  page asks them to.
- **Search and filters (D-033, provisional).** Text search is PostgreSQL full-text over name + description
  (generated `charities.search` column, `english` configuration) as **word prefixes** ("river" finds "Riverside").
  The API turns the text into a tsquery itself from letter/digit runs only, so no user text can reach tsquery or
  PostgREST filter syntax. Filters are **exact tag** and **featured only**. Results are ordered by name and paged by
  `limit` (1–50, default 20) / `offset`, with a `hasMore` flag.
- **Content model (D-033, provisional).** Profiles carry description, images (references to the public
  `charity-media` storage bucket, with alt text and order) and **upcoming** events (title, description, location,
  start/end; events already started are not shown). **Several** charities may be featured at once; the spotlight
  returns up to 6. Nothing in Phase 4 lets anyone _edit_ charities, images or events through the API: admin
  management of charities (ADM-05) belongs with the admin phase; until then they are managed with SQL/the dashboard.
- **Independent donations (CHR-04).** Phase 4 provides the **contract** (`parseDonationRequest`: charity id, integer
  minor-unit amount ≥ 1, ISO-4217-shaped currency) and the read-only history over the existing
  `charity_contributions` table (`source = 'donation'` rows). It creates **no** donation and moves no money: that is
  payment execution (Phase 5), and the amount/rounding rules are still open (D-025).
- **Errors:** `400 validation_failed` (with per-field errors), `401`/`403` as in D-060, `404 charity_not_found`,
  `422 charity_unavailable | percentage_below_minimum | percentage_above_maximum`.
- **Verified on the hosted project (2026-09-21):** migration 13 applied; the API, the Data API and a real browser
  were run against the hosted database — see TESTING.md §3c. The hosted run found and fixed one UI defect (the
  chosen charity was lost across sign-in) and one README defect (non-re-runnable sample SQL).
- **CHR-01 was resolved by the owner — see D-066** (charity chosen on the signup form; a selected, active charity
  is required to subscribe). The hosted-project run described above pre-dates it; D-066's migration and UI have
  their own verification notes in TESTING.md §3c.

### D-066 — Charity chosen at signup; a selected, active charity is required to subscribe

- **Status:** ACCEPTED (project) — **owner decision, 2026-09-21**: read CHR-01 ("users select a charity at signup")
  strictly. This closes the open question left in D-065 and supersedes D-065's earlier reading (charity picked after
  signup).
- **Rules:**
  1. **Signup collects the charity.** The signup form has a required charity field offering only **listed**
     charities. If the visitor chose one earlier (the profile page's "Choose this charity" carries
     `?charity=<id>` into signup) it is **pre-selected** and can still be changed; otherwise the visitor must pick one
     before they can sign up. If no charity can be offered (none listed, or the list cannot be loaded) signup is
     unavailable and says why.
  2. **The choice survives authentication.** It travels in the signup data (`selected_charity_id`), not in a
     session, so it is recorded even when the project requires email confirmation. A visitor who already has an
     account is sent to log in with the choice kept (`/account/charity?charity=<id>` pre-selected), and the query
     string is no longer lost across the login redirect.
  3. **Later changes** are made on `/account/charity` (D-064/D-065): any listed charity, any percentage from 10% to
     100%, raised or lowered.
  4. **Subscribing requires a currently selected, active charity.** No selected charity → `422 charity_required`; a
     selected charity that has since been **archived** → `422 selected_charity_unavailable`, until the user replaces
     it. The system **never substitutes** another charity. The percentage plays no part in this check.
- **Where each rule lives:**
  - Recording the signup choice: `handle_new_user()` (migration `20260921130000_signup_charity_selection.sql`). It
    now reads **exactly one** signup-data key and treats it as untrusted: it must look like a UUID (checked before
    the cast) and name an existing, listed charity; anything else is **ignored, never an error**, so a bad value can
    never fail a signup. Role, percentage and all other data are still not read (D-057, D-059).
  - The form: `SignupPage` (UX only). It is **not** the enforcement point — a client can call Supabase Auth
    directly — which is why rule 4 exists at the money boundary.
  - The subscription precondition: `CharityService.requireSubscribableCharity(userId)` (API), returning the charity
    id and percentage the contribution will use. **Stripe Checkout (D-067) calls it before creating anything at Stripe**; it is tested at the service and over HTTP
    (Phase 5).
- **Deliberately not done:** no database constraint or trigger on `subscriptions` (a webhook that records an
  already-paid subscription must not be rejected — that is a Phase 5 design question); no requirement that signup
  itself fail in the database when the charity is missing (that would break admin bootstrap and admin-created
  users); no automatic re-selection.
- **The archived-between-checkout-and-payment window is resolved in Phase 5 (D-069):** the first payment is
  attributed to the charity chosen at Checkout even if it was archived afterwards.
- **Tests:** `supabase/tests/charity.test.ts` (trigger: valid/archived/missing/malformed/upper-case, nothing else
  read, privileges unchanged), `apps/api/src/charities/service.test.ts` (the precondition),
  `apps/web/src/charities.test.tsx` and `routes.test.tsx` (signup form, pre-selection, redirect, login link).
- **Verified on the hosted project (2026-09-21):** migration applied (all 14 identical); real browser signups record the
  chosen charity; the pre-signup choice survives signup and login; archived, unknown and malformed charities never
  become the selected charity; the subscription precondition works against the hosted database — TESTING.md §3c.

### D-067 — Plans, Stripe Checkout and Billing Portal, and checkout eligibility

- **Status:** ACCEPTED (dev) — **implementation decisions.** Those marked **Owner** were confirmed by the owner on
  2026-09-21 (**D-070**); the rest stay provisional (pending D-024 and D-030). The PRD requirements they serve are listed
  first and are not provisional.
- **How to read the Phase 5 decisions (D-067, D-068, D-069).** Every rule below is labelled: **PRD** = stated in the
  Digital Heroes PRD; **Owner** = decided by the project owner (dated); **Implementation** = chosen by us to build a
  PRD requirement, **not in the PRD**, changeable, and awaiting the owner where marked. Nothing labelled
  _Implementation_ should be quoted as a product requirement.
- **PRD requirements served:**
  - **SUB-01** a monthly plan and a yearly plan **at a discounted rate**.
  - **SUB-02** the gateway is Stripe (or an equivalent PCI-compliant provider).
  - **SUB-03** non-subscribers have restricted access (scope: D-030, open).
  - **CHR-01** users select a charity at signup.
- **Owner decisions applied:** **D-066 (2026-09-21)** — a selected, **active** charity is required to subscribe; an
  archived one blocks subscribing until replaced; no charity is ever substituted.
- **Implementation decisions (not in the PRD):**
  - **Owner (D-070): prices and currency are configuration, not PRD requirements and not code (ASM-07).** They live in
    Stripe (the prices) and in `plans` rows (name, interval, integer `amount_minor`, currency, `stripe_price_id`), entered
    by the owner (a labelled dev-only example is in the README). A plan without a Stripe price is never sold. No code,
    migration or seed contains a price, currency or price id (tested); a read-only readiness check compares `plans` with
    Stripe. **No price, discount, currency, tax rule or trial is decided** (D-024's values stay open).
  - **SUB-01's "discounted rate" is enforced as:** the yearly plan is offered and sold only if it is in the same currency
    as, and strictly cheaper than 12 × the monthly plan — a cross-row rule a table cannot express, so it lives in one
    function (`purchasablePlans`) used by the listing and by checkout. If the catalogue breaks it, the yearly plan is
    unavailable (`422 plan_unavailable`), never sold at the wrong price.
  - **Checkout** (`POST /api/me/subscription/checkout {interval}`): a Stripe-hosted Checkout Session, `subscription`
    mode, one price. The server decides everything except the interval: the user from the verified token, the price from
    the plan, the charity and percentage from the user's own stored choice — a `userId`, price, amount or charity in a
    request is ignored. **Card details are entered on Stripe's page and never reach this server (SUB-02).**
  - **Eligibility to start a checkout, in this order:** signed in → **no open subscription** (`409 already_subscribed`)
    → **`requireSubscribableCharity()` (the D-066 rule), before anything is created at Stripe** → a purchasable plan →
    Stripe. **"Open" is a separate question from access** (D-068): a subscription Stripe could still bill or bring back
    — pending, active, and **lapsed-but-overdue (`past_due`, `unpaid`, `paused`)**. So a user whose renewal failed has no
    access, yet cannot start a second subscription while Stripe is retrying the first, which could charge them twice.
    A cancelled subscription, or a lapsed one that expired (`incomplete_expired`), is over: the user may subscribe again.
    The rule is the SQL function `has_open_subscription()`, defined by what is _over_ at Stripe, so a status Stripe adds
    later blocks too (fails safe).
  - **Idempotency:** the same user, plan, charity and percentage within a 5-minute window share one Stripe idempotency
    key, so a double-click cannot create two sessions.
  - **Billing Portal** (`POST /api/me/subscription/portal`): update the card, switch plan, cancel — all at Stripe;
    needs a Stripe customer (`409 no_billing_account`) and only ever opens the caller's own.
  - **Test mode only:** only `sk_test_`/`rk_test_` keys are accepted (a live key stops the API starting, ASM-11).
    Without keys the API starts; plans and the user's own subscription load; checkout, portal and webhook answer `503`.
    Stripe logic is confined to `apps/api/src/billing/`, and only `gateway.ts` imports the SDK.
  - **Errors:** `400 validation_failed`, `401`, `403 profile_missing`, `409 already_subscribed | no_billing_account`,
    `422 charity_required | selected_charity_unavailable | plan_unavailable`, `502 payment_provider_error`, `503`.
- **Still open (owner):** the prices and the size of the discount, currency, tax/VAT, any trial (D-024).

### D-068 — Subscription state from Stripe: access versus checkout eligibility

- **Status:** ACCEPTED (dev) — **implementation decisions.** Those marked **Owner** were confirmed on 2026-09-21 (**D-070**);
  the rest stay provisional (pending D-026 and D-030). Labels as in D-067.
- **PRD requirements served:**
  - **SUB-04** renewal, cancellation and lapsed-subscription states are handled.
  - **SUB-05** a **real-time subscription status check on every authenticated request** (D-039).
  - **SUB-03** non-subscribers get restricted access (scope: D-030, open).
- **Implementation decisions (not in the PRD):**
  - **Stripe is the source of truth; webhooks synchronise it (ASM-06).** SUB-05's check reads that synchronised local
    state on every request (the SQL function below); it does not call Stripe per request. **Whether it should — for
    example when the local period has ended — is the owner's decision (D-026), not made here.**
  - **Webhook handling.** `POST /api/webhooks/stripe` is mounted with `express.raw()` **before** `express.json()`: the
    signature is checked over the exact bytes Stripe sent (re-serialised JSON never verifies), with the SDK's own check and
    its 5-minute replay tolerance (a _signature_ tolerance, unrelated to subscription access). The signature is the
    authentication. A bad, missing or stale signature, an unreadable event or a **live-mode** event → `400`, one generic
    body. Each event id is recorded in `stripe_events`; a redelivery is acknowledged and skipped. Every step is replay-safe:
    `record_subscription_payment()` is keyed by the invoice id and writes a payment and its charity contribution **together
    or not at all**; a succeeded payment is never downgraded by a late failure event. **Events are order-safe:**
    `apply_provider_subscription()` ignores an event older than the state stored, and an invoice that arrives before its
    subscription pulls it from Stripe. A second live subscription is **not applied** (D-044) and is kept as failed for a
    person — nothing is cancelled or refunded automatically. The ledger stores **no customer names, emails or addresses**.
  - **Answers to Stripe.** `200` for anything applied, ignored, duplicate, or well-formed but never applicable (recorded
    as failed and acknowledged, because a retry would fail the same way); `500` (generic) for a transient failure, so
    Stripe redelivers. Handled: `checkout.session.completed`, `customer.subscription.created|updated|deleted`,
    `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed`. **Refunds and chargebacks are not handled.**
  - **Owner (D-070) — ACCESS: `is_active_subscriber()` has NO tolerance and NO grace, and never falls back to Stripe.** A user has access exactly while their
    subscription is `active` **and** the paid period we have recorded has not ended (`current_period_end > now()`). **It
    permits nothing beyond that:** no extra days, no allowance for a late webhook, no access for a subscription that is
    not `active`. The consequences are accepted and stated: (a) `past_due`, `unpaid`, `paused`, lapsed, pending and
    cancelled subscriptions have **no access** — an overdue payment loses access **at once**, before any retry succeeds;
    (b) cancelling at period end keeps access until `current_period_end` and not a moment after, even if the "deleted"
    webhook is late; (c) at a renewal boundary access resumes when the renewal (the new period) is **recorded**, normally
    seconds after Stripe advances it, and during a webhook outage a user is cut off at the end of the period we last
    recorded — **it fails closed on purpose.** _This replaces an earlier 3-day tolerance, which was removed because
    it granted access for a delayed webhook and no specific technical reason required it._
  - **ELIGIBILITY — `has_open_subscription()` — is a different rule and differs on purpose.** The two, side by side:

    | Stripe status              | Local status | Access now?                                  | Blocks a NEW checkout?                      |
    | -------------------------- | ------------ | -------------------------------------------- | ------------------------------------------- |
    | `active`, `trialing`       | active       | yes, while the recorded period has not ended | yes                                         |
    | `incomplete`               | pending      | no                                           | yes (first payment unconfirmed)             |
    | `past_due`                 | lapsed       | **no** — at once                             | **yes** — Stripe is retrying; no 2nd charge |
    | `unpaid`, `paused`         | lapsed       | no                                           | yes (can be reactivated)                    |
    | `incomplete_expired`       | lapsed       | no                                           | no (never became active: over)              |
    | `canceled`                 | cancelled    | no                                           | no (over)                                   |
    | anything Stripe adds later | —            | refused rather than guessed (not stored)     | yes (fails safe)                            |

  - **Cancellation takes effect at the end of the paid period:** cancelling in the portal leaves Stripe's status `active`
    with `cancel_at_period_end`, so access continues until the period ends, then Stripe deletes the subscription and it
    becomes `cancelled` (`ended_at`). An immediate cancellation in Stripe ends access at once. Renewal moves the period and
    is a new payment. A plan switch follows the price on the same subscription.
- **Decided by the owner (D-070):** no grace for `past_due` (access stops at once); the check never asks Stripe when the
  recorded period has ended (fail closed).
- **Still open (owner):** refunds, chargebacks and plan-switch proration (D-026); the scope of restricted access (D-030).
- **Tests:** `apps/api/src/billing/{lifecycle,webhooks,routes,gateway,repository}.test.ts`, `supabase/tests/billing.test.ts`
  (the access/eligibility matrix on PostgreSQL).

### D-069 — Charity contribution amount and attribution; yearly plans in monthly pools

- **Status:** ACCEPTED (dev) — **implementation decisions.** Those marked **Owner** were confirmed on 2026-09-21 (**D-070**);
  the rest stay provisional. Labels as in D-067.
- **PRD requirements served:**
  - **CHR-02** the minimum contribution is **10% of the subscription fee**; **CHR-03** users may voluntarily increase it.
  - PRD §11: admins see **charity contribution totals**.
  - **DRW-07** _a fixed portion of each subscription_ contributes to the prize pool.
  - **The PRD does not say:** what the fee is measured on (gross, net, tax), how to round, how a yearly payment is
    treated for the charity or for the monthly prize pools, or how a contribution is corrected.
- **Owner decisions applied:** **D-064 (2026-09-21)** the percentage may be any value from 10% up to 100% and may be raised
  or lowered; **D-066** the charity is required and active to subscribe.
- **Implementation decisions (not in the PRD):**
  - **Owner (D-070) — amount and basis.** The contribution is the chosen percentage of **the amount actually collected,
    before tax, after discounts/coupons, gross of Stripe's fees**, **rounded up to the smallest currency unit** — so the
    charity never receives less than the percentage the user chose (and never less than CHR-02's 10%). From the invoice:
    `collected × (total before tax ÷ total)`, exact integer (BigInt) arithmetic with a single rounding, never more than the
    basis (the table enforces `amount ≤ basis`). A fully paid invoice's basis is exactly its pre-tax total; a partly paid one
    counts only its pre-tax part; **Stripe's processing fees are not deducted** (they are the platform's cost); a coupon has
    already reduced what was collected. An invoice with nothing collected records **no payment and no contribution**.
  - **Owner (D-070) — historical snapshot (CHR-02/03 need it; §11 totals depend on it).** Each payment stores **its own** charity,
    percentage, basis and amount in `charity_contributions`, written once, atomically with the payment. **A stored
    contribution can never be rewritten:** the table is **append-only** (no `UPDATE`, no `DELETE`, enforced by a trigger,
    like the audit log). **The payment is frozen too** once it has succeeded (amount, currency, payer, subscription,
    invoice, date and period never change; never deleted; only `succeeded → refunded`, state only). Archiving a charity, the
    user changing their charity or percentage, or Stripe replaying an invoice changes nothing already recorded; a later
    payment simply gets its own snapshot. (What a refund means for a charity's total, D-026, is open.) Removing dev/test rows
    needs the database owner to disable the triggers.
  - **Which charity and percentage a payment uses (the archived-between-checkout-and-payment case).** The **first**
    payment uses what the user agreed to **at Checkout** (carried on the subscription's metadata) even if their choice
    changed since **or the charity was archived**: the money was paid on their instruction, and archiving hides a charity
    from the public but does not erase it (D-043), so it is still a valid recipient. A **renewal** uses the user's
    **current** choice (again even if archived, until they replace it — a new checkout is blocked meanwhile, D-066),
    falling back to the checkout snapshot if none is selected. **If no charity can be found the payment is not recorded and
    the event is kept as failed** — money is never left unattributed.
  - **Yearly plans — the charity share.** Taken **in full when the yearly payment is made**, like any other payment.
  - **Owner (D-070) — yearly plans in monthly prize pools: an implementation rule, NOT a PRD requirement.** DRW-07 says
    only that a fixed portion of _each subscription_ contributes to the pool; it never says how a yearly payment reaches a
    _monthly_ draw. Decided: **allocate 1/12 of the applicable prize-pool basis to each monthly draw the yearly payment
    covers**, so pools are not spiky and each active subscriber contributes evenly. **Not built** (there is no draw engine).
    What Phase 5 provides so it can be applied: **every payment records its amount, currency and the period it paid for**
    (`payments.period_start/period_end`, from the invoice), which the subscription's own period cannot keep because it moves
    on each renewal. **Not decided:** the "applicable prize-pool basis" (the pool portion, D-014) and how the integer
    remainder of a 1/12 split is assigned — both belong with the draw engine.
- **Still open (owner):** payouts to charities; refunds (does a refunded payment reduce a charity's total?); donation
  minimums; a product cap below 100% (`charity_max_bps`); the pool portion and basis (D-014).
- **Tests:** `packages/shared/src/billing.test.ts` (the money rule), `apps/api/src/billing/webhooks.test.ts` (basis,
  snapshot, replays, archived cases), `supabase/tests/billing.test.ts` (atomic, idempotent, **append-only**, constraints).

### D-070 — Phase 5 owner decisions (2026-09-21)

- **Status:** ACCEPTED (project) — **owner decisions, 2026-09-21.** They lock rules that D-067, D-068 and D-069 had
  proposed as provisional implementation decisions. Each is labelled by what it is: a decision that gives effect to a **PRD**
  requirement, or an **implementation rule that is not a PRD requirement** (stated explicitly, so it is never quoted as one).
- **1. No grace period for `past_due`.** _(gives effect to PRD SUB-04/SUB-05.)_ Access requires `status = 'active'`
  **and** `current_period_end > now()`. A `past_due` subscription is `lapsed` and has no access, at once, while Stripe retries.
  It still blocks a second checkout (D-068), so it cannot be charged twice. Implemented in `is_active_subscriber()`.
- **2. Fail closed when the recorded paid period ends; Stripe is never an entitlement fallback.** _(gives effect to PRD
  SUB-05.)_ The per-request check reads the recorded state and nothing else. It does **not** call Stripe when the period has
  ended or when a webhook is late: a user is entitled only for a period we have recorded as paid. A test reads the source and
  fails if anything that decides access imports the billing module or the Stripe SDK.
- **3. Yearly plans in monthly prize pools — an implementation rule, NOT a PRD requirement.** The PRD (DRW-07) says only that
  "a fixed portion of each subscription" funds the pool. Decided: a yearly payment funds the pool by allocating **1/12 of the
  applicable prize-pool basis to each monthly draw it covers**. Not built — there is no draw engine, and none is started
  here. What is in place so it can be applied exactly: every payment records its `amount_minor`, `currency` and the period it
  paid for (`period_start`/`period_end`). **Not decided by this entry:** what the "applicable prize-pool basis" is (the pool
  portion, D-014, stays open) and how the integer remainder of a 1/12 split is assigned — both belong with the draw engine.
- **4. Charity contribution basis and rounding.** _(gives effect to PRD CHR-02/CHR-03: "10% of the subscription fee",
  raisable.)_ The contribution is the chosen percentage of **the amount actually collected, before tax, after
  discounts/coupons, gross of Stripe's fees**, **rounded up to the smallest currency unit**. Precisely: from the paid
  invoice, `collected × (total before tax ÷ total)` — so a fully paid invoice's basis is exactly its pre-tax total, a partly
  paid one (a credit balance covered the rest) counts only its pre-tax part, and no tax is ever counted; Stripe's own
  processing fees are not deducted; a coupon has already reduced what was collected. One exact integer calculation with a
  single rounding (`computeInvoiceContribution`); the recorded basis is rounded up too, keeping `amount ≤ basis`. An invoice
  with nothing collected records no payment and no contribution.
- **5. Historical snapshots are append-only.** A payment's **charity contribution** (charity, percentage, basis, amount) can
  be neither updated nor deleted. A **payment** is frozen once it has succeeded: its amount, currency, payer, subscription,
  invoice, date and covered period never change and it is never deleted; the only permitted move is `succeeded → refunded`
  (state only), and a refund leaves the contribution as it was (what a refund means for a charity's total is D-026, open). A
  payment attempt that has not succeeded may still evolve (a failed attempt becoming the success). Archiving a charity, or
  the user changing charity/percentage, changes nothing recorded. Enforced by triggers in the database.
- **6. Prices and currency are configuration, not requirements.** The PRD sets no price, discount or currency, and none is
  invented: they are configured in Stripe (the prices) and in the `plans` table (which points at them). No code, migration or
  seed contains a price, a currency or a Stripe price id (a test enforces it). A **read-only readiness check**
  (`npm run preflight:stripe -w @gather/api`) confirms the two sides agree — amount, currency, interval, mode, that the yearly plan
  is a real discount — before anything is verified. The values themselves (D-024) are still to be chosen and entered as configuration.
- **Not decided here:** the actual prices/discount/currency/tax/trial (D-024); the pool portion and basis (D-014); the 1/12
  remainder rule; refunds, chargebacks, proration and payouts (D-025/D-026); the scope of restricted access (D-030).
- **Tests:** `supabase/tests/billing.test.ts` (1, 2, 5), `packages/shared/src/billing.test.ts` and
  `apps/api/src/billing/webhooks.test.ts` (4), `apps/api/src/billing/lifecycle.test.ts` (1, 2),
  `apps/api/src/billing/boundaries.test.ts` (2, 6), `apps/api/src/billing/preflight.test.ts` (6).

### D-071 — Draw engine: matching, number range, weighting, prize pool, tiers, rollover and lifecycle (2026-09-22)

- **Status:** ACCEPTED (project) — **owner decisions, 2026-09-22**, resolving the parts of D-011/D-012/D-013/D-016/
  D-018/D-019/D-020 that the draw engine needs to run at all. Each rule below is labelled **Owner** (given verbatim
  or by direct, unambiguous implication in the kickoff instruction) or **Implementation** (this codebase's own
  mechanism for applying an Owner rule, not a new business value) — the same convention as D-067…D-070. Nothing
  labelled _Implementation_ should be quoted as an owner decision. What remains genuinely open is listed at the end
  of each superseded entry (D-011…D-020) and is **not** resolved here.
- **PRD requirements served:** DRW-01, 03, 04, 05, 06, 07, 08, 09 (§06/§07); DSH-04 was not built in this phase (no
  dashboard, per the kickoff instruction) — its read endpoint was added in Phase 8 (D-073).
- **Owner — a ticket is the user's latest scores (resolves D-011's "what does a user hold").** Each ELIGIBLE user's
  ticket is the (up to five) distinct values among their latest Stableford scores. A user with fewer than five
  scores simply has a smaller ticket (D-016) — and, as a direct mathematical consequence, cannot reach a match count
  higher than their ticket's size, so a user with three scores can never win the 5-match tier. Nothing further was
  decided about eligibility beyond who is a ticket-holder; who counts as "eligible" is Implementation, below.
- **Owner — the draw range is 1-45, five DISTINCT numbers (resolves D-012).** Configured, not hard-coded, using the
  exact column the schema was built for: `platform_settings.draw_number_min/max`, seeded to 1/45 by migration
  `…150000` (D-012's "NULL until decided" is now decided; the column stays changeable without a code change).
- **Owner — matching is order-independent, highest tier only (resolves D-011's remaining questions).**
  `match_count` = the size of the set intersection between the ticket's distinct values and the draw's five
  (already-distinct) numbers — never position-based, and a repeated ticket value (e.g. the same score twice) counts
  once, not twice, because both ticket and draw are treated as sets. `match_count` is a single 0-5 integer, so a
  5-match can never ALSO separately register as a 3-match — "highest tier only" is a structural consequence of
  storing one `match_count` per entry (already the Phase 1 schema), not a rule needing separate code.
- **Owner — random mode: standard-lottery, uniform, without replacement (resolves the random half of D-012).** Five
  distinct numbers drawn uniformly from the configured range, deterministic with an injected random source (partial
  Fisher-Yates), matching PRD §06 "standard lottery-style" and the plan already recorded in TESTING.md ("generates 5
  numbers in range; deterministic with a seeded RNG").
- **Owner — algorithmic mode: weighted by score frequency (resolves the part of D-013 needed to run it).** The
  probability of a number being drawn is proportional to `weight(number)` = how many currently-eligible users have
  it in their (deduplicated) ticket — the plain reading of "weighted BY frequency" (weight ∝ frequency), over the
  population the ticket rule already defines (this draw's eligible users, not a separate historical population).
  Selection is weighted sampling without replacement. **Implementation, to guarantee exactly five numbers always:**
  once every positively-weighted number has been chosen, remaining slots are filled uniformly at random among the
  zero-weight numbers — this never changes which numbers are FAVOURED, only what happens once favoured numbers run
  out (e.g. very few distinct scores exist yet). **Still open (D-013's residual, not decided by this entry):**
  whether a future owner might prefer to favour RARE scores instead, or a different population (e.g. historical
  scores across many draws) — the current reading is the plain-language one and is easy to change in one function
  (`drawAlgorithmicNumbers`) if revisited.
- **Owner — prize tiers, jackpot rollover, equal split (confirms D-035, resolves D-019's synchronous case and
  D-020).** 40/35/25% tier shares (already seeded, unchanged); only the 5-match jackpot rolls over; winners in a
  tier split it equally; money stays integer minor units throughout.
  - **Implementation — "unclaimed" (D-019), for what CAN be known synchronously at publish time:** zero winners for
    the 5-match tier at the moment the draw is published. A winner who is later rejected in verification is a
    SEPARATE, still-open question (D-019's residual — verification happens after publish, in the already-built
    winners workflow, and is not re-opened by the draw engine). No cap on the rolled-over amount (none is
    configured anywhere); it carries to the next **published** draw with an earlier month, across any gap.
  - **Implementation — the equal-split remainder (D-020):** winners get the FLOOR of an equal share; the leftover
    minor units are recorded in the schema's own `remainder_minor` field and paid to no one — the least invented
    reading of "record whatever the decided rule produces" (`draw_tier_results.remainder_minor`'s own comment).
    Distinct from "unclaimed": a WON jackpot's remainder never rolls over even though the tier does; a non-rolling
    tier's (4- or 3-match) remainder and its zero-winner unclaimed pool both simply stay recorded, carried nowhere.
  - **Implementation — splitting the total pool across the three tiers:** each tier's share is rounded DOWN
    (floor), so up to two minor units of the total may be left unallocated to any tier — distinct from, and much
    smaller than, D-020's per-winner remainder.
- **Implementation — eligibility is "active subscriber at the moment the engine runs" (the part of D-016 not
  settled by the ticket rule).** Re-uses the SAME, single, already-locked definition (`is_active_subscriber`'s
  condition, D-068/D-070: `status = 'active'` and the recorded period has not ended — no tolerance), as a set
  (`active_subscriber_ids()`), rather than inventing a separate cutoff concept. **Still open (D-017, not resolved
  here):** a scheduled/automatic trigger, an entry cutoff time, and a timezone for "the month" beyond what D-041
  already fixed (a plain UTC date) — the engine only computes when an admin explicitly calls simulate/publish
  (DRW-05: "the admin can run simulations and publish results"), which needs no cutoff to exist.
- **Implementation — the prize pool amount, from the config the schema already provides (D-014's mechanism, not its
  value).** Reads `platform_settings.prize_pool_bps` **or** `prize_pool_per_subscription_minor` (never both,
  already enforced); **refuses — never guesses — when neither is configured** (`422 prize_pool_not_configured`),
  exactly the contract already written into that table ("NULL means not decided yet; code that needs a NULL value
  must refuse to proceed rather than guess"). In bps mode, the basis is the SAME "amount actually collected, before
  tax, gross of fees" already locked for the charity share (D-069/D-070) — summed over the subscription payments
  that fund this specific calendar month (see below) — so `prize_pool_bps` and `charity_bps` are two different
  percentages of the identical, already-defined figure, matching DRW-07's "portion of each subscription" and
  CHR-02's "percentage of subscription fee" as the same base amount. In fixed mode, the pool is
  `prize_pool_per_subscription_minor × ` the number of currently active subscribers (DRW-07: "based on active
  subscriber count"). **A currency is still required** even when nothing funds a month yet or fixed mode is used
  with no natural currency source; the currently active monthly plan's currency is used as the platform's one
  (refusing, again, if even that does not exist) — reusing existing data, inventing no new value.
- **Implementation — attributing a payment's basis to a calendar month, extending D-070's locked 1/12 yearly rule to
  be computable (D-015).** A monthly-interval payment's WHOLE basis funds the one month its billing period starts
  in. A yearly-interval payment's basis is split into twelve EQUAL monthly shares (floor division, with the
  remainder placed in the FIRST covered month) across the twelve consecutive months starting at its period's start
  month — the direct, literal generalisation of the already-decided "1/12 … to each monthly draw it covers," with
  no day-weighting invented. Every minor unit is accounted for exactly once across the whole span (nothing invented,
  nothing lost). **If the payments funding one month are not all in the same currency, the engine refuses**
  (`422 prize_pool_mixed_currency`) rather than summing incompatible amounts or silently discarding some — this
  system has no FX conversion and none is invented.
- **Owner (literal, from the kickoff instruction) — lifecycle stays DRAFT → SIMULATED → PUBLISHED, strictly linear.**
  Publishing is refused unless the draw is currently `simulated` (`422 draw_not_simulated`): the lifecycle cannot be
  skipped, matching DRW-05's two distinct admin actions ("run simulations" then "publish results"). Re-simulating an
  already-published draw is refused (`422`): a candidate snapshot may be replaced any number of times before
  publish, never after.
  - **Implementation — atomicity and idempotency, mirroring the codebase's established pattern for multi-row,
    must-not-half-write operations (`add_score`, `apply_provider_subscription`, `record_subscription_payment`).**
    Two service-role-only SQL functions (migration `…150000`) apply an ALREADY-COMPUTED result: `simulate_draw()`
    replaces a draw's candidate snapshot (winning numbers, every eligible entry, all three tier results) in one
    transaction, under a row lock; `publish_draw()` freezes the draw and creates winners from entries × tier
    results, ALSO under a row lock, and is idempotent by design — a second call on an already-published draw
    changes nothing and reports success (`already_published`) rather than erroring, so a retried or duplicated
    request, or two genuinely concurrent publish attempts, can never create a second set of winners.
  - **Implementation — the snapshot's immutability is what makes "later score changes cannot alter a historical
    draw" true.** `simulate_draw()` is the ONLY place scores are read into a draw; the result (each entry's numbers
    and match count) is a real, stored snapshot from that moment, not a live computation. A user editing their
    scores afterward changes nothing already simulated; only an explicit re-simulate (never possible once published,
    by the rule above) would pick up new scores. All matching/weighting/pool/tier maths is PURE TypeScript (domain
    functions with the clock and random source passed in, per the codebase's own stated architecture); the SQL
    functions only ever apply an already-computed result, never compute one themselves.
- **Not decided here (still open):** the exact prize-pool bps/fixed value (D-014); a scheduled trigger, entry
  cutoff and timezone beyond UTC (D-017); whether a rejected-verification winner should be treated as "unclaimed"
  after the fact (D-019's residual); whether algorithmic weighting should ever favour rare scores or a different
  population (D-013's residual); payout mechanics and admin permission granularity (D-021…D-023, unaffected by this
  phase — winners/proof/payout use the already-built Phase 1 schema, untouched).
- **Deliberately not built (at the time):** the draw engine has no scheduler/cron — an admin explicitly creates,
  simulates and publishes a draw (no dashboard UI, per the kickoff instruction); a "my participation" read
  endpoint (DSH-04) was not added then (not required by the engine itself, and the instruction excluded
  dashboard-adjacent UI work) — **added in Phase 8, see D-073.**
- **Tests:** `apps/api/src/draws/domain.test.ts` (matching, both modes, pool/tier maths, rollover, remainder —
  pure, no database), `apps/api/src/draws/{repository,service,routes}.test.ts` (orchestration, configuration
  refusals, authorization, the full HTTP lifecycle, idempotent/concurrent publish),
  `supabase/tests/draws-function.test.ts` (the two SQL functions on real PostgreSQL: atomicity, idempotency,
  service-role-only privileges, a genuine two-month rollover chain), `packages/shared/src/draws.test.ts` (request
  validation).

### D-072 — Winner verification and payout tracking: resubmission, upload transport, payout ordering, audit (2026-09-22)

- **Status:** ACCEPTED (project) — **implementation decisions**, made by this codebase (not the owner) because
  D-021/D-022 leave them genuinely open and Phase 7 needs a concrete, working mechanism. Each point below is
  labelled **PRD** (§09/§11, already settled by D-037), **Implementation** (this codebase's own mechanism, not a
  new business value, chosen as the minimal, most-consistent-with-the-existing-architecture reading), or **Still
  open** (not resolved here). Winner CREATION itself is untouched — `publish_draw()` (D-071, migration `…150000`)
  already creates exactly one winner per matching entry of a published draw, and the existing `winners_one_per_user_per_draw`
  unique constraint plus the `guard_winner()` trigger (migration `…100500`) already make a duplicate or
  unpublished-draw winner impossible; Phase 7 adds only the four lifecycle transitions after that point.
- **PRD — the state machine.** Proof is a screenshot of scores; verification applies to winners only; admin
  approves or rejects; payout goes Pending → Paid (D-037). Realised as `awaiting_proof → pending_review →
approved | rejected`, with `rejected` explicitly re-openable back to `awaiting_proof` for resubmission.
- **Implementation — resubmission after rejection (D-021's open "what happens to rejected proof?").** `rejected`
  stays a real, queryable, persisted state (not silently collapsed back to `awaiting_proof`), so admin/analytics
  queries can honestly show it. Resubmission is a distinct, **winner-triggered** step (`reopen_winner_proof()`,
  SQLSTATE `GS010` if not currently `rejected`) — chosen over an admin-triggered or automatic reopen because the
  task's own framing ("winner can upload/reopen") reads as a self-service action, and it needs no schema change.
  Each resubmission round accumulates a NEW `winner_proofs` row rather than overwriting the last one (the table
  already allowed multiple rows per winner, migration `…100500`'s own comment anticipated exactly this). On
  reopen, `reviewed_at`/`reviewed_by`/`review_note` are cleared to "nothing decided yet" — required by the
  existing `winners_review_timestamp` CHECK constraint, which ties those three columns to the CURRENT decision,
  not history; the permanent record of who rejected what, and why, lives in `admin_audit_log` instead (written
  by the API alongside the admin's `review_winner()` call).
- **Implementation — proof upload transport (not decided by any prior DECISIONS entry).** The screenshot's BYTES
  go directly browser → the private `winner-proofs` bucket, using the winner's own session, gated entirely by
  the storage RLS policy already written in migration `…100800` (`winner_proofs_objects_insert_owner`: the
  owner of the named winner record, into `<winner_id>/…`, only while `awaiting_proof`). This is not a new
  design choice invented for this decision — it is the ONLY reading consistent with that policy's own shape:
  the policy encodes a business rule (upload only while `awaiting_proof`) that would be pointless to write in
  RLS if every upload were instead going to go through the service role (which bypasses RLS entirely), and the
  Phase 1 migration's own comment says so explicitly ("Downloads are served via short-lived signed URLs issued
  by the API — the bucket is never made public", implying uploads are not). The API never sees the file bytes;
  it only ever records METADATA (`winner_proofs.storage_path`) and drives the state machine, via
  `register_winner_proof()` — which independently verifies, server-side, that the referenced object actually
  exists (`storage.objects`) and sits under the caller's own winner folder (SQLSTATE `GS009`, defence in depth
  alongside the pre-existing `winner_proofs_path_under_winner` CHECK) before trusting a client's claim.
- **Implementation — secure proof access (item 4 of the phase brief; not previously decided how).** Every read
  of a winner's detail (owner's own, or an admin's) issues a FRESH short-lived (5-minute) signed URL per proof
  via the service-role `createSignedUrl`, matching ARCHITECTURE.md §10's already-stated intent ("downloads use
  short-lived signed URLs issued by the API"); the bucket itself is never made public and no permanent/public
  URL is ever returned. The 5-minute TTL is a development default (D-051-style), not a PRD value.
- **Implementation — payout ordering, extending D-022's explicitly open "may a payout be marked Paid before
  proof is approved?".** A payout may be marked paid **only once verification is `approved`**
  (`mark_winner_paid()`, SQLSTATE `GS012`), enforced in exactly one place so it can be relaxed later if the
  owner decides otherwise. Chosen because it is the plain, minimal-invention reading of "the admin can verify
  winners and payouts" (ROL-04/ADM-06: verification precedes payout in every mention) and because paying out
  before verifying would defeat the purpose of verification. The schema itself still does **not** enforce this
  (migration `…100500`'s original comment: "`paid` does not require `approved`, not enforced") — the ordering is
  entirely an application-level (function-level) decision, not a new constraint, so it stays reversible without
  a migration.
- **Implementation — payout idempotency.** Marking an already-paid winner paid again is a safe no-op (same
  `paid_at`/`paid_by`, mirroring `publish_draw()`'s established idempotency pattern), so a retried admin click
  or a genuine double-submit can never silently reassign credit for a payout to a second admin.
- **Implementation — admin actions are audited (D-052, ARCHITECTURE.md §13 "each admin action... in the same
  request").** `review_winner()` and `mark_winner_paid()` are each followed by an `admin_audit_log` insert
  (`winner.approved` / `winner.rejected` / `winner.paid`) written by the API in the same request, the first
  actual use of that table outside its own schema tests. Not retrofitted onto Phase 6's `simulate`/`publish`
  admin actions — out of scope for this phase, and flagged here as a real, currently-unaudited gap rather than
  silently left unmentioned.
- **Still open (not resolved here):** a claim deadline; what the admin actually checks the screenshot against
  (still a human judgement call — no OCR or image processing exists, ARCHITECTURE.md §10); the real payout
  mechanism (bank transfer, manual, …) and whether further payout states exist (D-022's residual); whether a
  winner who never completes verification should feed back into the draw engine's "unclaimed" jackpot rollover
  (D-019's residual, genuinely separate from this phase's synchronous reject/approve — the draw engine only
  looks at zero-winner tiers at publish time, never at post-publish verification outcomes); finer admin
  permission granularity (D-023).
- **Tests:** `apps/api/src/winners/{repository,service,routes}.test.ts`, `supabase/tests/winners-function.test.ts`
  (the four SQL functions on real PostgreSQL: atomicity, idempotency, service-role-only privileges, the full
  resubmission round-trip against the real storage RLS policy), `supabase/tests/storage.test.ts` (extended: a
  reopened winner's upload is permitted again by the SAME pre-existing policy), `packages/shared/src/winners.test.ts`
  (request validation).

### D-073 — User dashboard: composition, the one missing endpoint, and what stays honestly unbuilt (2026-09-22)

- **Status:** ACCEPTED (project) — **implementation decisions**, made by this codebase because the PRD only
  lists WHAT the dashboard shows (DSH-01…05), not how it is composed from the already-built pages and APIs.
- **PRD — the five areas (§10).** Subscription status/plan/renewal/cancellation (DSH-01); score entry and edit
  (DSH-02); selected charity and percentage (DSH-03); draws entered and upcoming draws (DSH-04); winnings and
  payment status (DSH-05).
- **Implementation — composition: summaries + links, not five copies of the same logic (item 8: "do not
  duplicate business logic in the frontend").** Subscription, charity and winnings already have complete,
  tested pages (`/account/subscription`, `/account/charity`, `/account/winnings` — Phases 4/5/7) with real
  interaction Stripe Checkout/Portal, charity directory browsing, proof upload/reopen. The dashboard shows a
  live summary of each (same API calls, same DTOs, condensed rendering) with a link to the full page, rather
  than re-implementing checkout, the charity directory or proof upload a second time. Scores had **no** page at
  all (Phase 3 built only the API) and are simple enough to need no separate page, so DSH-02's full add/edit/delete
  interface is built directly into the dashboard.
- **Implementation — the one genuinely missing backend piece: `GET /api/me/draws` (DSH-04 "draws entered").**
  D-071 explicitly recorded that no such endpoint existed ("a 'my participation' read endpoint (DSH-04) was not
  added"). Added now, as the minimal missing piece the task instructions anticipated ("unless an existing
  contract is genuinely missing something required by the dashboard") — no migration, no new table, no RLS
  change: a plain service-role read of `draw_entries` joined to `draws`, **explicitly filtered to
  `status = 'published'`**, mirroring exactly what the pre-existing `draw_entries_select_own_published` RLS
  policy already restricts a direct browser read to (D-050: candidate results must never leak), the same
  "repository re-applies the filter RLS would have applied" pattern already used for charities (listed-only)
  and winners (owner-only). Winning numbers are included in the response because the draw is published, so
  they are already public information.
- **Implementation — "upcoming draws" (the other half of DSH-04): honestly not built.** D-017 (cadence, cutoff,
  schedule) is still open and nothing in this codebase knows when the next draw will run; a draft/simulated
  draw's candidate content must never leak to a non-admin regardless (D-050, re-verified by a test here). The
  dashboard says plainly that draws run monthly and a result appears once published — it does not fabricate a
  schedule or countdown, per the task's own instruction not to invent data to make the UI look populated.
- **Implementation — restricted access (D-030) is still not decided, and the dashboard invents no new gate.**
  Every section reads exactly what its existing endpoint already returns to a lapsed or non-subscribed user
  (e.g. scores stay readable per D-062; a subscription card simply shows "not subscribed yet"). No new
  client-side or server-side gating was added for this phase.
- **Implementation — each section loads and fails independently** (`useMyData`, `apps/web/src/lib/useMyData.ts`):
  one section's error (e.g. Stripe unconfigured, billing down) never blanks the other four, satisfying item 6
  (clear loading/empty/error states) at the level of each PRD area rather than one all-or-nothing page state.
- **Not decided here (still open):** D-017 (schedule), D-030 (restricted-access scope), D-023 (finer admin
  permissions) — unaffected by this phase.
- **Tests:** `apps/api/src/draws/{repository,service,routes}.test.ts` (the new endpoint: ownership scoping,
  published-only filtering, empty state), `apps/web/src/dashboard.test.tsx` (loading/empty/error per section,
  real-data rendering from real DTOs, cross-user isolation, full score add/edit/delete), `packages/shared/src/draws.test.ts`
  (the new path constant).

---

## 4. Unresolved product decisions

Each entry names what it **blocks** and its **schema impact**. "Owner" is the project owner unless stated.

### D-011 — What "matching 5/4/3 numbers" means

- **Status:** RESOLVED by owner decision, 2026-09-22 (**D-071**) — **Blocks:** draw engine, winner calculation,
  draw tests.
- **PDF says:** three match types (§06). It **never says** a user's scores are the numbers being matched.
- **Decided (D-071):** a user's ticket is the distinct values among their latest scores; matching is
  set-membership (order-independent), a repeated ticket value counts once; `match_count` is a single 0–5 number
  so "highest tier only" is automatic; a draw's five numbers are always distinct (D-012).
- **Schema impact:** neutral, as originally planned — `draw_entries.entry_numbers` snapshots the raw ticket;
  `match_count` (0–5) is stored.

### D-012 — Draw number range and random generation

- **Status:** RESOLVED by owner decision, 2026-09-22 (**D-071**) — **Blocks:** draw engine.
- **PDF says:** Random is "standard lottery-style" (§06). No range.
- **Decided (D-071):** range is 1–45 (mirroring the score range), five DISTINCT numbers, without replacement —
  configured via `platform_settings.draw_number_min/max`, seeded by migration `…150000`.
- **Schema impact:** as originally planned — `platform_settings.draw_number_min/max`, now seeded rather than NULL.

### D-013 — Algorithmic draw weighting

- **Status:** PARTIALLY RESOLVED, extended by owner decision, 2026-09-22 (**D-071**) — **Blocks:** algorithmic
  mode.
- **Resolved by PDF:** "weighted by score frequency" (§06); the random mode is not score-weighted.
- **Resolved by D-071:** weight ∝ frequency, over the currently-eligible population's (deduplicated) tickets;
  favours FREQUENT numbers (the plain reading of "weighted by frequency"); implemented as weighted sampling
  without replacement, filling any remaining slots uniformly once positive weights run out (so five numbers are
  always produced).
- **Still open:** whether a future owner might prefer to favour RARE numbers instead, or weight over a different
  population (e.g. historical scores across many draws, not just this draw's eligible users).
- **Schema impact:** neutral, as originally planned — only `mode = 'algorithmic'` is stored.

### D-014 — Prize-pool funding: portion, basis

- **Status:** PARTIALLY RESOLVED, mechanism completed by owner decision, 2026-09-22 (**D-071**) — **Blocks:**
  pool calculation, analytics, pricing display.
- **Resolved by PDF:** "a fixed portion of each subscription" funds the pool; tiers are calculated from the
  active subscriber count (§07).
- **Resolved by D-071 (mechanism, not value):** the engine reads `platform_settings.prize_pool_bps` **or**
  `prize_pool_per_subscription_minor` (never both) and refuses (`422 prize_pool_not_configured`) rather than
  guessing when neither is set; bps mode uses the same "gross, pre-tax, before provider fees" basis already
  locked for the charity share (D-069), summed per calendar month (D-015 below); fixed mode multiplies by the
  active subscriber count.
- **Still open:** the actual bps/fixed value to configure (a business/pricing choice, not an engine question).
- **Schema impact:** as originally planned — `platform_settings.prize_pool_bps` **or**
  `prize_pool_per_subscription_minor` (NULL until a value is chosen; never both); each draw snapshots the rule
  and amount it used.

### D-015 — Yearly subscriptions in monthly pools

- **Status:** ACCEPTED (project) — **owner decision, 2026-09-21 (D-070)**, as an **implementation rule that is not a PRD
  requirement** (DRW-07 does not say how a yearly payment reaches a monthly draw). Made computable by **D-071**
  (2026-09-22, below). **Remaining open:** the applicable prize-pool basis's bps/fixed _value_ (D-014).
- **Decided:** allocate **1/12 of the applicable prize-pool basis to each monthly draw** a yearly payment covers.
  (Rejected: the full amount in the month paid.) The charity share of a yearly payment is a separate matter: it is taken in
  full when the payment is made (D-069).
- **Resolved by D-071 (the exact split, and generalised to monthly payments too):** a monthly payment's whole
  basis funds the one month its period starts in; a yearly payment's basis splits into twelve EQUAL monthly
  shares (floor division, remainder in the first covered month) across the twelve months starting at its
  period's start month. Built in `apps/api/src/draws/domain.ts` (`monthlyPoolShare`/`poolFundingBasisForMonth`).
- **Schema impact:** neutral — `draws.prize_pool_minor` is an engine-computed snapshot; `payments.period_start/end`.

### D-016 — Draw eligibility and users with fewer than five scores

- **Status:** RESOLVED (mostly) by owner decision, 2026-09-22 (**D-071**) — **Blocks:** draw entries, winner
  calculation, dashboard participation.
- **PDF says:** users "must enter their last 5 golf scores" (§05); nothing about eligibility.
- **Resolved by D-071:** "active subscriber" reuses the SAME condition as `is_active_subscriber` (D-068/D-070),
  measured at the moment the admin runs simulate/publish; a user with 0–4 scores has a smaller ticket and, as a
  structural consequence of `match_count` being an intersection size, cannot reach a match count higher than
  their ticket's size (so they cannot win the 5-match tier with only 4 scores, but CAN win a 3- or 4-match tier
  with fewer than 5).
- **Still open:** none of this entry's original question remains open; D-017 (cadence/cutoff) is a separate,
  still-open concern about WHEN eligibility is measured relative to a schedule.
- **Schema impact:** neutral, as originally planned — entries hold 0–5 numbers.

### D-017 — Draw cadence, cutoff, timezone and trigger

- **Status:** OPEN — **Blocks:** scheduling, cutoff logic, "upcoming draws". **Not resolved by D-071** (2026-09-22):
  the draw engine only computes when an admin explicitly calls simulate/publish (DRW-05), which needs no
  schedule or cutoff to exist — but a scheduled/automatic trigger, an entry cutoff time and a timezone for "the
  month" beyond the plain UTC date already fixed by D-041 remain undecided.
- **Question:** day/time the month's draw closes, timezone, whether late scores count, manual vs scheduled.
- **Schema impact:** neutral — `scheduled_at` nullable; the month is a plain date.

### D-018 — Simulation and publish semantics

- **Status:** RESOLVED by owner decision, 2026-09-22 (**D-071**) — **Blocks:** admin draw management.
- **PDF says:** "simulation before publish"; admin runs simulations and publishes (§06, §11).
- **Resolved by D-071:** simulation writes a candidate snapshot (numbers, entries, tier results) that is fully
  REPLACEABLE while the draw is unpublished (a live re-simulate re-reads current scores/subscribers); publish is
  final — it freezes the draw and is refused unless the draw is currently `simulated` (lifecycle is strictly
  DRAFT → SIMULATED → PUBLISHED, never skippable); a published draw cannot be corrected by re-simulating or
  re-publishing (idempotent no-op instead); rollover is computed from the published tier results, not from any
  earlier simulation.
- **Schema impact:** as originally planned — simulation results are candidate rows, replaceable until published,
  then frozen (enforced by `simulate_draw()`/`publish_draw()` and the pre-existing immutability triggers).

### D-019 — Jackpot rollover rules

- **Status:** PARTIALLY RESOLVED, extended by owner decision, 2026-09-22 (**D-071**) — **Blocks:** carry-over,
  draw statistics.
- **Resolved by PDF:** only the 5-match tier rolls over; 4 and 3 do not (§07).
- **Resolved by D-071:** "unclaimed," for what can be known synchronously at publish time, means zero winners
  for the 5-match tier at the moment the draw is published; no cap (none is configured); carried to the next
  PUBLISHED draw with an earlier month, across any gap; a non-rolling tier (4/3) with zero winners simply leaves
  that tier's pot recorded and paid to no one — it does not roll anywhere.
- **Still open:** whether a winner who is later REJECTED in verification (after publish) should retroactively be
  treated as "unclaimed" and trigger a rollover — this is a separate question from the synchronous case D-071
  resolves, and is not addressed by the draw engine.
- **Schema impact:** neutral — `rollover_in/out_minor` are recorded by the engine; the verification-based
  residual still ties nothing to post-publish claim outcomes.

### D-020 — Remainder in equal prize splits

- **Status:** RESOLVED by owner decision, 2026-09-22 (**D-071**) — **Blocks:** winner prize amounts.
- **Question:** with integer minor units a tier prize may not divide equally; where does the remainder go?
- **Resolved by D-071:** each winner in a tier gets the FLOOR of an equal share; the leftover is recorded in
  `remainder_minor` and paid to no one. Distinct from D-019's rollover: a WON jackpot's remainder never rolls
  over even though the tier does; splitting the total pool across the three tiers is ALSO floor-rounded
  (up to two minor units may go unallocated to any tier) — a separate, smaller rounding from the per-winner one.
- **Schema impact:** as originally planned — `remainder_minor`; total allocation can never exceed the pool.

### D-021 — Winner proof and claim rules

- **Status:** PARTIALLY RESOLVED, extended by implementation decision, 2026-09-22 (**D-072**) — **Blocks:**
  verification flow refinements, storage limits.
- **Resolved by PDF:** winners only; screenshot of scores; admin approve/reject.
- **Resolved by D-072:** rejected proof CAN be resubmitted — the winner explicitly reopens (`rejected` stays a
  real state until they do), then a full new upload/register round-trip runs, accumulating a further
  `winner_proofs` row per attempt; file types/size are the pre-existing development defaults (PNG/JPEG/WebP,
  10 MiB, D-051), now also exposed from `@gather/shared` so the web form can check them client-side.
- **Still open:** a claim deadline; what the admin actually checks the screenshot against (a human judgement
  call — no OCR exists); unclaimed prizes as a DRAW-ENGINE concept (D-019's residual — separate from a winner
  simply never finishing verification).
- **Schema impact:** unchanged — multiple proof rows per winner are allowed; direct upload only while
  `awaiting_proof` (restrictive default, D-051); Phase 7 adds no migration to this table.

### D-022 — Payout mechanism and payment states

- **Status:** PARTIALLY RESOLVED, extended by implementation decision, 2026-09-22 (**D-072**) — **Blocks:**
  payout tracking refinements.
- **Resolved by PDF:** states Pending → Paid; admins "mark payouts as completed".
- **Resolved by D-072:** a payout may be marked paid ONLY once verification is `approved` — enforced by
  `mark_winner_paid()` (SQLSTATE `GS012`), not by a new schema constraint, so it stays a one-place, reversible
  decision if the owner later wants otherwise; marking an already-paid winner paid again is a safe no-op.
- **Still open:** how money actually reaches winners (bank transfer, manual, …); whether further payout states
  exist (rejected, expired) beyond pending/paid.
- **Schema impact:** unchanged — the `paid` column still does not itself require `approved` at the constraint
  level (D-072's ordering lives in the function, not a CHECK).

### D-023 — Admin permission model

- **Status:** PARTIALLY RESOLVED — **Blocks:** fine-grained authorization design.
- **Resolved by PDF:** one Administrator role with the §11 capabilities, including editing scores (D-038).
- **Still open:** finer permissions? how are admins created (currently only by a service-role/SQL operation)?
- **Schema impact:** single `admin` role; the API can add finer checks without schema change.

### D-024 — Plan pricing, discount, currency, tax and trial

- **Status:** OPEN — **Blocks:** Stripe products/prices, pricing UI, pool tests with real numbers.
- **PDF says:** yearly plan is at a "discounted rate" (§04); no numbers.
- **Question:** monthly price, yearly price/discount, currency, tax/VAT, trial.
- **Owner (D-070, 2026-09-21):** prices and currency are **configuration** (Stripe prices + the `plans` table), not PRD
  requirements and not code. **The values themselves are still undecided:** no price, discount, currency, tax rule or trial
  is assumed by any code, migration or seed (a test enforces it). Only a rule that follows from the PDF is enforced: the
  yearly plan must be cheaper than 12 monthly payments.
- **Schema impact:** no plan rows exist; currency stored per monetary row; any development placeholder must
  be labelled and kept out of migrations.

### D-025 — Charity contribution mechanics

- **Status:** PARTIALLY RESOLVED — **Blocks:** contribution calculation, charity reporting, donations.
- **Resolved by PDF:** minimum 10%; may increase; independent donation option (D-036).
- **Resolved by the owner (D-064, 2026-09-21):** the percentage may be any value from 10% up (to 100% or a
  configured cap) and may be raised **or lowered** at any time.
- **Resolved by the owner (D-070, 2026-09-21):** the basis is the amount actually collected, **before tax, after
  discounts/coupons, gross of Stripe's fees**; the contribution is **rounded up** to the smallest currency unit; each payment's
  snapshot is **append-only**. (Implementation: a yearly payment's charity share is taken in full when it is paid, D-069.)
- **Still open:** whether a product maximum below 100% applies; the effect of changing charity or lowering the percentage on
  past payments; donation minimums; whether visitors without an account can donate; how charities are actually
  paid out. These are payment concerns and are **not** decided or built in Phase 4 (which stores and validates the
  choice and validates the donation request shape only — D-065).
- **Schema impact:** contributions store basis, percentage and amount per payment; only `bps ≥ 1000` and
  `amount ≤ basis` are enforced; optional `platform_settings.charity_max_bps`; donations require an account.

### D-026 — Subscription lifecycle and how "real time" is achieved

- **Status:** PARTIALLY RESOLVED — **Blocks:** subscription state machine.
- **Resolved by PDF:** renewal, cancellation and lapsed states exist; the check happens on every
  authenticated request (D-039).
- **Still open:** cancellation immediate vs period end; plan switching; refunds/chargebacks; fate of a lapsed user's
  scores/winnings. (Grace period and Stripe-live vs webhook-synchronised state: **decided, D-070**.)
- **Resolved by the owner (D-070, 2026-09-21):** **no grace period** for `past_due` — access requires `status = 'active'`
  and `current_period_end > now()`; the check **fails closed** when the recorded period ends and **never calls Stripe** as a
  fallback (it reads webhook-synchronised state). A `past_due` subscription still **blocks a second checkout** (no double charge).
- **Implementation decisions (Phase 5, D-068 — not in the PRD, still provisional):** cancellation takes effect at the end of
  the paid period. Refunds/chargebacks and plan-switch proration are **not** handled and remain open.
- **Schema impact:** `provider_status` keeps the raw Stripe state; `cancel_at_period_end`, `cancelled_at`,
  `ended_at`; access is one function (`is_active_subscriber`) and checkout eligibility another
  (`has_open_subscription`), each changeable in one migration.

### D-027 — Which score is "oldest", and remaining edit rules

- **Status:** PARTIALLY RESOLVED — the two questions that blocked the score service were answered by the owner
  (D-061). **Still open, and deliberately not enforced:** future dates, a maximum age for a score, and
  changing a score's _date_ (Phase 3 supports editing a score's value only; to change a date, delete and add).
- **Resolved by PDF:** entries can be edited or deleted; one per date; newest-first display (D-034).
- **Resolved by the owner (D-061):** "oldest" = earliest round date; a back-dated score older than all five is
  rejected.
- **Schema impact:** the database refuses a 6th row (D-049); `add_score()` implements D-061; no future-date or
  age check exists.

### D-028 — Authentication method and account rules

- **Status:** OPEN (residual) — a **provisional** email + password implementation exists (D-056). **Blocks:** email-verification policy, password reset, social login — none of which Phase 2 builds.
- **Question:** email + password only, or social providers? Email verification? Password reset?
- **Phase 2 status:** signup, login, logout and session restoration use email + password (D-056). Still
  open: whether email confirmation is _required_ (a Supabase project setting the app handles either way),
  password reset, social providers, and any password-strength policy (Supabase enforces its own).
- **Schema impact:** `profiles` hangs off `auth.users`; a trigger creates a least-privilege profile. It reads
  one validated signup-data key, the chosen charity (D-066), and nothing else.

### D-029 — Analytics definitions

- **Status:** PARTIALLY RESOLVED — **Blocks:** admin reports.
- **Resolved by PDF:** the four report items: total users, total prize pool, charity contribution totals,
  draw statistics (ADM-07).
- **Still open:** exact definitions (registered vs active users; per-draw vs cumulative pool and rollover;
  accrued vs paid-out contributions and donations; which draw statistics).
- **Schema impact:** all raw facts are stored; no aggregate is baked in.

### D-030 — Scope of restricted access for non-subscribers

- **Status:** OPEN — **Blocks:** access-control matrix, dashboard gating.
- **PDF says:** non-subscribers "receive restricted access to platform features" (§04).
- **Question:** exactly which features are blocked; what can a registered but unsubscribed or lapsed user do?
- **Schema impact:** provisional restrictive default (D-050) in one function and one policy. Phase 3 adds a second provisional default: score **writes** need an active subscription, score **reads** are open to any signed-in user (D-062).

### D-031 — How the Express API is hosted on Vercel

- **Status:** OPEN — **Blocks:** deployment configuration (not local development).
- **Options:** run Express as a Vercel serverless function, or host the API elsewhere. Affects Stripe
  webhooks and cold starts. **Schema impact:** none.

### D-032 — Missing PRD pages, legal/regulatory scope, erasure

- **Status:** OPEN — **Blocks:** any non-functional targets; pre-launch sign-off.
- **Confirmed:** the PDF lacks the page numbered 11/14 (§13 technical requirements, §14 scalability).
  Can the owner supply it? Who owns legal review of the prize-draw mechanics, age/region eligibility, data
  protection and erasure policy?
- **Schema impact:** provisional RESTRICT foreign keys (D-053).

### D-033 — Charity content model and homepage spotlight

- **Status:** OPEN — **built provisionally in Phase 4 under D-065**; the owner has not decided these.
  **Blocks:** nothing now; a different answer changes content/UX, not the schema.
- **PDF says:** listing with search and filter; profiles with description, images and upcoming events "such
  as golf days"; featured charity on the homepage.
- **Question:** filter dimensions; event fields; image source; who edits profiles; one or several featured.
- **Provisional (D-065):** filters = free-text search, exact tag, featured only; events = title, description,
  location, start, optional end; images = files in the `charity-media` bucket with alt text; profiles are edited by
  administrators (tooling not built yet); several may be featured, the spotlight shows up to 6.
- **Schema impact:** free-form `tags` (an affordance, not a PRD field); `is_featured` is not unique; full-text
  search over name + description.
