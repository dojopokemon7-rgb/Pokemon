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

**Environments share ONE free-tier project (separated by a tag).** On the
free tier Dojo runs a SINGLE PostHog project; prod and staging both send to the
same key (`NEXT_PUBLIC_POSTHOG_KEY`) and are told apart by an `environment`
super-property, not by separate projects. `src/lib/analytics/environment.ts`
derives that tag from the hostname (`localhost`/`127.0.0.1` → `development`, any
host containing `staging` → `staging`, `dojocollect.com` / `*.dojocollect.com` →
`production`, else `unknown`), and `AnalyticsProvider` registers it on every
event. The admin dashboard then filters on `properties.environment`
(production / staging / all), so tester traffic is isolated without a second
project.

`STAGING_NEXT_PUBLIC_POSTHOG_KEY` / `_HOST` / `_DASHBOARD_URL` are the ready
**upgrade switch**: they are already wired into `docker-compose.yml` as
`app-staging` build args (sourced from the root `.env` — `NEXT_PUBLIC_*` is
inlined at build time and compose only interpolates the root `.env`). Leave them
unset and staging keeps using the shared key + `environment` tag (today's
design). Point them at a dedicated "Dojo Staging" project ONLY when the client
leaves the free tier and wants fully separate projects — do not invent that
second project or change the compose wiring before then. Local dev: set
`NEXT_PUBLIC_POSTHOG_KEY` in your own `.env` (it carries the `development` tag
automatically).

### UTM attribution scheme

Signup conversion by acquisition source is driven entirely by UTM params on the
landing URL — there is no extra instrumentation. The canonical links:

| Source | URL params |
|---|---|
| Instagram | `?utm_source=instagram&utm_medium=social` |
| Comic Con QR | `?utm_source=comic_con&utm_medium=qr&utm_campaign=<event-name>` |
| Campaign link | `?utm_campaign=<name>` (with `utm_source`/`utm_medium` as relevant) |
| Direct | no UTM params → bucketed **`direct / none`** |

The app does **not** strip UTM params: `AnalyticsProvider` captures a manual
`$pageview` with no property editing, so PostHog reads `utm_*` straight off the
landing URL and records them as initial-touch person properties
(`$initial_utm_source` / `_medium` / `_campaign`). Those first-touch props back
the signup-attribution breakdown in the admin dashboard (read via the person
join, never event props); people with no initial-touch UTM show as
`direct / none`.

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
- **Active users (distinct people)** — Daily / Weekly active users and Weekly
  active collectors. These count distinct PEOPLE (`uniq(person_id)`, de-duped
  across sessions — NOT `uniq(distinct_id)`). DAU/WAU are fixed rolling 24h/7d
  windows (independent of the range selector); Weekly active collectors =
  distinct people who added OR removed a card in the last 7 days (the one-line
  definition is shown under the number).
- **Retention & acquisition** — three blocks (all honest "—" when the cohort is
  too small/empty, never a fabricated 0% / 100%):
  - **Retention (D1 / D7 / D30)** — first-seen retention. Each person is anchored
    on their first-ever business-event day; a bucket is the share of the
    observable cohort (people old enough to reach that bucket) who returned (any
    business event except `$exception`) exactly 1 / 7 / 30 days later. This is a
    whole-population metric — the range selector does not scope the anchor.
  - **Weekly signup cohorts** — signup_completed people grouped by signup week
    (`toStartOfWeek`); each following-week cell is the share of that cohort who
    returned in that later week.
  - **Signup conversion by acquisition source** — distinct signup_completed
    people bucketed by their INITIAL-TOUCH UTM (`$initial_utm_source` /
    `_medium` / `_campaign`, read via the person join — same mechanism as email,
    never event props). Missing/blank UTM is bucketed as **`direct / none`**
    (never blank, never fabricated), so Instagram / Comic Con QR / campaign /
    direct traffic all surface from whatever the initial-touch props carry.
- **Recent activity** — the latest ~100 BUSINESS events (named taxonomy events +
  `$exception`; autocapture / `$pageview` / `$pageleave` / web-vitals noise is
  excluded), newest first. Columns: Time, User (person email, "anonymous" when
  none), Action (friendly label), Detail (the one salient prop — card NAME
  (raw id as tooltip), search query + result count, filter type, auth method,
  scan-fail reason, or chart range), Value (USD, plus INR when present), Env.
  Click any overview count card to drill this feed down to just the rows behind
  that number (see Drill-down below).
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

