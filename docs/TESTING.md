# Testing Strategy

Critical business rules **must** have automated tests before a feature is considered done. This document
defines the strategy in three layers. Layer 2 (database) is implemented; Layers 1 (domain) and 3
(end-to-end) are planned.

## 1. Principles

1. **Test the rules, not the framework.** The most valuable tests cover the PRD's business rules (scores,
   draw, prizes, charity share, access control).
2. **Pure domain modules first.** Rules are pure functions with the clock and random source injected, so they
   are fast, deterministic and need no database.
3. **Do not fake core integrations where the real one is expected.** Stripe is tested against real test-mode
   behaviour and correctly signed webhook payloads, not a hand-rolled fake. Mocks isolate a unit from things
   that are not the subject of the test.
4. **Tests reference requirement ids** (`SCR-05`, `DRW-09`, …) and decision ids (`D-027`, …) so coverage
   against the PRD is traceable.
5. **A test never encodes an unresolved decision.** If a rule is `OPEN` in DECISIONS.md, resolve it first.
   Where the schema deliberately stays neutral, a test asserts the neutrality (e.g. draw number range and
   repeats are _not_ constrained).
6. **A security test must be able to fail.** Security/integrity tests were validated by mutation (Section 4).

## 2. Current state

| Package           | Tool                                            | Tests | What exists                                                                                                               |
| ----------------- | ----------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` | Vitest                                          |   255 | PRD constants; **score validation** (Section 3b); **charity query/percentage/request validation** (3c)                    |
| `apps/api`        | Vitest + **light-my-request** (in-process HTTP) |   796 | Health, errors, config, authentication/authorization (3a), score engine (3b), **charity domain** (3c)                     |
| `apps/web`        | Vitest + Testing Library                        |   122 | Auth flows (3a); **charity directory, profile, spotlight and "my charity" pages** (3c)                                    |
| `supabase/tests`  | Vitest + **PGlite**                             |   290 | Migrations, constraints, immutability, RLS, storage, seed, `add_score()` (3, 3b), **charity search/selection guard** (3c) |

Commands (from the repo root):

```bash
npm test            # builds shared, then runs every workspace's tests (incl. database tests)
npm run typecheck   # strict TypeScript across all workspaces
npm run lint        # ESLint (type-aware)
npm run format:check
npm run check       # all of the above
npm run test -w @gather/db-tests   # database tests only (~3 s)
```

## 3. Layer 2 — Database tests (implemented)

**How they run.** `supabase/tests` boots an in-memory **PGlite** database (real PostgreSQL compiled to WASM;
PostgreSQL 18.3) per test file, loads a small Supabase shim (`support/supabase-shim.sql`: roles `anon` /
`authenticated` / `service_role`, `auth.users`, `auth.uid()`, `storage.buckets`/`objects`, Supabase's default
privileges), then applies **every file in `supabase/migrations/` in order**, exactly as a clean project would.
Role behaviour is exercised the way PostgREST does it: `SET LOCAL ROLE` plus the `request.jwt.claims` setting.
Every test runs in a transaction that is rolled back, so fixtures are shared safely. Errors are asserted by
SQLSTATE and constraint name, not by message text where avoidable.

| File                      | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.test.ts`          |    25 | Migrations apply cleanly and in order; every public table has RLS; **exact allow-list of privileges** for `anon`/`authenticated` (table and column level); `role` not writable by users; `SECURITY DEFINER` hardening; **exact allow-list of functions browser roles can execute (RPC surface)**; money is `bigint` minor units / no floats; percentages are basis points; timestamps are `timestamptz`; enums match `@gather/shared`; prize tiers seeded 40/35/25; settings NULL; bucket visibility; seed applies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `constraints.test.ts`     |    67 | Scores (range 1–45, date required, one per date, max 5 without silent deletion, per-user cap incl. multi-row insert, **replace-oldest works as a transaction / single CTE / function / in-place overwrite**, insert-before-delete rejected, upsert-edit and `ON CONFLICT DO NOTHING` work at the cap, duplicate date reported as a duplicate, edit at cap, cascade); profiles (10% minimum, default, FK, signup metadata cannot grant admin); charities (slug, description, events, full-text search, archive-vs-delete); plans/subscriptions (one active plan per interval, one live subscription, renewal date); payments/contributions (kind ↔ subscription, positive integer amounts, duplicate Stripe ids, ≥10% recorded percentage, amount ≤ basis, composite FKs on owner/currency/kind, one per payment); draws (month, mode, exactly 5 numbers, **range/repeats deliberately unconstrained**, completeness of published); entries (0–5 numbers, match 0–5, one per user); tier results (rollover only on the jackpot tier, allocation ≤ pool, no winners ⇒ no prize); winners (one per draw, tier and currency agree with entry/draw, paid/approved stamps); proof paths; Stripe ledger idempotency; settings shape |
| `immutability.test.ts`    |    12 | Published draws/entries/tier results cannot change (even as `service_role`); prize tiers edits cannot rewrite history; drafts stay editable and re-simulatable; winners only for published draws; verification and payout progress but the win is frozen; paid never reverts; winners never deleted; audit log append-only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `rls.test.ts`             |    46 | Visitor sees only non-archived charities/active plans/prize split and is denied everything else; **user isolation** across profiles, scores, subscriptions, payments, contributions, winners, proofs; no cross-user entitlement lookup via RPC; no direct writes (scores, billing, draws, winners, settings, audit); self-service profile edits only; no self-promotion; forged JWT `admin` claim ignored; draw visibility for subscriber / non-subscriber / lapsed participant; candidate simulation results never leak; access follows live subscription state; admin reads everything but has no browser write path; service role capabilities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `storage.test.ts`         |    12 | Proof upload only into one's own winner folder and only while `awaiting_proof`; other users/anon cannot upload or read; admin can read; no user update/delete; charity media public read, admin-only write; bucket-scoped policies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `scores-function.test.ts` |    28 | **`add_score()`**: creates below the limit; the sixth replaces the oldest **by date, not by entry order**; a back-dated score is rejected with nothing changed; a duplicate date is rejected **before** any eviction; range 1-45 and null handling; per-user isolation; cooperates with the cap trigger; service-role-only execution (anon/authenticated denied, incl. writing another user's scores); edit-in-place and delete-frees-a-slot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 3a. Authentication and authorization tests (Phase 2)

**API — `apps/api/src/auth/*.test.ts`, 58 new tests.** They use **real cryptography**: a freshly generated
ES256 key pair, a real JWKS and properly signed tokens, run through the _production_ `createJwtVerifier`.
Only the source of the public keys differs from production (a local set instead of Supabase's remote one).
Profile storage is an in-memory stand-in; the real `public.profiles` behaviour is covered by the database
tests (including the exact lookup the API performs, as `service_role`).

| Area            | Covered                                                                                                                                                                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unauthenticated | No/malformed `Authorization`; garbage, expired, wrong-issuer, wrong-audience, foreign-signed, tampered-payload, `alg: none` and HS256 algorithm-confusion tokens; oversized token; Supabase anon/service-role keys and anonymous sessions used as bearers — all 401 with generic messages and `WWW-Authenticate` |
| Authenticated   | `GET /api/me` returns the caller's own profile with the role from the database; case-insensitive `Bearer`; a valid account with no profile is 403, never auto-created                                                                                                                                            |
| User isolation  | Each user gets only their own identity; `userId`/`id`/`sub` query strings, JSON bodies and `X-User-Id`/`X-Role` headers cannot redirect or elevate                                                                                                                                                               |
| Unauthorized    | Regular user → 403 on admin routes; admin → 200; **every** forged claim shape (`app_metadata`, `user_metadata`, custom claims) ignored; **role read on every request** (demotion/promotion/deletion take effect with the same valid token)                                                                       |
| Deny by default | **Route enumeration:** every route registered on the admin router is checked for anonymous 401 / user 403 / admin allowed; unknown admin paths and non-GET methods are guarded too; `requireAdmin` alone (misconfigured) denies                                                                                  |
| Fails closed    | Auth unconfigured → 503 everywhere authenticated; unreachable key set → 503; profile lookup failure → generic 500 with no leakage and no access; unrecognised `profiles.role` value → error, not a default                                                                                                       |
| Config          | Supabase URL/key parsing, "set together" rule, production refuses to start without them                                                                                                                                                                                                                          |

**Web — `apps/web/src/**/*.test.ts(x)`, 40 new tests.** The Supabase client is faked at its boundary (no real
project exists) and the API is stubbed at `fetch`; the app's own provider, guards and forms run for real.
Covered: unauthenticated redirects from `/account` and `/admin`; session restoration and the
server-verified identity; a stored session the server rejects is discarded; API down and missing-profile
states; regular users blocked from `/admin` without contacting the admin endpoint; admins shown the admin
area only after the server confirms; server 403/503 overriding the UI's own belief; login (redirect back to
the requested page, generic bad-credentials message, local validation); signup with email confirmation on
and off, and duplicate email; logout; open-redirect protection; the "not configured" notice.

**Verified against the real built API (manual smoke, not automated):** a bad token → 401; an unreachable
Supabase key endpoint or absent configuration → 503 (fails closed); production without Supabase settings
refuses to start; the service-role key never appears in logs.

**What is NOT proven:** no test talks to a real Supabase Auth instance — signup/login/refresh/logout against
the real service, JWKS retrieval from a live project, the project's actual JWT signing scheme, and email
confirmation are unverified until a new Supabase project exists. There is no browser-level end-to-end test.

## 3b. Score engine tests (Phase 3)

Rules under test: PRD §05 (SCR-01…SCR-08) and the owner decision D-061 ("oldest" = earliest date; back-dated
rejected). **Total 199 new tests.**

