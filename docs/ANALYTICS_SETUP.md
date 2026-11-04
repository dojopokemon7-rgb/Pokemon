# Analytics Setup — PostHog (EU)

Dojo ships one optional, client-side analytics tracker: **PostHog** (product
analytics, funnels, session replay, error tracking). The event list lives in
`docs/ANALYTICS_EVENTS.md`.

It is **off by default**. It loads only when (1) the project key is configured
**and** (2) the visitor clicks **Accept** on the cookie-consent banner. With no
key set there is zero analytics code on the wire — no network, no cookies.

---

## 1. Get your key

Dojo's PostHog project is on the **EU cloud**.

1. Sign in at <https://eu.posthog.com> and open the project
   (<https://eu.posthog.com/project/333915>).
2. **Project Settings → Project API Key** — copy the project token (`phc_...`).
3. Ingestion host: `https://eu.i.posthog.com`.

**Dev vs prod projects.** Create a second PostHog project (e.g. "Dojo Dev") so
tester traffic never pollutes real metrics. Production uses the prod project key
in the root `.env` (`NEXT_PUBLIC_POSTHOG_*`). Staging has its own build vars
`STAGING_NEXT_PUBLIC_POSTHOG_KEY` / `_HOST` / `_DASHBOARD_URL`, which
`docker-compose.yml` feeds to the `app-staging` build. They go in the **root
`.env`**, not `.env.staging`: `NEXT_PUBLIC_*` is inlined at build time and compose
only interpolates the root `.env`. Leave them unset and staging analytics is a
no-op (staging no longer reuses the production key). Local dev: set
`NEXT_PUBLIC_POSTHOG_KEY` to the dev project key in your own `.env`.

**Session replay.** The SDK records with every input masked
(`maskAllInputs`), but replay must also be switched on in PostHog
(Project Settings -> Session replay). Error tracking uses `capture_exceptions`
and shows up under Error tracking.

---

## 2. Environment variables

All are `NEXT_PUBLIC_*` — **public client keys, not secrets**. Templates and
comments live in `.env.example`:

| Variable | Required? | Example |
|---|---|---|
| `NEXT_PUBLIC_POSTHOG_KEY` | yes (else no-op) | `phc_xxxxxxxx` |
| `NEXT_PUBLIC_POSTHOG_HOST` | yes | `https://eu.i.posthog.com` |
| `NEXT_PUBLIC_POSTHOG_DASHBOARD_URL` | optional | `https://eu.posthog.com/project/333915` |

An unset/blank key makes PostHog a **total no-op**.

---

## 3. Consent gating

A bottom banner (`src/components/CookieConsent.tsx`) asks every visitor to
Accept or Decline. The choice persists in `localStorage` under
`dojo-analytics-consent` (`granted` | `denied`).

- **Nothing** loads until the choice is `granted` — not on Decline, not before a
  choice is made. `posthog.identify` and every `track()` call are gated the same
  way (they are no-ops until PostHog is initialized).
- Flipping consent takes effect without a page reload (a `dojo-consent-changed`
  event re-runs the init check).

---

## 4. ⚠️ Build-time inlining (Docker / standalone)

**This is the step that silently breaks if skipped.** Next.js **inlines** every
`NEXT_PUBLIC_*` value into the client bundle at **`next build` time** — it does
**not** read them at runtime. Set them in `.env` **before**
`docker compose up --build`, or PostHog will never load even with the key sitting
in the runtime `.env`.

- **`Dockerfile`** (builder stage) declares `ARG` + `ENV` for the vars
  **before** `RUN npm run build`.
- **`docker-compose.yml`** passes them under `app.build.args` (and
  `app-staging.build.args`), sourced from the root `.env` via `${VAR}`
  substitution at `--build` time.

The same build-time values also drive the Content-Security-Policy in
`next.config.ts` (see §6).

### Operator sequence (prod)

```bash
# 1. Put the vars in the ROOT .env on the server (same dir as docker-compose.yml)
#    NEXT_PUBLIC_POSTHOG_KEY=phc_...
#    NEXT_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com
#    NEXT_PUBLIC_POSTHOG_DASHBOARD_URL=https://eu.posthog.com/project/333915

# 2. (optional) confirm compose resolves the build args
docker compose config

# 3. BUILD so the values get inlined, then bring the stack up
docker compose up -d --build app
```

Changing any `NEXT_PUBLIC_*` value later requires a **rebuild** (`--build`).

---

## 5. INR values (`value_inr`)

Every money event carries `value_usd` (the real stored USD price, source of
truth) and `currency: "USD"`. `value_inr` is added **only when a real USD->INR
rate exists**; otherwise it is omitted (never 0, never a guess). The rate comes
from `GET /api/fx/usd-inr` (built on `fx.service`, Redis-cached 24h), which the
browser calls once per session.

exchangerate.host-style providers now **require an API key** (the old keyless
call returns HTTP 401). Set the server-side, non-public env var
`EXCHANGE_RATE_API_KEY` (see `.env.example`) and restart the app (no rebuild
needed; it is not `NEXT_PUBLIC_*`). **Until a working FX provider key is set,
events carry `value_usd` only and no INR.** The provider payload shape
(`quotes.USDINR`) follows its published contract but has not been verified
against a live key; a mismatch degrades to "no INR", never to wrong numbers.
Check with `curl https://<host>/api/fx/usd-inr` -> `{"rate":<number>,"asOf":...}`.

---

## 6. Content-Security-Policy

`next.config.ts` ships an enforcing CSP. PostHog is allowlisted minimally,
derived from `NEXT_PUBLIC_POSTHOG_HOST` (EU: `eu.i.posthog.com` for ingestion and
`eu-assets.i.posthog.com` for lazy-loaded scripts such as the session-replay
recorder): `connect-src` gets both origins, `script-src` gets the assets origin.
`worker-src blob:` was already present. Once a first-party `/ph` reverse proxy
ships, these can shrink to `'self'`.

---

## 7. Admin dashboard link

`/admin/analytics` has an **External Analytics** card
(`src/app/(admin)/admin/_components/ExternalAnalyticsLinks.tsx`) linking to
PostHog in a new tab: `NEXT_PUBLIC_POSTHOG_DASHBOARD_URL` if set, else
`NEXT_PUBLIC_POSTHOG_HOST`. When neither is set it shows a muted
"Configure analytics keys to enable" state instead of a broken link.

---

## 7b. In-app admin dashboard (server key)

`/admin/analytics` shows PostHog analytics in-app via the admin-only
`GET /api/admin/analytics` -> HogQL Query API
(`src/lib/services/posthog-query.service.ts`). It is manager-oriented and
read-only — NOT a PostHog clone. One page, grouped by client feature area, all
honoring the range (24h/7d/30d) + environment (production/staging/all)
selectors, all honest ("Analytics not configured" / "PostHog unavailable" /
empty-state rows / "—", never fabricated numbers). The External Analytics card
stays as a secondary 'Open in PostHog' link.

Sections (top to bottom):

- **Overview cards** — visitors, pageviews, signups, logins, cards added + USD
  value, searches, zero-result searches, wishlist adds, scans started/succeeded,
  errors.
- **Recent activity** — the latest ~100 BUSINESS events (named taxonomy events +
  `$exception`; autocapture / `$pageview` / `$pageleave` / web-vitals noise is
  excluded), newest first. Columns: Time, User (person email, "anonymous" when
  none), Action (friendly label), Detail (the one salient prop — card id,
  search query + result count, filter type, auth method, scan-fail reason, or
  chart range), Value (USD, plus INR when present), Env.
- **Search & discovery** — top search terms, top zero-result searches (unmet
  demand), most-viewed cards, filter breakdown, searches by game.
- **Portfolio & collection** — most-added cards (qty + summed USD), cards
  removed, raw-vs-graded split, adds by game, chart-range popularity.
- **Wishlist** — most-wishlisted cards, wishlist by game.
- **Scanner** — started/succeeded/failed counts, success rate %, failure-reason
  breakdown, scans by game.
- **Auth & activation** — signups by method, logins by method, onboarding
  completed, password resets, and the visit->signup->card-added funnel.
- **Engagement & quality** — `$exception` count + a recent-errors list
  (type/message when PostHog captured them), top events, daily trend.

### Drill-down (from the numbers to the people and cards)

The dashboard is clickable — you go from an aggregate into the specific people
and cards behind it, without leaving the admin panel:

- **Clickable user → live per-user activity.** In the Recent-activity feed the
  User cell links to `/admin/users/[id]`. The email still comes ONLY from the
  PostHog person join; the internal user id is resolved SERVER-SIDE by a Prisma
  `email → user.id` lookup in `GET /api/admin/analytics` (anonymous / deleted
  users have no match and render as plain text, no link). That user-detail page
  now shows the user's REAL recent behaviour — `getUserActivity(email)` runs an
  allowlist-safe HogQL query filtered to that person (email bound via a
  `{email}` placeholder, never interpolated), merged with the concrete DB facts
  we already track (account created, profile updated) into one newest-first
  feed. If PostHog is not configured / unavailable it falls back to the DB facts
  only with a "Live activity unavailable — showing account facts only" note;
  configured-but-zero-events shows the facts + an empty-behaviour note (never a
  fabricated row).
- **Clickable card → analytics popover.** Clicking a `card_id` (feed card cells
  and the most-added / most-viewed / most-wishlisted lists) opens a lightweight
  popover showing that card's PostHog aggregate — times viewed, times added
  (with quantity + summed USD), times wishlisted — over the SELECTED
  range+environment, via `GET /api/admin/analytics/card` →
  `getCardActivity(cardId, range, env)` (card_id bound via a `{card_id}`
  placeholder). Row-capped and Redis-cached ~90s. PostHog unavailable → honest
  empty/unavailable state. There is NO full per-card admin page by design.

The manager-not-PostHog-clone split still holds: **Postgres** backs identity /
portfolio FACTS (exact + free — the user-detail financials, portfolio table),
**PostHog** backs BEHAVIOUR (cached + row-capped — the feeds and the card
popover). Deep replay and ad-hoc funnels stay behind "Open in PostHog".

**What stays in PostHog (the "Open in PostHog" link), by design:** in-app
session replay and interactive/ad-hoc chart builders. This page is a readable
summary + the salient detail per feature + the drill-downs above, not a query
tool.

**Cost:** every section is a row-capped HogQL query (recent activity ≤100 rows,
ranked lists ≤10) batched into one round-trip per page load, and the whole result
is Redis-cached ~90s (optional; a cache miss/outage just re-queries). This keeps
a page load from hammering the PostHog query quota.

1. PostHog -> Settings -> Personal API keys -> create a key with the **Query read** scope.
2. Set `POSTHOG_PERSONAL_API_KEY` (server secret, never `NEXT_PUBLIC_`), optional `POSTHOG_PROJECT_ID` (default 333915) and `POSTHOG_API_HOST` (default https://eu.posthog.com).
3. Add the key to **BOTH** `.env` (prod) and `.env.staging` (compose `env_file` for `app` / `app-staging`), then recreate the containers (`docker compose up -d app app-staging`).
   It is runtime server env: no rebuild needed.

Unset key -> 'Analytics not configured'; PostHog error -> 'PostHog unavailable'; no value -> '—'.
Results are cached ~90s in Redis (optional). The funnel counts unique users per step in the
window (not strictly ordered). Events predating the `environment` super-property are excluded
from production/staging filters (use 'all').

---

## 8. What gets tracked

Autocapture (clicks, form submits), manual `$pageview`s, session replay,
exceptions, and the custom events in `docs/ANALYTICS_EVENTS.md`. The signed-in
user is `identify()`d with their Dojo user id; email and name live on the person
profile only. Not-yet-built flows (stores, trading floor, events, price
triggers, CGC) are listed there as backlog.
