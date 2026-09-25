# AGENTS.md — AI Context for the Dojo TCG Collection PWA

> **Read this first, every task.** This file gives you the working context for the
> codebase. Deep detail lives in the `docs/` folder — follow the index at the bottom
> when a task touches a specific layer.

**When you finish a task that changes routes, services, schema, or pages, update the
relevant `docs/` file in the same commit.** Stale docs are worse than no docs.

---

## 1. What this app is

**Dojo** — a phone-first Progressive Web App for tracking a trading-card-game
collection (Pokémon + One Piece). Users search a card catalog, add cards to their
portfolio, manage named collections, track a Buy/Sell/Trade want list, view price
history, scan physical cards via camera OCR, and compare against live eBay listings.
Admins get an internal panel (users, card DB, audit logs). Real email/password +
Google OAuth auth throughout.

## 2. Tech stack (exact versions — `package.json`)

| Layer | Tech |
|---|---|
| Framework | Next.js 15 (App Router), React 19, TypeScript 5 |
| Styling | Tailwind CSS 4 via CSS variables (`--color-dojo-*` in `src/app/globals.css`); most components use inline styles + `.dojo-*` primitive classes, NOT utility classes (admin panel is the exception) |
| DB / ORM | PostgreSQL (Supabase remote) + Prisma 6 (`prisma/schema.prisma`) |
| Auth | Better Auth 1.6 (`src/lib/auth.ts` server / `src/lib/auth-client.ts` client) |
| Cache | Redis via ioredis — **cache only, never source of truth, fully optional** |
| Client data | TanStack Query v5 (query defaults in `src/app/providers.tsx`) |
| Validation | Zod 3 at every boundary (`src/lib/validators/` + inline schemas in routes) |
| OCR | Google Cloud Vision (server) with tesseract.js (on-device fallback) |
| Tests | Vitest (unit + integration), Playwright (e2e, port 3001 against a standalone production build) |
| Deploy | Vercel (cron + preview URLs) and/or Docker standalone (`output: "standalone"`) |

## 3. Commands

```bash
npm run dev                # next dev (port 3000)
npm run build              # prisma generate && next build
npm run build:standalone   # build + copy static assets (what e2e + Docker run)
npm run lint               # eslint
npm run type-check         # tsc --noEmit
npm run seed               # tsx prisma/seed-test.ts (test data)
npm run db:seed            # tsx prisma/seed.ts
npm run db:push            # prisma db push
npm run db:migrate         # prisma migrate dev
npm run test:unit          # vitest run tests/unit src
npm run test:integration   # vitest run tests/integration
npm run test:e2e           # playwright test (boots standalone build on :3001)
npm run test:chart-accuracy # tsx scripts/compare-chart-accuracy.ts (±10% gate)
npm run verify             # lint → unit → integration → chart-accuracy → e2e (THE gate)
```

**Run `npm run verify` before claiming any work done.** If you only touched one
layer, at minimum run `lint` + `type-check` + the matching test scope. E2E needs
a reachable `DATABASE_URL` (remote Supabase) and runs against a production build.

## 4. Directory layout (30-second orientation)

```
src/
  app/
    (auth)/          # login, signup, forgot/reset password, OTP stubs → /login, /signup, …
    (dashboard)/     # shell: header + bottom nav → /dashboard, /search, /portfolio, /you, /wantlist, /scanner, /collection/add
    (admin)/         # admin panel → /admin, /admin/users, /admin/cards, …
    (onboarding)/    # /profile
    api/             # 22 route files — see docs/API_REFERENCE.md
    layout.tsx, page.tsx (/ → redirects /login), providers.tsx (TanStack), globals.css (design tokens)
  components/        # shared: CardImage, CardDetailsPopup, Toast, WantList, NotificationsPanel, …
  lib/
    auth.ts          # Better Auth server config — NEVER import from client code
    auth-client.ts   # Better Auth React client — NEVER import from server code
    db/index.ts      # Prisma singleton
    redis.ts         # ioredis lazy singleton + RedisKeys registry (all keys + TTLs)
    services/        # business logic (card search, sync, eBay, recognition, …)
    utils/           # pure domain logic + server helpers (auth-guard, audit-log, …)
    validators/      # Zod schemas
    hooks/           # useWantToBuy
  middleware.ts      # Edge cookie-presence guard for /dashboard/* and /admin/* ONLY
prisma/schema.prisma # 13 models — see docs/ARCHITECTURE.md §Data model
scripts/             # one-off backfills, create-admin, snapshot jobs, e2e build helper
tests/               # unit/ + integration/ (Vitest, mocked DB/network)
e2e/                 # Playwright specs + auth.setup.ts (storageState session)
docs/                # CODE_MAP.md, ARCHITECTURE.md, API_REFERENCE.md ← read for depth
```