| Layer    | File                                     | Tests | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | ---------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database | `supabase/tests/scores-function.test.ts` |    28 | The **authoritative** rules, run on real PostgreSQL semantics (see the table in Section 3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Shared   | `packages/shared/src/scores.test.ts`     |    66 | Pure validation: 1 and 45 accepted; 0, 46, negatives, fractions, `NaN`/`Infinity`, strings, booleans, `null` rejected; real calendar dates only (`2026-02-30`, leap years, `1900-02-29`, wrong formats, date-times); bodies must be JSON objects; unknown fields such as `userId` ignored; future dates deliberately **not** rejected (D-027)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| API      | `apps/api/src/scores/routes.test.ts`     |    63 | **Through the real Express app and auth middleware:** unauthenticated/invalid tokens → 401 with storage never reached; unconfigured → 503; **only subscribers write, checked per request** (lapse and re-subscribe mid-test, admin gets no bypass, failed entitlement lookup writes nothing); newest → oldest listing whatever the entry order; **the five-score boundary** (first five kept, sixth replaces the oldest by date and reports which, a long run stays at five, back-dated → 422 unchanged, duplicate at the limit → 409 without evicting, delete frees a slot); one score per date and **edit updates in place** (PUT, cannot change the date, 404 when absent); 18 invalid-body cases → 400 with named fields and storage untouched; malformed JSON; **ownership** (another user's same-date score is a different, missing score → 404; two users hold the same date independently; one user's evictions never touch another's; `userId` in body/query/headers ignored; every storage call carries the verified id); storage failure → generic 500 |
| API      | `apps/api/src/scores/service.test.ts`    |     6 | Subscription checked before every write and on none of the reads; outcome → status mapping                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| API      | `apps/api/src/scores/repository.test.ts` |    36 | What is actually sent to Supabase (table, columns, filters scoped by user **and** date, RPC name and argument names) and how PostgREST errors map (`23505` → duplicate, `GS001` → too old, anything else → failure, never a business outcome); malformed rows and function results rejected; entitlement lookup (only an explicit `true` counts; a failed lookup throws rather than reading as "not subscribed")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**Where the rules live, and what that means.** The replace-oldest rule is implemented **once, in SQL**
(`add_score()`), so it can be atomic. The API tests use an in-memory stand-in that mirrors those rules
so HTTP scenarios read naturally; it is **not** the authority, and the two are kept honest by the database
tests running the same scenarios against PostgreSQL. If the SQL rule changes, `test-support/scores.ts` must be
updated to match.

**API tests are hermetic (D-063).** HTTP is dispatched **in-process** (`light-my-request` through the adapter in
`apps/api/src/test-support/http.ts`); there is no server, port or socket. This replaced supertest after a rare
flake (another local listener occasionally answering a test request) that a loopback-bound server only reduced.
Proof: the whole suite passes under a guard that throws on any TCP `listen`/`connect` in a test worker (with a
negative control confirming the guard works), and **186 consecutive runs produced 0 failures** — 50 of the three
affected files, 80 of the full suite, 40 under CPU saturation (8 concurrent processes), and 16 under saturation
plus the guard. Limitation: the tests no longer exercise real sockets.

**Verified on the hosted Supabase project (2026-09-21).**

- Migration `…110000` applied with `supabase db push`; `supabase migration list` shows all **12 migrations
  identical locally and remotely**.
- **Privileges (hosted catalog):** `add_score()` is executable by `service_role` only (`anon`, `authenticated` and
  `public` are all denied) and is not `SECURITY DEFINER`. The complete set of public functions browser roles can
  execute is exactly the documented allow-list (`current_user_is_active_subscriber`, `draw_is_published`,
  `is_admin`). Through the hosted Data API a visitor and a signed-in user (calling for themselves or for another
  user) are refused with `42501`, as is probing `is_active_subscriber(uuid)`; the service role reaches the function
  (a deliberately invalid score returned the range error `23514` and wrote nothing).
- **End-to-end flow** against the real API and hosted database, with a real hosted session for a user made an
  active subscriber by the dev SQL: **54 of 54 checks passed** — GET; POST; duplicate date → `409` (PostgreSQL
  `23505` reached the API); invalid values and dates → `400` with field errors and nothing stored; back-dated →
  `422` (custom `GS001` reached the API) with nothing changed; the sixth score replaces the earliest date and
  reports it; PUT (`200`, no duplicate, no eviction; `404` when absent); DELETE (`204`, then the next POST
  replaces nothing); non-subscriber and lapsed-subscriber writes → `403` on the very next request while reads keep
  working; unauthenticated → `401`.
- **Concurrency:** parallel POSTs with distinct dates for one user — three rounds of 10 and one burst of 25 —
  gave **zero `500`s**, only `201`/`422` responses, **exactly 5 rows** in the database, and always the five
  newest dates, however the requests interleaved (the `201`/`422` mix differed between rounds).

**Still not proven:**

- **Cross-user isolation with a _subscribed_ second user.** The hosted second account was a non-subscriber, so its
  attempts to edit or delete the first user's score were refused by the subscription check (`403`) and never
  reached the ownership path (`404`). That path is covered by the automated API tests.
- Concurrency across **several users at once**, and load beyond 25 parallel requests.
- Subscriptions created by Stripe (a placeholder plan and subscription were used, as documented) and any browser
  UI — neither exists yet.

**Manual verification checklist (real project, after `supabase db push`):**

1. `supabase migration list` shows all 12 migrations on both sides.
2. Make the test user an active subscriber with the README's dev-only SQL.
3. Signed in, from the browser's network panel or your own client: `POST /api/scores` five times with
   different dates, then a sixth → the response's `replacedPlayedOn` is the earliest date; `GET /api/scores`
   lists five, newest first.
4. A back-dated `POST` → `422 score_too_old`; a repeated date → `409`; a value of 0 or 46 → `400`.
5. `PUT` an existing date → `200` and the list still has five; `DELETE` it → `204`, then the next `POST`
   replaces nothing.
6. As the same user after removing the subscription (undo SQL) → `POST` is `403`, `GET` still works.
7. **Race check:** fire ~10 parallel `POST`s with distinct new dates for one user (for example `xargs -P 10`
   with `curl`, token from an environment variable, never pasted into a shared place) → afterwards the user has
   exactly five scores, every response is `201`/`422`/`409` (no `500`), and the five kept are the newest dates.
8. Sign in as a second user → they see none of the first user's scores and cannot edit or delete them.

## 3c. Charity tests (Phase 4)

Rules under test: PRD §08 (CHR-01…CHR-04, DIR-01…DIR-03), the owner decision D-064 (any percentage from 10% up,
raise **or lower**) and the provisional design D-065. **Total 402 new automated tests** (117 shared + 196 API + 52 web + 37 database), plus the hosted verification below. The owner's CHR-01 decision (D-066: charity at signup, required to subscribe) added 46 of them; see "CHR-01" below.

| Layer    | File                                        | Tests | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------- | ------------------------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database | `supabase/tests/charity.test.ts`            |    37 | On PostgreSQL semantics: the **selection guard** (a listed charity can be chosen; an archived one → `GS002`; a missing one → `23503`; archiving _after_ selection does not block percentage edits or an unchanged re-save; moving to a different archived charity is refused); the **direct browser path** with committed fixtures (a user may select a listed charity and raise **and lower** the percentage 25% → 10% → 100% → 10%, cannot select an archived charity, go below 10% or above 100%, or change another user's row); the **directory search** (word-prefix `river:*`, stemming, AND of words, archived never returned, mid-word no match, stop-word-only query harmless); exact tag containment; spotlight = featured and listed; upcoming events soonest first and hidden when the charity is archived |
| Database | `supabase/tests/schema.test.ts` (updated)   |    25 | The `SECURITY DEFINER` allow-list now includes `enforce_selectable_charity` (pinned `search_path`, not executable by browser roles)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Shared   | `packages/shared/src/charities.test.ts`     |   117 | Pure validation: list query (search length, tag shape, `featured` only `true`, `limit` 1–50, `offset` 0–10000, repeated parameters rejected); slug and UUID shape; `percentToBps` by **string arithmetic** ("12.5" → 1250, three decimals/negatives/exponents rejected); `checkCharityPercentage` (9.99% below, exactly 10% ok, 100% ok, above 100% and above a configured cap rejected, non-integers rejected); the update body (charity and/or percentage, at least one, unknown fields such as `userId` ignored); the donation request contract                                                                                                                                                                                                                                                                     |
| API      | `apps/api/src/charities/text.test.ts`       |    17 | Search-text sanitising: only letter/digit runs survive, so **no input can produce tsquery or PostgREST filter syntax** (SQL, `&`, `\|`, `:*`, `name.ilike`, JSON, backslash); bounded words and length; `summarize` boundaries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| API      | `apps/api/src/charities/repository.test.ts` |    50 | What is actually sent to Supabase (**listed only**, upcoming events only, order, `range(offset, offset+limit)` for `hasMore`, tag `contains`, prefix `textSearch` with the `english` config, preference embed, updates carry only the provided columns and are scoped by user id); unsearchable text never reaches the database; malformed rows rejected; `GS002` → unavailable, `23503` → not found, any other error → failure, never a business outcome                                                                                                                                                                                                                                                                                                                                                              |
| API      | `apps/api/src/charities/service.test.ts`    |    53 | Percentage rules incl. D-064 (accept 1000…10000, **lower to 10%**, reject 0/999/10001/fractions, honour a configured cap); charity must exist (404) and not be archived (422) **before** anything is written, and a rejected half blocks the other half of the same request; the archive race mapped from the DB guard; no subscription needed; own profile only; per-currency contribution totals (integer sums, safe-integer guard)                                                                                                                                                                                                                                                                                                                                                                                  |
| API      | `apps/api/src/charities/routes.test.ts`     |    76 | **Through the real Express app and auth middleware:** the directory, profile and spotlight are public and never expose archived charities however they are asked for; search/filter/paging; 11 invalid-query cases → 400 with the database untouched; malformed slugs → 404 without a database call; no write methods exist on the directory; `/api/me/charity` and `/api/me/contributions` → 401 without/with a forged token; **isolation** (a `userId` in body or query is ignored, an admin token has no power over another user); 422 codes; 503 when unconfigured; a database failure → a generic 500 that leaks nothing                                                                                                                                                                                          |
| Web      | `apps/web/src/charities.test.tsx`           |    52 | Directory (list, search, tag, featured, empty and error states, Next/Previous), profile (description, images with alt text, upcoming events, not-found), homepage spotlight (featured only; renders nothing and no error when empty or failing), protected "my charity" page (stored values, save, only changed fields sent, **lowering**, local rejection of 8 bad values with **no API call**, a configured cap, the server's own explanation, an archived current charity, `?charity=` preselection, and the **chosen charity surviving sign-in** — a signed-out visitor who clicks "Choose this charity" keeps the choice through login)                                                                                                                                                                           |

**Where the rules live, and what that means.** The percentage rule exists once in `packages/shared` and is
enforced again by the database constraint; the archived-charity rule is enforced by the API **and** a trigger (users
can write `selected_charity_id` directly through the Phase 1 column grant). The API tests use an in-memory
repository (`test-support/charities.ts`) that mirrors these rules and reuses the production DTO mapping; it is
**not** the authority for search semantics — `charity.test.ts` proves those on PostgreSQL. `test-support/queryStub.ts`
records the exact PostgREST calls the real repository makes.

**Verified on the hosted Supabase project (2026-09-21).** Migration `…120000` was applied with `supabase db push`
(`supabase migration list`: **all 13 migrations identical locally and remotely**). The documented sample data
(README) was loaded, then checked through the real API running against the hosted database, the hosted Data API
and a real browser. Throwaway users and dev-only payment/contribution rows were removed afterwards.

- **Hosted API + Data API: 92 of 92 checks passed** (real password sign-ins; no mocks).
  - _Public directory:_ listed charities only; **archived charities are invisible everywhere** (list, search, tag,
    featured, profile → `404`, spotlight; and for the anonymous Data API the archived charity's events and images too).
    Search: word prefix, case-insensitive, English stemming (`coaching`/`coach`), description words, AND of words,
    unsearchable text → none, hostile text → `200`, never a `5xx`. Filters: tag, featured, combined. Paging:
    `hasMore`, ordered by name, an offset past the end → `200` with an empty page (no `416`). Profiles: description,
    images in `sort_order`, **only upcoming events, soonest first** (the past event is hidden), empty arrays when there
    are none. A charity **without** upcoming events is still listed (the embedded filter is not an inner join).
  - _Images:_ both public `charity-media` URLs load anonymously as `image/png` (real PNG bytes).
  - _Signed in:_ select a charity; raise, **lower to exactly 10%**, 100%; `999` → `422 percentage_below_minimum`;
    `10001` → `422 percentage_above_maximum`; fractional → `400`; missing charity → `404`; archived → `422 charity_unavailable`; an archived charity plus a valid percentage in one request stores **nothing**; a `userId` in
    the body is ignored; no subscription needed.
  - _Migration 13 on the hosted trigger:_ archived charity → SQLSTATE **`GS002`**, missing charity → **`23503`**,
    failed writes leave the choice untouched. The **direct browser path** (a user's own JWT against `/rest/v1/profiles`)
    is refused for an archived charity (`GS002`), a missing one (`23503`), `999` and `10001` bps (`23514`); a user can
    select a listed charity, raise and lower their percentage, and **cannot change or even read another user's
    profile**.
  - _Chosen-then-archived:_ `GET /api/me/charity` reports `isArchived: true`; percentage edits still work;
    explicitly re-selecting it is `422`.
  - _Contribution history:_ a user sees only their own rows (API and Data API RLS), with per-currency totals and the
    charity name via the embed; the browser cannot write contributions.
- **The exact PostgREST requests the real repository sends were captured** (13 calls; only method and path/query were
  logged) and all returned the expected data. The forms PostgREST accepted:
  `search=fts(english).river:* & you:*` (with `tags=cs.{youth}`, `is_featured=eq.true`,
  `archived_at=is.null`), embedded `charity_events.starts_at=gte.<now>`, `charity_events.order=starts_at.asc`,
  `charity_events.limit=20`, `charity_images.order=sort_order.asc`, `offset=…&limit=<n+1>`, and the
  `charities!selected_charity_id(id,slug,name,archived_at)` embed. Through the real repository the hosted database's
  `GS002` and `23503` map to `charity_unavailable` and `charity_not_found`.
- **Real browser (Chrome, headless, against the dev stack and the hosted database): 43 of 43 checks passed.** Homepage
  spotlight (image decoded); directory search/tag/featured/no-match; profile with two decoded images, alt text and
  only upcoming events; the archived profile shows "Charity not found"; a signed-out visitor is sent to login and back;
  `/account/charity` loads only listed charities, saves a charity and 15%, **the values survive a reload**, lowering to
  10%, 12.5% → 1250 bps, 100%; `5`, `9.99`, `0`, `abc`, `-10`, `12.345`, empty and `101` are rejected **in the page
  with no API request sent**; a charity archived after the page loaded is refused by the server and **the server's own
  message is shown** with the stored choice unchanged; a chosen-then-archived charity is flagged; `?charity=`
  preselects; network failures on load and on save show clear errors; signed out → redirected to login; no
  unexpected console errors.

**Defects found by the hosted run, and fixed:**

1. **A signed-out visitor's choice was lost at login.** `RequireAuth` remembered only the path, so "Choose this
   charity" (`/account/charity?charity=<id>`) came back as `/account/charity`. It now keeps the query string
   (`apps/web/src/auth/guards.tsx`; `safeRedirect` still rejects absolute and protocol-relative targets). Regression
   test added and mutation-checked (fails without the fix); re-verified in the real browser.
2. **The README's sample SQL was not re-runnable** (the image insert violated the unique
   `(charity_id, storage_path)` on a second run). It now uses `on conflict do nothing`; run twice against the hosted
   project without error.

No defect was found in the repository, service, routes or migration.

**Still not proven:**

- Only Chrome (headless, desktop width) was used; no other browser or mobile viewport.
- The test users were created with the admin API (email pre-confirmed), so the signup form was not run then; at that
  time the form had no charity field. CHR-01 was resolved afterwards (D-066): see "CHR-01" below.
- Load, and several users saving at the same moment, were not exercised (not a concurrency-sensitive feature: each
  user writes their own row).
- Payments do not exist yet, so contribution history was checked with dev-only rows, not real ones.

**Manual verification checklist (real project) — all steps below were run on 2026-09-21 as described above:**

1. `supabase migration list` shows all 13 migrations on both sides.
2. Add fictional sample charities with the README SQL (one featured, one with images and future events). Then
   `GET /api/charities`, `?q=river`, `?tag=…`, `?featured=true`, `/api/charities/<slug>` and `/api/charity-spotlight`
   with no token → listed charities only, an image URL that loads, only future events.
3. Archive one charity (`update public.charities set archived_at = now() …`) → it disappears from all of those.
4. Signed in: `GET /api/me/charity`; `PATCH {"percentageBps": 1500}` → `200`; `PATCH {"percentageBps": 1000}`
   (lowering) → `200`; `{"percentageBps": 999}` → `422 percentage_below_minimum`; `{"percentageBps": 10001}` →
   `422 percentage_above_maximum`.
5. `PATCH {"charityId": "<archived id>"}` → `422 charity_unavailable`; an id that does not exist → `404`. (The
   `GS002` / `23503` database codes are checked separately against the service-role client and the repository.)
6. With the user's own token straight against the Data API, `PATCH /rest/v1/profiles?id=eq.<own id>` with an
   archived `selected_charity_id` → refused (`GS002`); the same against another user's id → no rows changed.
7. Sign in as a second user → `GET /api/me/contributions` shows none of the first user's history.
8. In a browser: `/charities`, a profile, the homepage spotlight, then `/account/charity` — choose, save, reload.

### CHR-01 — charity at signup, required to subscribe (D-066)

| Layer    | File                                     | New tests | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | ---------------------------------------- | --------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Database | `supabase/tests/charity.test.ts`         |        18 | The `handle_new_user()` trigger on PostgreSQL: a listed charity in the signup data is recorded (also in upper case); no/`null` data → unselected; an **archived**, **non-existent** or **malformed** value (`not-a-uuid`, empty, SQL text, one character short/long, no dashes, number, boolean, object, array) is ignored and **the signup still succeeds**; nothing else is read (`role: admin`, `charity_bps: 9999` ignored); privileges unchanged after the redefinition                                                                                                                                                                                             |
| Shared   | `packages/shared/src/charities.test.ts`  |         2 | The signup-data key (pinned to what the trigger reads) and the two new, distinct error codes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| API      | `apps/api/src/charities/service.test.ts` |         9 | `requireSubscribableCharity`: passes with a listed charity and returns its id and percentage; **no charity → `422 charity_required`**; **archived → `422 selected_charity_unavailable`** and no other charity is substituted; passes again once replaced; independent of the percentage (10% is fine); own profile only; `403 profile_missing`; a storage failure is not read as "no charity"                                                                                                                                                                                                                                                                            |
| Web      | `apps/web/src/charities.test.tsx`        |        17 | The signup form offers only listed charities; it requires one (Supabase is never called without it; credentials are checked first); the choice is sent in the signup data; a `?charity=` from a profile page is pre-selected and can be changed, and an archived/unknown/hostile value is ignored; "Log in" keeps the choice **even when clicked before the charity list has loaded**; signup is blocked with an explanation when no charity can be offered; "Log in" from signup keeps the choice; the profile page sends visitors to signup and signed-in users to `/account/charity`; the account page tells a user with no charity that one is required to subscribe |
| Web      | `apps/web/src/routes.test.tsx` (updated) |         0 | The three existing signup tests now choose a charity and assert the signup data (the confirmation-email flow keeps the choice)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**Mutation-checked:** without the migration, 3 database tests fail (recorded charity, upper case, nothing-else-read);
with the provider no longer sending the charity, 4 web tests fail; with the login link no longer carrying an unvalidated `?charity=`, the race test fails. All were restored and verified identical.

**Where the requirement is enforced.** The signup form is UX (a client can call Supabase Auth directly, and admin-created
users have no charity). The requirement is enforced where money starts: `requireSubscribableCharity` — proven at the
service. **No checkout route existed when this was written**; Phase 5 added it and proves the precondition over HTTP (§3d).

**Verified on the hosted Supabase project (2026-09-21) — migration 14 and CHR-01.**

- **Migration applied:** `supabase db push` applied `20260921130000_signup_charity_selection.sql`;
  `supabase migration list` shows **all 14 migrations identical locally and remotely**. Hosted catalog: `handle_new_user`
  is `SECURITY DEFINER` with `search_path=""`, reads the charity key and not `role`, and is **not executable** by `anon`,
  `authenticated` or `public`; the `on_auth_user_created` and `profiles_enforce_selectable_charity` triggers are enabled.
- **Real signups in Chrome against hosted Auth and the hosted database — 37 of 37 checks.** This project does **not**
  require email confirmation, so signup returns a session and the user lands on the account page.
  - _Charity on the form:_ only listed charities are offered; submitting without one is refused in the page and creates
    **no account**; with a charity selected the signup succeeds and **the new profile in the hosted database has the
    selected charity**, role `user`, 10%. The signup data holds only `selected_charity_id` (no role or percentage).
    `/account/charity` shows it, and it persists across a reload.
  - _Pre-signup "Choose this charity":_ a signed-out visitor on a profile is taken to `/signup?charity=<id>`; the charity
    is **pre-selected**, and signing up without touching the field stores **that** charity in the hosted profile. A visitor
    who already has an account uses "Log in" on the signup page and lands on `/account/charity?charity=<id>` with it
    pre-selected — **not saved silently** (the stored charity is unchanged until Save), and Save then changes it.
  - _Invalid or archived charities cannot become the selected charity:_ `?charity=` with an archived id, an unknown id
    or hostile text pre-selects nothing. A charity archived **after the form loaded and before it was submitted**: the
    signup still succeeds and the hosted profile has **no** charity (the account page then says one is required to
    subscribe). Signup data sent around the form through real Auth (archived, unknown uuid, not-a-uuid, number, object,
    null — each with `role: admin` and `charity_bps: 9999` alongside) creates the account with **no charity, role
    `user`, 10%**; so does the public signup endpoint with an archived charity. Afterwards the user still cannot select
    one: the API answers `422 charity_unavailable` (archived) and `404 charity_not_found` (missing), and the Data API,
    with the user's own JWT, `GS002` and `23503`.
  - _Hostile text on the trigger itself:_ Cloudflare in front of Supabase answers `403` with an HTML page to a signup
    whose data is `'; drop table public.charities; --` (no user is created), so that value cannot be sent through Auth
    at all. It was run **directly on the hosted trigger** in a transaction that always rolls back (also `not-a-uuid`,
    empty, a number, an object, a UUID one character short, `{}`, each with `role: admin`): every one produced a
    profile with role `user`, 10%, no charity; an upper-case listed id was accepted; the `charities` table was
    untouched; nothing was committed.
- **The subscription precondition against the hosted database — 7 of 7** (the real repository and PostgREST embed,
  called through the service; **there is no route for it until Phase 5**): a listed charity → allowed, returning its id
  and percentage; none → `422 charity_required`; a percentage of exactly 10% → allowed; the selected charity
  **archived** → `422 selected_charity_unavailable` with no other charity substituted; replaced by a listed one →
  allowed again; an id with no profile → `403`.
- **Existing behaviour still passes on the hosted project:** the earlier API + Data API suite (**92 of 92**); the earlier
  real-browser suite (**43 of 43** — its "signed out → Choose this charity" step now leads to signup, then "Log in", per
  D-066; it also now checks Log out); and the auth basics (**9 of 9**: valid and wrong passwords, `/api/me` with the
  database role, a missing or tampered token → `401`, a regular user on an admin route → `403`, own scores → `200`,
  sign-out).
- **Cleanup:** every throwaway user created in this run, the credentials file and the scratch dependencies were
  removed; no payments or contributions exist; the three `sample-` charities are in their
  documented state. The two remaining accounts are the owner's.

**Defect found by the hosted run, and fixed:** "Log in" on the signup page carried the pre-signup choice only **after**
the charity list had loaded and the choice had been validated, so a visitor who clicked straight away landed on
`/account` and lost it. The link now carries a UUID-shaped `?charity=` immediately (`/account/charity` validates it
against the listed charities itself). Regression test added and mutation-checked (fails without the fix); re-verified
in the browser.

**Two script mistakes, not product defects** (noted so the results can be trusted): a Playwright name match is a
case-insensitive substring, so `list "Charities"` also matched "Featured charities" and `has-text("Your account")`
matched "Create your account" — both fixed with exact matching and the runs repeated.

**Still not proven:**

- **Email confirmation required.** This project does not require it, so that path was not run in a real browser. It is
  covered by the automated tests (the confirmation notice, the signup data carrying the choice) and by the trigger
  running on the same `auth.users` insert either way.
- **Only Chrome (headless, desktop width).**
- `requireSubscribableCharity` had no route at that time; Checkout (Phase 5) now calls it, proven over HTTP in §3d.

## 3d. Subscription and payment tests (Phase 5)

Rules under test: PRD §04 (SUB-01…SUB-05), §08 (CHR-02…04 as money) and the provisional decisions D-067 (plans,
Checkout, eligibility), D-068 (webhooks, lifecycle) and D-069 (contribution amount and attribution, yearly plans).
**Total 584 new tests** (67 shared + 426 API + 28 web + 63 database).

| Layer    | File                                         | Tests | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------- | -------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database | `supabase/tests/billing.test.ts`             |    63 | On PostgreSQL: `apply_provider_subscription` (out-of-order events ignored, replays harmless, **a second live subscription refused**, another user\u2019s subscription refused); `record_subscription_payment` (**payment and contribution atomically**, **idempotent**, never downgraded, a succeeded payment without its contribution refused, constraint violations leave **no payment behind**); **ACCESS `is_active_subscriber` with NO tolerance** (a period that ended a second ago has no access; no grace of hours or days; the period end is exclusive; cancel-at-period-end keeps access exactly until the period ends); **ACCESS vs ELIGIBILITY matrix** — 13 status combinations answering both questions side by side (a `past_due` subscription: no access, yet a new checkout is blocked; a status Stripe adds later fails safe); **`charity_contributions` is APPEND-ONLY** (update and delete refused; archiving the charity, or the user changing charity/percentage, leaves the snapshot untouched; a replay never rewrites it); **`payments` are frozen once succeeded** (amount, date, intent, period, payer, kind, subscription, currency, invoice can never change; never deleted; only `succeeded → refunded`, state only, and a refund leaves the contribution untouched; a failed attempt may still become the success); service-role-only privileges for all three functions |
| Shared   | `packages/shared/src/billing.test.ts`        |    67 | **OWNER D-070 — the charity share of an invoice** (`computeInvoiceContribution`): the amount collected, **before tax**, after coupons, gross of Stripe fees, **rounded up**; a fully paid taxed invoice’s basis is exactly its pre-tax total; a **partly paid taxed invoice** has the tax taken out in proportion; a **single rounding** (rounding the basis first would overshoot); never below the chosen percentage, never above the basis; exact at `MAX_SAFE_INTEGER`; refuses nothing-collected, nothing-before-tax and out-of-range percentages. Also `computeCharityContribution`, `isYearlyDiscounted`, `formatMinorUnits` (no float division), the checkout request, error codes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| API      | `apps/api/src/billing/stripe-events.test.ts` |    71 | The trust boundary: every Stripe payload read from `unknown`, **current and older API shapes** (period on the item vs the subscription; subscription under `parent.subscription_details` vs on the invoice), expanded objects, our metadata read defensively, **money accepted only as integer minor units** (fractions, negatives, strings, unsafe integers refused), one-item subscriptions, periods across lines                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| API      | `apps/api/src/billing/status.test.ts`        |    12 | Stripe status → local state; an unknown status is refused, not guessed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| API      | `apps/api/src/billing/service.test.ts`       |    46 | Plans (a yearly plan that is not a discount, in another currency, or without a Stripe price is **not sold**); **the charity precondition runs before anything is created at Stripe** (no charity → `charity_required`, archived → `selected_charity_unavailable`, Stripe never called; call order asserted); one open subscription only — including a **lapsed one Stripe still holds as overdue** (no double charge); idempotency keys; customer created once even under concurrency; provider failures are a generic 502; portal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| API      | `apps/api/src/billing/webhooks.test.ts`      |    80 | **The lifecycle**: subscribe, renew, plan switch, cancel at period end, immediate cancel, lapse and recovery, re-subscribe; **money** (rounded up, tax excluded, coupon, yearly in full, integers); **attribution** (first payment uses the Checkout snapshot, renewals the current choice, **charity archived between checkout and payment**, no charity → nothing recorded); **idempotency** (duplicate event id, two events for one invoice, three simultaneous deliveries, retry after a transient failure); **ordering** (older event ignored, invoice before subscription); **invalid events** (unreadable, live-mode, unknown type/price/customer/status, a second live subscription, mismatched customer, fractional money); the ledger keeps no customer data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| API      | `apps/api/src/billing/gateway.test.ts`       |    30 | What is sent to Stripe (subscription-mode session, one price, charity snapshot on session **and** subscription, idempotency keys, **no card fields**); provider errors wrapped with the cause kept for logs only; **real webhook signature verification** with the official SDK (valid; body altered by one byte; re-serialised; wrong secret; missing/garbage header; old timestamp; another payload’s signature; the error names no check)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| API      | `apps/api/src/billing/repository.test.ts`    |    61 | What is sent to Supabase (tables, filters, RPC argument names, ISO dates, integers) and how database error codes map — `GS003`/`GS004`/`23514`/`23503`/`23505` are **unprocessable**, anything else **transient**; the ledger claim (new / duplicate / retry); malformed rows rejected; the **eligibility call** (`has_open_subscription` — the rule lives in SQL, not in a client-side filter; a failed or non-boolean answer is an error, never "nothing open")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| API      | `apps/api/src/billing/routes.test.ts`        |    59 | Through the real Express app: plans public; user endpoints 401 (none / forged), 503 when unwired; checkout ignores a body `userId`/price/amount/charity; the charity preconditions over HTTP; **the webhook with real signatures over the raw body** — valid, duplicate, no session needed and a bearer token never substitutes for a signature, wrong secret, altered body, **re-serialised body**, garbage/old header, empty body, non-JSON, live-mode, unknown type, never-applicable (200), transient failure (generic 500 then a successful redelivery), any Content-Type, POST-only, 503 unconfigured, over-large body                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| API      | `apps/api/src/billing/lifecycle.test.ts`     |    15 | **Stripe status → local status → access → may the user start another checkout?**, through the real webhook processor and billing service, for every Stripe status; **an actively retrying (`past_due`) subscription cannot be double-charged** (access stops at once, a second checkout is refused with nothing created at Stripe, recovery restores access on the same subscription, and only a really-ended one allows a new checkout); **access is the recorded paid period with no tolerance** (a late renewal webhook grants nothing; access resumes when the renewal is recorded)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| API      | `apps/api/src/billing/preflight.test.ts`     |    25 | The **read-only readiness check** for the hosted run: it compares the `plans` rows with the Stripe prices they name — amount, currency (case-insensitively), interval and count, recurring, active, **test mode**, that the yearly plan is a real discount — flags a missing plan, a missing price id, a price Stripe cannot find, and a missing migration; **changes nothing** (only `retrievePrice` is called; nothing is written to Stripe or the database); assumes no price or currency; prints no secret                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| API      | `apps/api/src/billing/boundaries.test.ts`    |     9 | **Architecture guards that read the source:** only `billing/gateway.ts` imports the Stripe SDK; the web app and shared package never touch Stripe or its secrets; **nothing that decides access (`auth/`, `scores/`, `charities/`) imports billing or Stripe — access never falls back to Stripe (OWNER D-070)**; the entitlement lookup is the single SQL function; **no currency code or Stripe price id is hard-coded** in any production source, and no migration or seed creates a plan (prices are configuration, OWNER D-070)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| API      | `apps/api/src/billing/selection.test.ts`     |     3 | The renewal reader returns the selected charity **even if archived** (D-043/D-069)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| API      | `apps/api/src/config.test.ts` (updated)      |    15 | Stripe configuration: both secrets or neither; **only test-mode keys**; `whsec_` shape; **a secret is never echoed in an error**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Web      | `apps/web/src/subscription.test.tsx`         |    28 | Plans with integer-minor-unit prices and the yearly saving; checkout sends only the interval and leaves for Stripe’s page; **each server refusal is explained and never sends the user to Stripe** (charity required/archived with a link to fix it, already subscribed, plan unavailable, 503, 502); a double click starts one checkout; every subscription state (active with renewal date, cancelling, pending, lapsed, cancelled); the portal; returning from Checkout; **no card fields exist on the page**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**Mutation-checked** (each defect introduced, the suite re-run, the file restored and verified identical): the SQL —
out-of-order guard removed (1 failing), contribution replay overwrites (2), a succeeded payment downgraded (1), a grace added back to access (5), eligibility ignoring overdue subscriptions (6), eligibility as an allow-list (1), access loosened to lapsed (5), the append-only trigger removed (2) or blocking only deletes (1); the payments guard removed (5), letting a succeeded amount change (2), a succeeded payment be downgraded (1), payments be deleted (1) or an invoice id change (1); the boundary guards — a planted Stripe import (2), an access module importing billing (1), a hard-coded currency (1), a hard-coded price id (1), a migration inserting a plan (1); the webhook processor — duplicates not skipped (2), first payment ignores the Checkout snapshot (2),
live events applied (1), permanent errors retried (16), tax ignored in the basis (1), a second live subscription accepted (1),
an early invoice dropped (3), renewals ignoring the current choice (4); the wiring — JSON parser before the raw webhook (17),
signature errors not translated (9), checkout skipping the charity precondition (15), trusting a body `userId` (1), the
precondition after Stripe (7), the discount rule removed (4); the page — buttons not disabled while busy (1), redirecting
after an error (7), no charity link (2).

**What the tests use instead of Stripe.** The Stripe SDK’s own `generateTestHeaderString` signs webhook bodies and the
production `constructEvent` verifies them, so signature handling is proven with real HMACs. Everything that would call the
Stripe API goes through the `PaymentGateway` interface and is asserted against a fake. `InMemoryBilling` applies the same
rules as the SQL functions but is not their authority — the database tests are.

**Not proven — no request has ever been made to Stripe.** No Stripe credentials exist in this environment, so everything that
needs Stripe is still unverified: the real payload shapes of API version `2026-08-26.dahlia` beyond what the SDK\u2019s types
describe; Checkout, the Billing Portal and the browser flow through Stripe\u2019s hosted pages; the `stripe listen` / dashboard
webhook path with real signatures; and a real renewal (test clock), failed payment and cancellation. The **database side** of
Phase 5 has been verified on the hosted project — see the run below.

**Prepared for the hosted run — nothing here has been run against the hosted project or Stripe.**

- **Readiness check (read-only):** after the setup below, `npm run preflight:stripe -w @gather/api` reads `apps/api/.env`,
  confirms the billing SQL (migration `…140000`) is present, and compares each active `plans` row with the Stripe price it
  names (amount, currency, monthly/yearly interval, recurring, active, **test mode**) and that the yearly plan is a real
  discount. It writes nothing and prints no key. Exit `0` = ready, `1` = fix what it lists, `2` = the environment is not set up.
- **Webhook events to enable** (on the endpoint, or `stripe listen --events`): `checkout.session.completed`,
  `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
  `invoice.payment_succeeded`, `invoice.payment_failed`. Anything else is acknowledged and ignored.
- **Read-only inspection queries** (SQL editor; replace the email). They show the state after each scenario, including both
  questions — access and "would a new checkout be blocked" — and recompute each contribution from its own basis:

  ```sql
  with u as (select id from auth.users where email = 'YOUR-TEST-USER@example.com')
  select s.status, s.provider_status, s.cancel_at_period_end, s.current_period_end,
         public.is_active_subscriber(s.user_id) as has_access,
         public.has_open_subscription(s.user_id) as blocks_new_checkout
  from public.subscriptions s join u on u.id = s.user_id order by s.created_at;

  select p.state, p.amount_minor, p.currency, p.period_start, p.period_end, p.stripe_invoice_id,
         c.charity_id, c.percentage_bps, c.basis_minor, c.amount_minor as contribution_minor,
         ceil(c.basis_minor * c.percentage_bps / 10000.0) as expected_from_basis
  from public.payments p left join public.charity_contributions c on c.payment_id = p.id
  where p.user_id = (select id from auth.users where email = 'YOUR-TEST-USER@example.com')
  order by p.created_at;

  select id, type, status, error, received_at from public.stripe_events order by received_at desc limit 20;
  ```

**Hosted verification run — 2026-09-21. Result: the database half is verified; the Stripe half is BLOCKED on missing credentials.**

- **Step 1 — `npm run preflight:stripe -w @gather/api`: exit `2`, "Not ready".** It refused before making any request because
  `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are not set (checked by name only — `apps/api/.env` holds just `NODE_ENV`,
  `PORT`, `WEB_ORIGIN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; nothing Stripe-related is in the process environment). The Stripe
  CLI is not installed either. Checklist step 2 ("if preflight is clean…") therefore did not start.
- **Step 3 — migration `…140000` applied** with `supabase db push`; `supabase migration list` shows **all 15 migrations
  identical locally and remotely**. Hosted catalog: `is_active_subscriber` is strict (`current_period_end > now()`, no interval
  in its definition); `has_open_subscription`, `apply_provider_subscription` and `record_subscription_payment` exist and are
  executable by `service_role` only (not `anon`, `authenticated` or `public`); `payments_history_guard` and
  `charity_contributions_append_only` are enabled; `payments.period_start/period_end` and `subscriptions.provider_event_at` exist.
- **Database behaviour on the hosted project** (one transaction that always rolls back; afterwards the hosted rows were identical to
  before — checked): an older subscription event is `stale`, a replay is harmless, a **second live subscription is `conflict`**;
  **access versus eligibility** — active with a current period: access yes / blocks a new checkout yes; active whose period ended a
  minute or two days ago: **no access**, still blocks; `past_due` and `unpaid`: **no access, blocks**; `incomplete_expired` and
  `canceled`: no access, **does not block**; a payment and its contribution are written **atomically and idempotently** (a replay
  with a different percentage changes nothing), the snapshot is `1500 | 1000 | 150`, a succeeded payment without a contribution is
  refused (`GS004`) and one below 10% is refused (`23514`) leaving no payment behind; **append-only** — update and delete of a
  contribution, of a succeeded payment\u2019s amount or currency, delete of a payment, and `succeeded → failed` are all refused
  (`23000`); archiving the charity and changing the user\u2019s choice leave the snapshot unchanged; `succeeded → refunded` is allowed
  and leaves the contribution unchanged, and `refunded → succeeded` is refused.
- **RPC surface through the real Data API (checklist step 14): 16 of 16.** `anon` and a signed-in user are refused on all four
  functions; the RLS helper `current_user_is_active_subscriber()` still answers a user about themselves; with the service role
  PostgREST parsed all 14 and 11 arguments (uuid, bigint, timestamptz, enums) and the errors surfaced as `GS003` / `23503` with
  **nothing written**.
- **The running API against the hosted database with Stripe unconfigured: 10 of 10.** `GET /api/plans` → `200` with no plans (the
  only plan row has no Stripe price, so nothing is sold); `GET /api/me/subscription` → `200` empty; checkout and portal → `503`;
  the webhook → `503` and never reaches the database; `401` without a token; the ledger stayed empty.
- **Checklist steps 1, 3 (partly), 14 and 15 are done** — step 15 (append-only) was exercised as a rolled-back transaction rather
  than as committed data, so no test rows exist that would need the owner to disable a trigger.
- **BLOCKED — nothing below was attempted, and nothing was invented:** steps 2 and 4 to 13 and 16 (Stripe configuration, prices and
  plan rows, checkout and the charity precondition **over HTTP against Stripe**, webhook signatures and idempotency with real events,
  payment/contribution snapshots from real invoices, the lifecycle, renewal, failed payment and recovery, cancellation).

**Exactly what is needed to continue** (put credentials only in the local `apps/api/.env`; they are never printed or pasted into chat):

1. `STRIPE_SECRET_KEY` — a **test-mode** key (`sk_test_…`, or a restricted `rk_test_…` that can write Products/Prices, Customers, Checkout
   Sessions and Billing Portal configurations and read Subscriptions/Invoices/Events). Live keys are refused.
2. `STRIPE_WEBHOOK_SECRET` — the `whsec_…` of the webhook endpoint. Locally it comes from `stripe listen`, which needs **the Stripe CLI
   installed and logged in** (`brew install stripe/stripe-cli/stripe`, then `stripe login`); a dashboard endpoint would need a public
   HTTPS URL to the API, which the local dev server does not have.
3. **The price configuration** — a currency, a monthly amount and a yearly amount (the yearly cheaper than 12 × monthly). None is
   configured anywhere and none is a PRD requirement (D-024/D-070). Either give the values, or explicitly approve the README\u2019s
   labelled development placeholders (`USD` 10.00 monthly, 100.00 yearly) for this test-mode run.
4. **Retire the leftover Phase 3 placeholder plan** on the hosted project (`DEV placeholder - not a real price`, monthly, currency
   `XTS`, no Stripe price). The schema allows one active plan per interval, so a real monthly plan cannot be inserted while it is
   active. It is referenced by a leftover dev subscription (which is not mine to remove), so it can only be **deactivated**
   (`update public.plans set is_active = false where name like 'DEV placeholder%'`), not deleted. This needs your go-ahead.
5. **The Billing Portal configuration** in the Stripe test-mode account (cancel at period end, switching between the two prices,
   payment-method update). With a key that may write it, this can be done by API; otherwise it is a dashboard step.

**Hosted Stripe verification still to do (real Supabase project + Stripe test mode):**

1. `supabase db push` (migration `…140000`); `supabase migration list` shows all 15 identical.
2. In the Stripe **test-mode** dashboard: create a product with a **monthly** and a **yearly** recurring price (the yearly
   cheaper than 12 × monthly). Insert the two `plans` rows with the README’s dev-only SQL, each with its `stripe_price_id`.
   Configure the **Billing Portal** (allow cancel at period end, plan switching between the two prices, payment method
   update). Set `STRIPE_SECRET_KEY` (`sk_test_…`) in `apps/api/.env` — never printed or shared. Then run
   `npm run preflight:stripe -w @gather/api`: it must report **Ready** before you go on.
3. Webhooks: run `stripe listen --forward-to localhost:4000/api/webhooks/stripe` and put its `whsec_…` in
   `STRIPE_WEBHOOK_SECRET` (or add a dashboard endpoint for the events listed in D-068). Restart the API.
4. **Public/plans:** `GET /api/plans` lists both plans with no Stripe ids; the yearly plan disappears if its price is made
   equal to 12 × monthly.
5. **Preconditions:** as a user with **no charity** → `POST …/checkout` is `422 charity_required` and **no Checkout session
   or customer appears in the Stripe dashboard**; with an archived selected charity → `422 selected_charity_unavailable`.
6. **Subscribe (monthly)** in the browser with test card `4242 4242 4242 4242`: you land on
   `/account/subscription?checkout=success`; within seconds the page shows **active** with a renewal date. In the
   database: one `subscriptions` row (`provider_status active`, period set, `provider_event_at` set), one `payments` row
   (`succeeded`, integer `amount_minor`, `period_start/end`), one `charity_contributions` row whose `percentage_bps`,
   `basis_minor` and `amount_minor` equal **ceil(percentage × the amount collected before tax)** (`expected_from_basis` in the query above matches `contribution_minor`) and whose charity is the one chosen at checkout.
   `stripe_events` has every event `processed` and **no customer names or emails** in `payload`.
7. **Idempotency:** `stripe events resend <evt_id>` for the invoice event → `200`, `outcome: duplicate`, still exactly one
   payment and one contribution. Send the same event twice in parallel → still one.
8. **Order:** resend an OLDER `customer.subscription.updated` after a newer one → the stored status does not move back.
9. **Yearly:** repeat with the yearly plan (after cancelling the monthly one): the payment’s period spans 12 months and
   the contribution is taken in full.
10. **Renewal / lapse (Stripe test clock):** advance the clock past the period → a second `payments` row and contribution
    (using the user’s **current** charity/percentage — change it first to prove it). Then use the failing test card
    `4000 0000 0000 0341`: the subscription becomes `lapsed` (`provider_status past_due`), a `failed` payment appears,
    **`is_active_subscriber` is false immediately** (no access, no grace), **and `POST …/checkout` is
    `409 already_subscribed` while Stripe still holds it overdue** (`has_open_subscription` true) — nothing new appears in
    the Stripe dashboard. Then pay → `active` again with access restored and still **one** subscription. Finally let
    Stripe cancel it → `has_open_subscription` false and a new checkout is accepted.
    Also check that **access has no tolerance**: set a subscription's recorded `current_period_end` into the past with dev
    SQL (without letting a webhook update it) and `POST /api/scores` is refused (`403 subscription_required`) on the very
    next request — no extra days; restore the period and access returns at once.
11. **Cancellation:** in the Billing Portal cancel at period end → `cancel_at_period_end true`, still active until the
    period ends; advance the clock → `cancelled` with `ended_at`; the user can subscribe again.
12. **Archived between checkout and payment:** start Checkout, archive the chosen charity (dev SQL) **before paying**, then
    pay → the first contribution is attributed to the archived charity; the account page then asks for another charity and
    a new checkout is refused until one is chosen.
13. **Security:** `POST /api/webhooks/stripe` with no signature, a wrong signature and an edited body → `400` and nothing
    changes; with a valid signature but **no bearer token** → `200`. A live-mode key in `.env` stops the API starting.
14. **PostgREST:** confirm the three service-role RPCs (`apply_provider_subscription`, `record_subscription_payment`,
    `has_open_subscription`) accept the argument types the repository sends (`bigint` amounts, `timestamptz` strings, the
    `payment_state` enum as text, a `uuid`), and that a browser session calling any of them is refused (`42501`).
15. **History is append-only:** in the SQL editor `update public.charity_contributions set percentage_bps = 4000`,
    `delete from public.charity_contributions`, `update public.payments set amount_minor = 1 where state = 'succeeded'` and
    `delete from public.payments` are all refused (`append-only` / "never change"), whatever the role; archiving the
    contribution's charity and changing the user's charity/percentage leaves the recorded rows unchanged. (Removing test
    rows later needs the owner to disable `charity_contributions_append_only` / `payments_history_guard`.)
16. **Nothing is hard-coded:** change the monthly Stripe price (a new price, and update the `plans` row) and confirm the
    page shows and Checkout charges the new amount with no code change; `npm run preflight:stripe` reports a mismatch if you
    change only one side.

## 3e. Draw engine tests (Phase 6)

Rules under test: PRD §06/§07 (DRW-01…09) and the owner decision **D-071** (matching, number range, weighting,
prize pool, tier allocation, rollover, remainder, lifecycle) — see `docs/DECISIONS.md`. No dashboard or
scheduling UI exists yet (D-017 is still open), so these tests cover only what an admin can drive directly:
create → simulate → publish. **Total 202 new tests** (26 shared + 159 API + 17 database); no web tests (no UI
was built this phase).

| Layer    | File                                    | Tests | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------- | --------------------------------------- | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared   | `packages/shared/src/draws.test.ts`     |    26 | `parseCreateDrawRequest`: the `YYYY-MM-01` shape (rejects a non-first-of-month date, an invalid calendar date, wrong separators), `mode` restricted to `random`/`algorithmic`, unknown fields ignored, the DTOs and error-code contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| API      | `apps/api/src/draws/domain.test.ts`     |    50 | **Pure, no I/O** — the actual business rules from D-071: `drawRandomNumbers` (exactly five distinct numbers in the configured 1–45 range, deterministic with a seeded/scripted random source, boundary numbers reachable, 500-seed fuzz for distinctness); `drawAlgorithmicNumbers` (a heavily weighted number is picked far more often, zero-weight numbers fill in uniformly once positive weights run out, weights outside the range are ignored); `ticketOf` (deduplicates a user's scores; a shorter ticket simply caps the reachable tier, D-016); `computeMatchCount` (exact 5/4/3, order-independent set matching, a duplicate ticket value counts once, always a single tier — never two at once); `monthlyPoolShare`/`poolFundingBasisForMonth` (a monthly payment funds only its own month in full; a yearly payment splits into twelve EQUAL shares with the floor-division remainder in the first covered month, D-070's rule made computable; a currency mismatch throws `MixedCurrencyPoolError` rather than summing); `poolFromBps`/`poolFromFixedPerSubscriber` (exact `BigInt` arithmetic, no float drift, at `MAX_SAFE_INTEGER`-scale amounts); `splitPoolAcrossTiers` (40/35/25, each floored, at most a couple of minor units ever unallocated); `allocateTier` (equal split with the floor-rounded remainder recorded and paid to no one, a ROLLING tier with zero winners rolls the WHOLE pot forward, a NON-rolling tier with zero winners carries nowhere, allocation never exceeds the pot across a spread of pool sizes and winner counts) |
| API      | `apps/api/src/draws/repository.test.ts` |    37 | What is actually sent to Supabase: `parseDrawRow`/detail parsing reject malformed rows; `getSettings` reads bps **or** fixed pool config (`null`/`null` when unconfigured, never guessed); `listEligibleTickets` reads `active_subscriber_ids()` then each user's newest-five scores (an eligible user with zero scores still gets an entry; no active subscribers skips the scores query entirely); `listPaymentBasesFunding` sends the documented 11-month lookback and throws if a succeeded payment has no charity contribution (should never happen, `GS004`); `getActiveMonthlyPlanCurrency`, `getPriorJackpotRollover`; `simulate`/`publish` send the exact documented RPC argument names and map `GS005`/`GS006` to `DrawStateConflictError`, never a generic failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| API      | `apps/api/src/draws/service.test.ts`    |    31 | Orchestration: one draw per calendar month (409 on a duplicate); **configuration preconditions refuse, never guess** (unconfigured number range, unconfigured pool, bps mode with no funding and no active-plan currency to fall back to, fixed mode with no active monthly plan, mixed-currency funding — each its own 422); pool computed correctly from bps × the actual month's basis (including a yearly payment's 1/12 share) or from fixed × subscriber count; every active subscriber gets an entry even with zero scores; a short ticket can still win, just never the 5-match tier (D-016); random vs algorithmic mode wired to the right domain function; **snapshot immutability** (re-fetching after a score change still shows the original simulated snapshot; an explicit re-simulate does pick up new scores; a published draw can never be re-simulated); multiple-winner equal split, zero-5-match rollover into the next draw, a zero-winner non-rolling tier, a WON jackpot NOT rolling over; the full DRAFT → SIMULATED → PUBLISHED lifecycle including refusing to skip it, idempotent double-publish and concurrent publish never duplicating winners                                                                                                                                                                                                                                                                                                                                                                                         |
| API      | `apps/api/src/draws/routes.test.ts`     |    41 | **Through the real Express app:** every `/api/admin/draws` endpoint (list, create, get, simulate, publish) requires an admin — 401 with no/forged token, 403 for a signed-in non-admin **with the service never even asked**, 503 when unwired; request validation (`drawMonth`/`mode` shape) rejects before touching the repository, and extra body fields (`createdBy`, `id`, `status`) are ignored; a malformed id (`not-a-uuid`, path traversal, SQL text) is a 404 that never reaches the repository (`isUuid` guard); the full lifecycle over HTTP, publishing before simulating refused, re-simulating a published draw refused, idempotent and concurrent HTTP publish; configuration failures surface as clear 422s, never a raw 500; no `DELETE`/`PUT` route exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Database | `supabase/tests/draws-function.test.ts` |    17 | On PostgreSQL: `active_subscriber_ids()` matches `is_active_subscriber(uuid)` exactly for every candidate, no tolerance; `simulate_draw()` writes numbers/entries/tier-results **atomically** (an error partway through leaves the draw exactly as it was), a re-simulate **replaces** the candidate snapshot entirely (old entries gone, not merged), refuses a published draw (`GS005`); `publish_draw()` refuses straight-from-draft (`GS006`), creates exactly the winners implied by each entry's `match_count` (a 0–2 match never becomes a winner row), and is **idempotent** (a second call reports `already_published` and creates no second winner set); all three functions are **service-role only** (never `anon`, `authenticated`, `public`, and unreachable through the signed-in RPC surface); the existing `remainder_minor`/pot CHECK constraint still holds at the SQL level; a real **two-month rollover chain** — no 5-match winner in month 1 rolls the jackpot into month 2's tier result, proven with the actual functions, not a mock                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**Where the rules live, and what that means.** All matching, weighting, pool and tier maths is **pure TypeScript**
(`apps/api/src/draws/domain.ts`, clock-free — no "now" is needed since every timestamp used is the database's own
`now()` — and random-source-injected, so it is deterministic under test). The two SQL functions
(`simulate_draw()`, `publish_draw()`) never compute anything themselves; they only apply an already-computed
result atomically, exactly like `add_score()`, `apply_provider_subscription()` and `record_subscription_payment()`
before them. The service tests use `InMemoryDraws` (`apps/api/src/test-support/draws.ts`), which mirrors the SQL
functions' atomicity/idempotency contract but is **not** their authority — `draws-function.test.ts` proves those
on real PostgreSQL.

**Mutation-checked** (each defect introduced, the suite re-run, the file restored and verified byte-identical by
`cmp`): in `service.ts` — the `requireAdmin`/admin-router wiring removed (5 routes tests failed); the
published-draw re-simulate guard removed; the config-refusal-before-write ordering removed. In the SQL migration
— the `GS005` (re-simulate a published draw) guard removed; the `GS006` (publish before simulate) guard removed;
the idempotent early-return in `publish_draw()` removed (would create a second winner set); the row lock removed
(would allow a lost update under concurrency, reasoned about the same way as the pre-existing score-cap advisory
lock — see Section 5). Each mutation was caught by at least one existing test before the file was restored.

**Not proven — no hosted run was performed this phase** (unlike Phases 4 and 5, D-071's implementation was not
exercised against the real hosted Supabase project or a real concurrent-connection PostgreSQL — only PGlite,
which is single-connection, so the SQL functions' row-locking is reasoned about, not exercised under a genuine
race, the same limitation already recorded in Section 5 for `add_score()`). No admin UI exists to drive
create/simulate/publish by hand, so no browser/manual verification was possible this phase. The algorithmic
mode's weighting population (this draw's eligible users only, D-013's still-open residual) and any future
scheduling/cutoff (D-017) remain unverified because they are not yet decided.

## 3f. Winner verification and payout tracking tests (Phase 7)

Rules under test: PRD §09 (DRW-10/11/12), §11 (ADM-06) and the implementation decision **D-072** (resubmission,
upload transport, secure proof access, payout ordering, audit). Winner CREATION itself is Phase 6's
`publish_draw()` (D-071) and is only re-affirmed here, not re-implemented. **Total 178 new tests** (44 shared +
102 API + 26 database + 6 web).

| Layer    | File                                        | Tests | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------- | ------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared   | `packages/shared/src/winners.test.ts`       |    44 | `parseRegisterWinnerProofRequest`/`parseReviewWinnerRequest` (shape, length limits, unknown fields ignored), the stable error-code contract, and that the development storage limits (`WINNER_PROOF_MAX_BYTES`/`WINNER_PROOF_ALLOWED_MIME_TYPES`) mirror the migrated bucket configuration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| API      | `apps/api/src/winners/repository.test.ts`   |    23 | What is actually sent to Supabase: owner-scoped `eq(user_id=…)` filters on every `/me` read; `findOwnById`/`findAdminById` issue a FRESH signed URL per proof (bucket, path, 300 s TTL) and degrade to `url: null` rather than failing the whole read if one signing call errors; `register/reopen/review/markPaid` send the exact documented RPC argument names and map `23503`/`GS007`–`GS012` to `WinnerStateError`/"not found", never a generic failure; `insertAuditLog` sends the exact `admin_audit_log` column names (D-052)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| API      | `apps/api/src/winners/service.test.ts`      |    24 | Ownership scoping (`getMine`/`registerProof`/`reopenForResubmission` 404 for a winner owned by someone else — indistinguishable from unknown, never 403); every `WinnerStateError` kind maps to its documented HTTP status/code; `review`/`markPaid` write an `admin_audit_log` entry ONLY on success, never on a rejected/failed attempt; `markPaid` is idempotent and still logs a repeat as a real admin action; unexpected repository failures propagate as plain errors, never silently swallowed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| API      | `apps/api/src/winners/routes.test.ts`       |    55 | **Through the real Express app:** every `/api/me/winners` and `/api/admin/winners` endpoint (401 no/forged token, 403 non-admin **with the repository never even asked**, 503 unwired); a non-winner cannot upload/view/reopen proof that is not theirs (404, no existence leak); a winner uploads already-stored proof and moves to `pending_review`; 409/422 for wrong state, missing storage object; a rejected winner reopens and fully resubmits (a SECOND proof row, back to `pending_review`); an admin reviews (approve/reject, with audit log), and a SECOND review of an already-decided winner is refused (**"approved proof cannot be improperly overwritten"**); payout transitions are gated on `approved` and are idempotent over HTTP; no `DELETE`/`PUT` route exists on either surface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Database | `supabase/tests/winners-function.test.ts`   |    25 | On PostgreSQL: `register_winner_proof()` records metadata and moves to `pending_review`, refuses off-state (`GS007`), a missing storage object (`GS008`), a path outside the winner's own folder even when THAT exact object genuinely exists elsewhere (`GS009` — Alice cannot claim Bob's already-uploaded screenshot as her own proof), is idempotent for an exact repeat, and refuses a winner that belongs to someone else; `reopen_winner_proof()` moves `rejected → awaiting_proof` (clearing `reviewed_at/by/note`, required by the pre-existing `winners_review_timestamp` CHECK), refuses a non-rejected winner (**an approved winner cannot be reopened — proof stays final**); `review_winner()` refuses deciding a winner with nothing submitted, and refuses a SECOND decision on an already-decided winner; `mark_winner_paid()` refuses payout before approval at every prior state, is idempotent (a second admin's call changes nothing — the first admin's `paid_at`/`paid_by` are preserved), and the pre-existing `guard_winner()` trigger still blocks a paid winner reverting even after these new functions run; all four functions are service-role only; winner creation is re-affirmed tied to a published draw with no duplicates (Phase 6, not re-implemented) |
| Database | `supabase/tests/storage.test.ts` (extended) |     1 | The reopen round-trip against the REAL storage RLS policy, end to end: rejected → blocked upload → `reopen_winner_proof()` (service role) → the SAME pre-existing `winner_proofs_objects_insert_owner` policy, unchanged, now permits the upload again                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Web      | `apps/web/src/winners.test.tsx`             |     6 | **Minimal UI to exercise the flow (not the Phase 8/9 dashboards):** `WinningsPage` lists only the caller's own winnings; the upload form calls `storage.from('winner-proofs').upload(...)` directly (never through the API) then registers the resulting path; a rejected winner's "Try again" reopens and shows the upload form once more; the admin `WinnersQueue` lists every winner, approves one (revealing the "mark paid" action), and marks an approved winner's payout paid; a non-admin never reaches the winners queue at all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**Where the rules live, and what that means.** Winner CREATION and its invariants (one per user per draw, only
for a published draw, immutable identity/prize) are entirely Phase 6/1 — untouched here. The four NEW state
transitions each go through a service-role-only SQL function (`register_winner_proof`, `reopen_winner_proof`,
`review_winner`, `mark_winner_paid`, migration `…160000`), the same atomic-row-lock-then-write shape as
`add_score()`/`simulate_draw()`/`publish_draw()` before them. Proof BYTES never pass through the API at all —
they go directly browser → the private bucket under the storage RLS policy already written in migration
`…100800`; the API only ever handles metadata and state. The service tests use `InMemoryWinners`
(`apps/api/src/test-support/winners.ts`), which mirrors the SQL functions' state machine but is **not** their
authority — `winners-function.test.ts` proves those on real PostgreSQL.

**Mutation-checked** (each defect introduced, the suite re-run, the file restored and verified byte-identical by
`cmp`): in the SQL migration — the `GS012` "payout requires approved" guard removed (1 failing DB test); in
`app.ts` — the `requireAdmin` guard removed from the `/api/admin/winners` mount (4 failing route tests, covering
403-for-non-admin and the "repository never even asked" assertion). Each mutation was caught before the file
was restored.

**Not proven — no hosted run was performed this phase** (same limitation as Phase 6: PGlite is single-connection,
so the new functions' row-locking is reasoned about, not raced, under real concurrent PostgreSQL connections).
The web tests use a faked API and a faked Supabase storage client (`apps/web/src/test-support/fakes.ts`), so the
real signed-URL shape, the real storage RLS policy's exact error surface reaching the browser, and a real image
upload have not been exercised in a browser against a hosted project. What the admin actually checks a
screenshot against remains a human judgement call (D-021's residual) and is not, and cannot be, automatically
tested.

## 4. Verification of the tests themselves (mutation checks)

A test that has never failed proves little. After the suite passed, ten deliberate defects were introduced into
the migrations one at a time and the whole database suite re-run. **All ten were caught**; the migrations were
restored afterwards and verified byte-identical by checksum.

| Mutation                                                          | Failing tests |
| ----------------------------------------------------------------- | ------------: |
| Users granted `UPDATE (role)` on profiles (self-promotion)        |             4 |
| `scores` select policy changed to `using (true)` (isolation lost) |             2 |
| Draft/simulated results readable through `draw_entries`           |             1 |
| Proof upload policy stops checking ownership                      |             1 |
| Score-cap trigger removed                                         |             3 |
| Published-draw guard removed                                      |             1 |
| Users granted `INSERT` on `scores`                                |             2 |
| `is_active_subscriber()` always true                              |             3 |
| Proof bucket made public                                          |             1 |
| `SECURITY DEFINER` function loses its pinned `search_path`        |             1 |

This was a one-off manual exercise (the script lived outside the repository). Re-run something similar after
any change to the security model.

**Lesson from the post-Phase-1 review.** A read-only checkpoint review then found two defects the suite had
_not_ exercised, because no test asked the question: a `SECURITY DEFINER` function taking an arbitrary user
id was executable by browser roles (a cross-user lookup that bypassed RLS), and the score-cap trigger rejected
statements that add no row (upsert-edit, `ON CONFLICT DO NOTHING`). Both were fixed by new migrations, with
regression tests written first and confirmed failing. The function allow-list test exists so a new helper
cannot be exposed by accident.

## 5. Limitations of the database tests (be honest about what is _not_ proven)

- **Not the real Supabase stack.** No Docker/Supabase CLI/PostgreSQL was available. PGlite is genuine
  PostgreSQL but is version 18.3 while hosted Supabase runs an earlier major version, and the shim only
  approximates Supabase's roles, `auth` and `storage` schemas. The migrations avoid version-specific features,
  but **they must be applied to a real local Supabase stack (`supabase db reset`) and re-tested before
  production use.**
- **No PostgREST layer.** Tests impersonate roles at the SQL level; they do not exercise the HTTP API, JWT
  verification, or the storage service (only its RLS policies).
- **No concurrency test.** The score cap uses a per-user advisory lock to stop two parallel inserts both
  passing, but PGlite is single-connection, so the race is reasoned about, not exercised. Test it against a
  real Postgres with parallel connections.
- **No performance testing.** Indexes were chosen from access patterns; no query plans or load were measured.
- **Hosted-Supabase specifics untested:** dashboard-created objects (which get Supabase's default grants),
  the `supabase_admin` default privileges, realtime/publication settings.
- **Business rules are not tested here** — matching, pool maths, eviction, rollover live in future domain
  modules (Layer 1). The database tests only prove the invariants the database enforces.

## 6. Layer 1 — Unit tests (planned)

Vitest, no I/O. Property-based testing (e.g. fast-check) may be added where invariants matter more than
examples. Rules requiring unit tests **once their decisions are settled**:

| Area         | Rule under test                                                            | Ref                                                                      |
| ------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Scores       | replace the oldest on the 6th entry; basis of "oldest"; back-dated entries | SCR-06, D-027                                                            |
| Draw         | generates 5 numbers in range; deterministic with a seeded RNG              | _implemented Phase 6 (3e) — `apps/api/src/draws/domain.test.ts`_         |
| Draw         | match counting produces the right 5/4/3 tiers                              | _implemented Phase 6 (3e)_                                               |
| Draw         | algorithmic weighting by score frequency                                   | _implemented Phase 6 (3e); D-013's favour-rare/population residual open_ |
| Prize pool   | pool depends on active subscribers; yearly plans handled per decision      | _implemented Phase 6 (3e); D-014's bps/fixed value still open_           |
| Prize pool   | tier shares 40/35/25 add up to the pool (no lost minor units)              | _implemented Phase 6 (3e)_                                               |
| Prize pool   | equal split between winners; remainder per decision                        | _implemented Phase 6 (3e)_                                               |
| Rollover     | jackpot rolls over when unclaimed; carried amount feeds the next draw      | _implemented Phase 6 (3e); D-019's verification-based residual open_     |
| Charity      | contribution ≥ 10% of the fee; rounding/basis per decision                 | CHR-02, CHR-03, D-025                                                    |
| Subscription | status → access mapping (active, cancelled, lapsed, non-subscriber)        | SUB-03, SUB-04, D-026                                                    |
| Winner       | payment state moves Pending → Paid only via allowed transitions            | _implemented Phase 7 (3f); D-022's real payout mechanism still open_     |

Every function that needs "now" or randomness takes a clock / RNG parameter.

## 7. Layer 2b — API integration tests (planned)

Vitest + in-process HTTP against the real Express app and a real database (the Supabase local stack, or a dedicated
throw-away test project — **never** the owner's personal project).

- **Admin authorization (D-005):** _implemented in Phase 2_ (Section 3a) — a test enumerates every route on
  the admin router and asserts anonymous callers get 401 and authenticated non-admins get 403, so an admin
  route cannot be added unprotected. Still planned: the same check against a real database and real Supabase
  tokens.
- **Subscription gating:** protected routes reject non-subscribers and lapsed subscribers per the access
  matrix (D-030), checking status on **every authenticated request** (SUB-05).
- **Stripe webhooks:** correctly signed test payloads are accepted; bad signatures rejected; duplicate
  deliveries idempotent (via `stripe_events`); out-of-order events do not corrupt state.
- **Draw workflow:** simulate → publish → winners are implemented and tested against the real database (Section
  3e, `supabase/tests/draws-function.test.ts`) and in-process against the real API (`apps/api/src/draws/routes.test.ts`).
  Still planned: real Supabase Auth tokens end-to-end.
- **Proof approval → payout:** implemented and tested Phase 7 (Section 3f) — register/reopen/review/mark-paid
  against the real database (`supabase/tests/winners-function.test.ts`) and in-process against the real API
  (`apps/api/src/winners/routes.test.ts`). Still planned: real Supabase Auth tokens end-to-end.
- **Storage:** signed-URL flows for proof are implemented Phase 7 (Section 3f) against a faked storage client
  (real bucket/RLS behaviour is proven separately, at the database layer, in `supabase/tests/storage.test.ts`).
  Still planned: a real image upload through a real browser against a hosted project.
- **Error handling:** validation failures, not-found and unexpected failures return the shared envelope
  without leaking internals.

## 8. Layer 3 — End-to-end tests (planned)

Playwright against the running web + api + Supabase, with Stripe **test mode** (test card
`4242 4242 4242 4242`). Journeys: visitor browses charities and starts signup; signup/login and subscribe;
score entry (validation, duplicate date, sixth score, newest-first); change contribution percentage and donate;
admin simulates and publishes a draw; winner uploads proof, admin approves, payout moves Pending → Paid;
non-subscribers and non-admins are blocked in the UI **and** by direct API calls; a mobile-viewport smoke run.
Test users come from a non-production seed script and are clearly labelled.

## 9. Quality gates and definition of done

A change is complete only when all of these pass:

```bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```

Plus, for any feature touching a critical rule, the tests above exist and reference the requirement/decision
ids. CI is **not** set up; running these locally is the current gate. Adding CI is a later, explicit step.
