# Dojo TCG Collection PWA — Handoff

## 1. Project Overview

Dojo is a phone-first Progressive Web App for tracking a trading-card-game
collection (Pokémon and One Piece). Users can search a card catalog, build
named collections, track a want list, view price history, compare
collections, and manage their profile — all behind real authentication.

**Tech stack**

- **Next.js** (App Router, React, TypeScript) — UI, routing, API routes; runs
  as a standalone production build.
- **Prisma** — type-safe ORM and schema/migrations.
- **Supabase (PostgreSQL)** — the system of record for all persistent data.
- **Better Auth** — email/password + Google OAuth sessions.
- **Redis (ioredis)** — optional cache only (trending feed, eBay search/token,
  card prices). Never the source of truth; every cache call degrades to the DB
  when Redis is unavailable.
- **TanStack Query (React Query)** — client data fetching, caching, and
  optimistic mutations.
- **Playwright** — end-to-end tests. **Vitest** — unit + integration tests.

## 2. Features Completed

- **Authentication (F-02)** — email/password + Google OAuth account linking,
  logout, session-gated dashboard routes.
- **Card Search / Explore** — catalog search with **debounced live search
  (F-05)**, game tabs (Pokémon / One Piece), sort, and **set filters (F-06)**.
- **Show More pagination (F-04)** — offset-based paging with zero duplicates.
- **Card Details Popup (F-08)** — in-place modal with image, prices, grade,
  and add-to-collection / favourites / want-to-buy actions.
- **Collections (F-10 / F-11)** — create / rename / privacy + type tag /
  delete; per-collection aggregated headline stats on the dashboard.
- **Compare Collections (F-22)** — side-by-side Total Value / Card Count for
  two selected collections on the profile page.
- **Want List (F-07)** — Buy / Sell / Trade tabs; add from search, move between
  tabs, remove.
- **Graded Add Flow (F-19)** — a dedicated graded-add modal (Grading Company +
  Grade) that persists graded metadata.
- **Optimistic Favourites (F-20)** — instant star toggle with rollback on
  failure via React Query.
- **Price history + charts (F-09 / F-16 / F-18)** — interactive chart with
  tooltips; Dojo Value + eBay price sources with stale-value handling.
- **Scanner** — camera-based card recognition with hardening for permission
  denial, unrecognized images, and API errors.
- **Contact Support** — validated support-request submission.
- **Notifications Panel** — header bell that toggles a dropdown; empty-state
  today (see Known Limitations).
- **Design tokens** — brand colors consolidated onto CSS variables in
  `globals.css` (Dojo Gold, jade, app surfaces, strokes).

## 3. Architecture & Key Patterns

- **Test-Driven Development (Red → Green).** Each feature began with failing
  tests that pinned the target behaviour (Red), followed by the minimal
  implementation to make them pass (Green), then a full `npm run verify`.
- **Pure utility functions for domain logic.** Aggregation and comparison are
  pure, deterministic functions (`src/lib/utils/collection-aggregation.ts`,
  `src/lib/utils/compare-collections.ts`) tested in isolation without a DB.
  `compareCollections` reuses `aggregateCollectionStats` so the two views can
  never disagree.
- **Offset-based pagination.** The trending/search feeds page via `skip: offset`,
  which composes correctly with any sort order and avoids the duplication a
  cursor-on-a-shifting-sort approach caused.
- **Optimistic UI with React Query.** `useFavorites` uses `onMutate` (cancel +
  snapshot + optimistic cache write), `onError` (rollback to the snapshot), and
  `onSettled` (invalidate to reconcile with the server).
- **Debounced, URL-driven search.** Typing schedules a 350ms timer that updates
  the `?q=` URL param, which the results query reacts to; Enter fires
  immediately. Search stays URL-driven so deep links, game tabs, sort, and
  filters all compose.
- **Cache-optional backend.** Redis is a best-effort cache; every read/write is
  wrapped so a Redis outage falls through to Postgres. This is why the suite is
  fully green even with no Redis server running (you'll see non-fatal
  `[Redis] … falling through` logs).
- **Visual regression gated behind `VISUAL=1`.** Pixel-diff snapshot tests only
  run when explicitly enabled, keeping the default suite deterministic across
  machines while still allowing an opt-in visual check.
- **Self-contained, token-styled components.** UI components (e.g.
  `NotificationsPanel`, `CardDetailsPopup`) own their state/interactions and
  style exclusively via the `--color-dojo-*` CSS variables.

## 4. Test Coverage

Run everything with a single gate:

```
npm run verify
```

which chains: `lint` → `test:unit` → `test:integration` → `test:chart-accuracy`
→ `test:e2e`.

Current status (all green):

- **Lint** — clean (ESLint).
- **Unit (Vitest)** — 17/17. Pure utilities: aggregation, comparison, card
  sort, graded price, app render smoke test.
- **Integration (Vitest)** — 51/51. Service/validator contracts and golden
  data: collections CRUD, compare-collections, contact support, price sources,
  graded pricing, bulk-add ordering, golden prices.
- **Chart Accuracy gate** — 60/60 data points within ±10% of the Collectr
  reference (see Known Limitations).
- **E2E (Playwright)** — **37/37 passing**. Runs against a precompiled
  standalone production build on port 3001 (matching `BETTER_AUTH_URL`). The
  `authed` project reuses a real server-trusted session via `storageState`
  provisioned by `auth.setup.ts`.

**E2E projects:** `setup` (session), `chromium` (unauthenticated redirect),
`google` (mocked OAuth), `authed` (session-backed features), `camera` (fake
media device for the scanner).

## 5. Known Limitations & Future Work

- **Notifications Panel is UI-only.** It renders the empty state ("No new
  notifications") and already accepts a `notifications` prop with a rendered
  list, so wiring a future `GET /api/notifications` is a data-only change with
  no UI rewrite.
- **Chart Accuracy uses a MOCKED Collectr reference.** The gate validates our
  computed `PricingHistory` against a fixed mocked series. Swapping in the real
  Collectr feed is a body-only change to the reference source in
  `scripts/compare-chart-accuracy.ts` — the ±10% tolerance and comparison
  harness stay the same.
- **Graded metadata is stored via the `condition` field.** As a pragmatic MVP,
  a graded card's company + grade is persisted as its collection row
  `condition` string (e.g. "PSA 10"), and catalog graded-ness is encoded in
  `rarity` ("PSA n"). A dedicated `grade` column on `Card` / `UserCollection`
  is the clean future migration; existing values would migrate off `condition`
  / `rarity`.
- **eBay / Meta OAuth.** Google login is fully wired via Better Auth. The
  Facebook/Meta login button is an honest placeholder (shows a "coming soon"
  toast) until a provider is configured. The non-functional "Meta" connected-
  accounts stub was removed during final cleanup.
- **Redis is optional in the test/dev environment.** The app runs correctly
  without it; start a local Redis (`docker run -d -p 6379:6379 redis:7-alpine`)
  to enable caching and silence the non-fatal connection logs.
- **Search `set` filter matches on set NAME.** Options are derived from the
  current result set. A dedicated sets endpoint would make the full set list
  available independent of the current query.

---

_Generated at project handoff. Verify anytime with `npm run verify`._