- **Clickable count cards → the rows behind the number.** Every overview count
  card is a button (hover/pointer/focus-ring, `aria-pressed`). Clicking one
  re-loads the Recent-activity feed scoped to just the rows behind that number
  and scrolls to it — Logins → `login_completed` rows, Cards added →
  `card_added`, Searches → `search_performed`, Zero-result searches →
  `search_performed` with `results_count = 0`, Wishlist adds → `wishlist_added`,
  Scans started/succeeded, Signups → `signup_completed`, Errors → `$exception`.
  The feed is RE-QUERIED server-side (not just a client slice of the ~100-row
  default feed) so it shows the TRUE rows for the metric; an active-filter chip
  with a one-click "Show all" sits above the feed and the heading reflects the
  filter ("Logins — 2 events"). The filter param is Zod-validated against a
  FIXED allowlist (the taxonomy event names + a `zero_result` pseudo-value +
  `$exception`) and mapped to a constant HogQL predicate — never free text,
  never interpolated. Pageviews stays a plain stat (anonymous `$pageview` loads
  have no honest per-row business feed). Changing range/environment clears the
  drill-down.
- **Unique Visitors → the distinct persons behind it.** Clicking Unique Visitors
  shows the DISTINCT persons in the window: identified ones by email (linking to
  their user page via the same server-side email→user-id resolution) plus an
  honest "anonymous (N)" remainder for persons with no profile email. **All three
  numbers are counted on the SAME person axis (`uniq(person_id)`), so they
  reconcile: `total = identified + anonymous` ALWAYS holds.** `total =
  uniq(person_id)`, `anonymous = uniqIf(person_id, empty(email))`, and the
  headline `identified` is DERIVED as `total - anonymous` — never the length of
  the drill-down list. (Counting `total`/`anonymous` on `distinct_id` while
  `identified` was on person-email was the bug behind the impossible "8 distinct
  / 2 identified / 0 anonymous": PostHog person-merge stitches a pre-login
  anonymous `distinct_id` onto a person that later has an email, collapsing a
  `distinct_id`-based anonymous count to 0.) The identified drill-down LIST is
  capped at `PERSONS_LIMIT` (200); when more identified persons exist than the
  list shows, the panel stays honest with **"showing N of M identified"** — the
  reconciliation guarantee is at the COUNT level, not the displayed-list length.
  NO identity is ever fabricated (`view=persons`, allowlist-safe, Redis-cached
  ~90s).
- **Per-feature DETAIL label rows → the events behind them.** The SAME feed
  reveal (ONE consistent label-row interaction) extends to the per-feature
  lists: each row in Top search terms, Top zero-result searches, Filters
  applied, Scanner failure reasons, and Signups/Logins by method is an
  accessible drill button (hover/pointer/focus-ring, `aria-label`). Clicking one
  re-loads the Recent-activity feed scoped to that row's events — who did it and
  when — with the same chip + "Show all" + heading, and only ONE reveal is
  active at a time. Safety: the `dimension` (`search_term`, `zero_result_term`,
  `filter_type`, `scan_reason`, `signup_method`, `login_method`) is a FIXED
  allowlist → a constant HogQL predicate; the row's `value` is the ONLY dynamic
  part and is bound via a `{value}` placeholder (never interpolated); the
  categorical dimensions (`filter_type`/`scan_reason`/`*_method`) ALSO allowlist
  the value against their fixed enum (off-list → 400, PostHog never called —
  double-guard). The card lists keep the card popover below, and pure
  ratio/by-game/chart-range/funnel/daily rows stay static (no honest per-person
  drill).
- **Card NAMES everywhere a card id appears.** The feed Detail cell, the
  most-added / most-viewed / most-wishlisted lists, and the card popover header
  lead with the human-readable card name (catalog `externalId` → `Card.name`,
  resolved SERVER-SIDE in one batched Prisma query — no N+1, RULE 3 on the
  catalog id, composite `base::variant` ids split to the base). The raw id stays
  available as a tooltip / secondary line. Unknown / missing card → the raw id
  (honest, never a fabricated name).
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
a page load from hammering the PostHog query quota. The count-card drill-downs
are lazy — the scoped feed (`event=…`, one capped query), distinct-persons
(`view=persons`, two capped queries) and the per-feature row reveal
(`dimension=…&value=…`, one capped query) only fire when a card/row is clicked,
and each is Redis-cached ~90s under its own key.

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