Route groups `(auth)`, `(dashboard)`, etc. are folder-only — they do NOT appear in URLs.

## 5. Non-negotiable rules (violating these breaks the design)

1. **Redis is optional.** Every Redis read/write is wrapped in try/catch and falls
   through to live data. Never let a cache failure fail a request. Never store
   anything in Redis that isn't reconstructable from Postgres.
2. **Never fabricate data.** No mock adapters, no invented prices. If a real source
   has no value → `null` → UI renders "—". (The mock-onepiece adapter was deleted
   on purpose. Reference/stub data must be honestly labeled, e.g. population
   `source: "reference"`.)
3. **Two card ids exist — never confuse them.** `Card.id` (internal cuid, React
   keys / detail links / admin PATCH) vs `Card.externalId` (catalog id like
   `base1-4` / `OP01-064` — search results, want-list `cardId`, history, reprice,
   add-to-collection). Trending returns BOTH (`id` + `externalId`).
4. **Zod at every boundary.** External API payloads, Redis-cached payloads (re-parse
   on read), and request bodies all pass through Zod. A source with 0 valid cards
   throws `NoResultsError` so the fallback chain advances without tripping the
   circuit breaker.
5. **Ownership by query scoping.** User-scoped mutations always use
   `where: { id, userId }` — a foreign id throws Prisma P2025 → 404, identical to
   nonexistent (no id-enumeration leak).
6. **Server/client module discipline.** `src/lib/auth.ts`, `card-image.server.ts`,
   and anything reading secrets are server-only. `auth-client.ts`, hooks, and
   `card-image.ts` are client-safe. Vision OCR key NEVER reaches the browser.
7. **Graceful degradation on public card/eBay routes.** They return HTTP 200 with
   empty payloads / `{ fallback: true }` instead of 5xx so the UI renders fallback
   states. Authed CRUD routes may return real 4xx/5xx.
