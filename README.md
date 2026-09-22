# GATHER

Golf performance, charity contributions and a monthly prize draw — as a subscription platform for
visitors, subscribers and administrators.

> **Status: Phase 5 — subscriptions.** The monorepo, docs, the PostgreSQL schema, Supabase Auth, the **score
> engine**, the **charity domain** (choose a charity at signup; contribution percentage) and the **subscription/payment
> foundation** exist: a monthly and a discounted yearly plan, Stripe Checkout and Billing Portal in **test mode**, verified
> idempotent webhooks, and the charity contribution recorded for every payment. The draw engine, dashboards and the admin
> panel are **not built yet**.

## Stack

React + Vite + TypeScript · Node.js + Express + TypeScript · Supabase (PostgreSQL, Auth, Storage) ·
Stripe · shared TypeScript package · npm workspaces.

## Layout

```text
apps/web          React + Vite frontend
apps/api          Express API
packages/shared   Shared TypeScript contracts
supabase/         migrations/ (schema), tests/ (database tests), seed.sql (dev-only data)
docs/             PRD notes, decisions, architecture, testing strategy
```

## Requirements

- Node.js **≥ 22.12**
- npm **≥ 10** (developed on npm 11)

## Getting started

```bash
npm install
cp apps/api/.env.example apps/api/.env   # optional: defaults work without it
cp apps/web/.env.example apps/web/.env   # optional
npm run dev
```

- Web: <http://localhost:5173>
- API: <http://localhost:4000> — health check at <http://localhost:4000/api/health>

In development the web app proxies `/api` to the API, so the placeholder page shows the API status.

## Scripts

| Command             | What it does                                                    |
| ------------------- | --------------------------------------------------------------- |
| `npm run dev`       | Builds `shared`, then runs shared (watch), API and web together |
| `npm run build`     | Builds shared, then API, then web                               |
| `npm run typecheck` | Strict TypeScript check of every workspace                      |
| `npm run lint`      | ESLint (type-aware)                                             |
| `npm run format`    | Prettier write (`format:check` to verify only)                  |
| `npm test`          | Vitest in every workspace, including the database tests         |
| `npm run check`     | typecheck + lint + format:check + test                          |

To run the built API: `npm run build && npm run start -w @gather/api`.

## Database

The schema lives in [supabase/migrations/](supabase/migrations/) (fifteen ordered SQL files). It has **not**
been applied to any Supabase project yet. To provision, create a **new** Supabase project (never an existing
or personal one) and, with the Supabase CLI, run `supabase link --project-ref <new-ref>` then
`supabase db push`. `supabase/seed.sql` is development-only and is not pushed.

The migrations are tested against an in-process PostgreSQL (PGlite) — see
[docs/TESTING.md](docs/TESTING.md) for what that does and does not prove. Run only those tests with
`npm run test -w @gather/db-tests`.

## Authentication

Signup, login and logout use **Supabase Auth** (email + password) directly from the browser. The API only
verifies the bearer token and reads the user's role from `profiles.role` in the database on every request
(see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §8). Nothing has been provisioned, so to run it for real:

1. Create a **new** Supabase project (never an existing or personal one) and apply the migrations.
2. In the project: enable the Email provider; use asymmetric **JWT signing keys**; set the Site URL and
   redirect URLs; decide whether "Confirm email" is on (the app handles both).
3. Fill `apps/api/.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — **secret**, API only) and
   `apps/web/.env` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — public).

Without those variables the API still starts (`/api/health` works) but every authenticated route answers 503,
and in production it refuses to start.

### Creating the first administrator

Administrators cannot be created through the app. After the person has signed up normally, run this in the
Supabase SQL editor (or with the service role), replacing the email:

```sql
update public.profiles
   set role = 'admin'
 where id = (select id from auth.users where email = 'admin@example.com');
```

The change takes effect on their next request; no re-login is needed.

## Charities API

**Public** (no sign-in) — only _listed_ (non-archived) charities are ever returned:

| Method and path                                                        | What it does                                                                  |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /api/charities?q=river&tag=youth&featured=true&limit=20&offset=0` | The directory: word-prefix search, exact tag, featured only; `hasMore` paging |
| `GET /api/charities/:slug`                                             | Profile: description, images, **upcoming** events                             |
| `GET /api/charity-spotlight`                                           | Featured charities for the homepage (up to 6)                                 |

**Signed in** (`Authorization: Bearer <token>`; always your own data — a `userId` anywhere in a request is ignored):

| Method and path                                                       | What it does                                                                                             |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /api/me/charity`                                                 | Your chosen charity, your percentage (basis points) and the limits                                       |
| `PATCH /api/me/charity` `{ "charityId": "…", "percentageBps": 1500 }` | Change either or both. The percentage may be **any value from 10% (1000) up**, raised or lowered (D-064) |
| `GET /api/me/contributions`                                           | Your contribution history (read-only) with per-currency totals                                           |

Errors: `400 validation_failed`, `404 charity_not_found`, `422 charity_unavailable` (archived),
`422 percentage_below_minimum`, `422 percentage_above_maximum`. Choosing a charity does **not** need a
subscription. The charity's share of each payment is recorded by the subscription webhooks (see "Subscriptions and payments").
See DECISIONS D-064 and D-065. In the web app: `/charities`, `/charities/:slug`, the homepage spotlight, the
signup form and `/account/charity`.

**Choosing a charity at signup (D-066).** The signup form requires a charity (only listed ones are offered; a
choice made earlier on a charity profile is pre-selected) and sends it with the signup, where the database records
it. It can be changed later on `/account/charity`. **Subscribing requires a currently selected, listed
charity** (an archived one blocks it until replaced) — that precondition is built and tested
(`requireSubscribableCharity`), and Stripe Checkout calls it (see "Subscriptions and payments").

**Applying the charity migrations** to the linked project: `supabase db push` (migrations
`20260921120000_charity_selection_guard.sql`, which stops an archived charity being chosen, and
`20260921130000_signup_charity_selection.sql`, which records the charity chosen on the signup form). Until the
second one is applied, a new signup's charity choice is not recorded and the user must choose on `/account/charity`.

**Trying it with sample charities.** There is no admin tool for charities yet, so add **fictional,
development-only** data in the SQL editor. Keep tags **lower-case** — the tag filter matches exactly. To show an
image, upload a file to the `charity-media` bucket first and use its path.

```sql
insert into public.charities (slug, name, description, tags, is_featured)
select 'sample-riverside-youth', 'SAMPLE Riverside Youth Fund',
       'Golf coaching for young people by the river. Fictional development data.', array['youth','sport'], true
where not exists (select 1 from public.charities where slug = 'sample-riverside-youth');

insert into public.charities (slug, name, description, tags)
select 'sample-clean-oceans', 'SAMPLE Clean Oceans',
       'Beach clean-ups and coastal protection. Fictional development data.', array['environment']
where not exists (select 1 from public.charities where slug = 'sample-clean-oceans');

insert into public.charity_events (charity_id, title, description, location, starts_at)
select c.id, 'Charity golf day', 'A day on the course.', 'Riverside GC', now() + interval '30 days'
from public.charities c
where c.slug = 'sample-riverside-youth'
  and not exists (select 1 from public.charity_events e where e.charity_id = c.id);

-- with a file uploaded to the charity-media bucket at sample/cover.png:
-- insert into public.charity_images (charity_id, storage_path, alt_text)
-- select id, 'sample/cover.png', 'Children on a fairway' from public.charities where slug = 'sample-riverside-youth'
-- on conflict (charity_id, storage_path) do nothing;
```

Undo it: `delete from public.charities where slug like 'sample-%';` (events and images cascade).

## Subscriptions and payments (Stripe, TEST MODE only)

Card details are entered on **Stripe's own pages** (Checkout and the Billing Portal); this app never receives or stores
them. Stripe tells the API what happened through **signed webhooks**, which are verified and applied idempotently
(DECISIONS D-067, D-068, D-069).

| Method and path                                                     | What it does                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /api/plans`                                                    | The plans that can be bought (public)                                                             |
| `GET /api/me/subscription`                                          | Your subscription: status, plan, renewal date, whether it ends at period end                      |
| `POST /api/me/subscription/checkout` `{"interval":"month"\|"year"}` | Starts Stripe Checkout; returns the hosted page URL. **Needs a selected, listed charity** (D-066) |
| `POST /api/me/subscription/portal`                                  | Opens the Stripe Billing Portal (update card, change plan, cancel)                                |
| `POST /api/webhooks/stripe`                                         | Stripe's webhooks (raw body, authenticated by signature). Not for browsers                        |

In the web app: `/account/subscription`. **Prices, the discount and the currency are data, not code**: no price is decided
yet (D-024), so you insert the plan rows yourself.

**Setting it up (test mode):**

1. Apply the migration: `supabase db push` (`20260921140000_billing_foundation.sql`).
2. In the Stripe **test-mode** dashboard create one product with a **monthly** and a **yearly** recurring price, the yearly
   **cheaper than 12 × monthly** (otherwise the yearly plan is not offered). Configure the **Billing Portal** (cancel at
   period end, switching between the two prices, payment method update).