8. **Auth guard idiom.** API routes: `const guard = await requireAuth(req)`
   (or `requireAdmin`); `if (guard.unauthorized) return guard.unauthorized`.
   Server components: `getServerSessionOrRedirect()`. Middleware is UX-only
   (cookie presence, Edge runtime can't hit Prisma) — every data endpoint
   re-validates.
9. **Ownership-scoped `addedAt` ordering:** bulk adds stamp strictly-decreasing
   timestamps via `assignBulkAddOrder` so the batch lands at the list front in
   selection order. Preserve this when touching add flows.
10. **Design tokens only.** Colors come from `--color-dojo-*` CSS variables in
    `globals.css`; square corners everywhere (radius 0 by design); `ArrowRight.tsx`
    is THE canonical CTA arrow (never inline a copy).
11. **Pure, deterministic domain logic** lives in `src/lib/utils/*.ts` and is
    unit-tested in isolation. Services own side effects; routes stay thin.
12. **Offset pagination** (`skip: offset` + `nextCursor: number`) for
    trending/search — composes with any sort order without duplicates. Don't
    "fix" it to keyset pagination casually.
13. **One Piece images** go through the same-origin proxy
    `/api/one-piece-img/[cardId]` (Bandai CDN blocks cross-origin via CORP).
    Use `onePieceImageChain()` for the fallback chain; never hot-link Bandai URLs
    from the browser.
14. **Comments/doc-chains are load-bearing** in this codebase (they encode WHY:
    eBay sold-listings reality, sync ordering, cookie/Edge constraints). Don't
    strip them when editing.

## 6. Intentional stubs — do NOT "fix" without asking

| Stub | Status |
|---|---|
| NotificationsPanel | UI-only empty state; future `GET /api/notifications` is a data-only change |
| Population report | Deterministic REFERENCE data, `source: "reference"`; `fetchPsaPopulation()` is the seam for a real API |
| Dashboard chart data | Synthetic shapes (deterministic PRNG); real `PricingHistory` exists only for 10 harness cards |
| Chart accuracy gate | Validates against a MOCKED Collectr reference in `scripts/compare-chart-accuracy.ts` |
| Graded metadata | Stored in `UserCollection.condition` ("PSA 10") + `Card.rarity`; dedicated grade columns are the planned migration |
| `/admin/transactions` | Mock ledger mixing real users + synthetic rows, clearly banner-labeled |
| `/profile` onboarding | Not persisted (localStorage flag only) |
| `PATCH /api/users/me` | 501 stub |
| OTP/phone auth | Plugin disabled for MVP (no SMS provider); `/otp`, `/verify-otp` redirect to `/profile` |
| "Sellers on the Floor" | ACTIVE eBay listings, not sold history (Browse API has no sold filter; Marketplace Insights is the upgrade path) |
| `FindOnEbayLink.tsx` | Orphaned on purpose (client wanted users kept in-app); kept for future use |
| Redis in dev | App runs fine WITHOUT Redis; non-fatal `[Redis] … falling through` logs are expected |
| Card `set` filter | Matches set NAME (not id) — known limitation |
| `activeFloorListings` stat | Explicit 0 stub until a listings table exists |

## 7. Testing map

- **`tests/unit/`** (Vitest, jsdom): pure utils — card-price, card-image,
  card-sort, graded-price, collection-aggregation, card-recognition, ebay-query.
- **`tests/integration/`** (Vitest, mocked Prisma/fetch — no live DB/network):
  collections, compare-collections, contact-support, psa-price, pokemon-price,
  bulk-add-order, golden graded prices (`tests/fixtures/golden_prices.json`).
- **`e2e/`** (Playwright): runs a standalone production build on **port 3001**
  (must match `BETTER_AUTH_URL`). Projects: `setup` (provision real session →
  storageState), `chromium` (unauth redirect), `google` (mocked OAuth),
  `authed` (session-backed features), `camera` (fake media device for scanner).
  Visual regression gated behind `VISUAL=1`.
- **Feature tests are TDD-pinned** — most features trace to an F-number (F-02 auth,
  F-04 show-more, F-05 debounce, F-06 set filters, F-07 want list, F-08 popup,
  F-09 chart, F-10 collections, F-11 aggregation, F-14 scanner, F-15 bulk order,
  F-16 eBay, F-17 PSA, F-18 pricing, F-19 graded add, F-21 support, F-22 compare).
  When changing behavior, change the test FIRST.

## 8. Key cross-cutting references (memorize these)

- **Redis keys + TTLs**: registry in `src/lib/redis.ts` (`RedisKeys`). Search 24h,
  eBay search 24h, eBay sold 1h, eBay app-token 7000s, card price 6h, trending 120s,
  circuit breakers 600s.
- **TanStack Query keys**: `["collection"]`, `["portfolio-collection"]`,
  `["want-list", "all"|"BUY"|"SELL"|"TRADE"]`, `["collections"]`,
  `["trending-cards", game, sort]` (infinite), `["card-search", …]`,
  `["card-history", id]`, `["population", id]`, `["ebay-sold", …]`. Add-to-collection
  invalidates `["collection"]` + `["portfolio-collection"]`; want-list mutations
  invalidate the whole `["want-list"]` family. Full table: docs/ARCHITECTURE.md.
- **External APIs**: pokemontcg.io, tcgdex, scrydex (Pokémon chain); apitcg,
  cardmarket (One Piece chain); eBay Browse API (sandbox default!); PSA public
  cert API; Google Vision; TCG Collector + Cardmarket (clean One Piece images).
  Env vars table: docs/ARCHITECTURE.md §Environment.
- **Daily sync**: `GET /api/cron/sync-cards` (Vercel cron 02:00 UTC,
  `CRON_SECRET`-guarded) → `runCardSync()` — max 10 stale sets/run, 7-day staleness,
  250s wall budget, fetch-before-upsert so failures retry next run.

## 9. Doc index (read the one matching your task)

| Doc | Read when… |
|---|---|
| `docs/CODE_MAP.md` | You need to find WHERE anything lives — every file, route, export, and its consumers. Start here for unfamiliar tasks. |
| `docs/ARCHITECTURE.md` | You're changing data flows, adding endpoints/services, touching caching, auth, external APIs, the sync engine, or the schema. |
| `docs/API_REFERENCE.md` | You're adding/modifying API routes or need exact request/response contracts. |
| `HANDOFF.md` | Feature-completion status + test counts at handoff time (historical). |
| `SETUP.md` | Local environment setup questions. |
| `REQUIREMENTS.md` / `.reference/` / `dojo-design/` | Product requirements and design prototypes. |
| `ANIMATION_SPECS.md` | Motion/animation work. |

## 10. Working conventions for code changes

- TypeScript strict; prefer the existing inline-style + `.dojo-*` class pattern
  for dashboard/auth UI (Tailwind utilities are fine in the admin panel and for
  layout math).
- New external API integrations: adapter in `card.service.ts` style — fetch →
  map → `NormalizedCardSchema.safeParse` per card → drop invalid → empty valid set
  = `NoResultsError`.
- New mutations: use `credentials: "include"` fetch, invalidate the affected query
  family, keep optimistic pattern (`useWantToBuy` is the reference implementation).
- New pages in `(dashboard)`: the shell owns header/bottom-nav; use
  `<HeaderLeftSlot>` to inject a header control; scanner-style pages get full-bleed
  mode by pathname convention.
- Never commit `.env` (real secrets live there; `.env.example` is the template).
- Windows host: use PowerShell-safe commands; the repo path contains a space
  (`pokemon TCG`) — always quote paths.