3. Insert the plans (**development-only placeholder amounts** — replace with real prices when they are decided; run in the
   SQL editor, with your own `price_…` ids):

   ```sql
   insert into public.plans (name, billing_interval, amount_minor, currency, stripe_price_id) values
     ('DEV Monthly - placeholder price', 'month',  1000, 'USD', 'price_REPLACE_MONTHLY'),
     ('DEV Yearly - placeholder price',  'year',  10000, 'USD', 'price_REPLACE_YEARLY');
   ```

4. In `apps/api/.env` set `STRIPE_SECRET_KEY` (`sk_test_…`) and `STRIPE_WEBHOOK_SECRET` (`whsec_…`) — both **secret**,
   API only; **live keys are refused** and make the API refuse to start. Without them everything still runs and the
   Stripe-dependent endpoints answer `503`.
5. Forward webhooks locally with the Stripe CLI: `stripe listen --forward-to localhost:4000/api/webhooks/stripe --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_succeeded,invoice.payment_failed`
   (it prints the `whsec_…` to use), then restart the API.
6. Check the setup: `npm run preflight:stripe -w @gather/api` (read-only) confirms the billing migration is applied and that each
   `plans` row matches its Stripe price (amount, currency, interval, test mode) and that the yearly plan is a real discount. Test with card `4242 4242 4242 4242`; `4000 0000 0000 0341` fails on
   renewal.

The full hosted verification checklist is in [docs/TESTING.md](docs/TESTING.md) §3d. Undo the sample plans with
`delete from public.plans where name like 'DEV %';` (only while nothing references them).

## Scores API

Signed-in users manage their own Stableford scores (PRD §05). Every endpoint needs `Authorization: Bearer <token>`;
the user is taken from the verified token only.

| Method and path                                                          | What it does                                                                                                     |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `GET /api/scores`                                                        | Your scores, **newest first** (any signed-in user)                                                               |
| `POST /api/scores` `{ "playedOn": "2026-03-05", "stablefordScore": 36 }` | Add a score (`201`). With five already, the **earliest-dated** one is replaced and `replacedPlayedOn` says which |
| `PUT /api/scores/2026-03-05` `{ "stablefordScore": 40 }`                 | Edit the value of the score for that date                                                                        |
| `DELETE /api/scores/2026-03-05`                                          | Delete it (`204`)                                                                                                |

Rules: score is an integer 1–45; the date is a real `YYYY-MM-DD`; one score per date (`409` otherwise); a date
older than all five of your scores is refused (`422 score_too_old`); **writing needs an active subscription**
(`403 subscription_required`). See DECISIONS D-061 and D-062.

**Applying the score migration** to the linked project: `supabase db push` (migration
`20260921110000_add_score_function.sql`).

**Trying it before Stripe exists.** No subscriptions can exist yet, so make the test user an active subscriber
with this **development-only** SQL (placeholder price — pricing is undecided, D-024; run in the SQL editor,
replacing the email):

```sql
insert into public.plans (name, billing_interval, amount_minor, currency)
select 'DEV placeholder - not a real price', 'month', 100, 'XTS'
where not exists (select 1 from public.plans where billing_interval = 'month' and is_active);

insert into public.subscriptions (user_id, plan_id, status, current_period_end)
select u.id, (select id from public.plans where billing_interval = 'month' and is_active limit 1),
       'active', now() + interval '30 days'
from auth.users u
where u.email = 'test-user@example.com'
  and not exists (select 1 from public.subscriptions s where s.user_id = u.id and s.status in ('pending', 'active'));
```

Undo it (removes the subscription and the placeholder plan):

```sql
delete from public.subscriptions where user_id = (select id from auth.users where email = 'test-user@example.com');
delete from public.plans where name like 'DEV placeholder%';
```

## Environment variables

Each app has its own `.env.example`; the root [.env.example](.env.example) indexes all of them.
Real `.env` files are git-ignored — **never commit secrets**. Variables for Supabase and Stripe are
listed as commented placeholders and are not read by any code yet. Everything prefixed `VITE_` is
public; the Supabase service-role key belongs only in the API environment.

## Documentation

- [docs/PRD_NOTES.md](docs/PRD_NOTES.md) — explicit requirements, ambiguities, assumptions
- [docs/DECISIONS.md](docs/DECISIONS.md) — decision log, including unresolved decisions
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — planned architecture and security boundaries
- [docs/TESTING.md](docs/TESTING.md) — unit, integration/database and end-to-end strategy

## Deployment

Not yet provisioned. The plan is a **new** Vercel account and a **new** Supabase project (never any
existing or personal ones); see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and decision D-031.
