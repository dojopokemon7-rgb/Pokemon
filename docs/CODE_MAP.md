# CODE_MAP.md — Every file, route, export, and consumer

> The authoritative "where does anything live" reference. Organized by directory.
> Route-group folders in parentheses — `(auth)`, `(dashboard)`, `(admin)`,
> `(onboarding)` — do NOT appear in URLs.
>
> **Type key:** `S` = server component/module, `C` = client (`"use client"`), `P` = pure/deterministic, `—` = n/a.
>
> Last verified against commit `d6dcced` + working tree.

---

## 1. Root configuration files

| File | Purpose |
|---|---|
| `package.json` | Scripts: `dev`, `build` (prisma generate && next build), `build:standalone` (+ `scripts/assemble-standalone.mjs`), `lint`, `type-check`, `seed`, `db:*`, `test:unit/integration/e2e/chart-accuracy`, `verify` (the full gate) |
| `next.config.ts` | `output: "standalone"` (Docker/e2e); Supabase storage image `remotePatterns`; `serverExternalPackages: ["@prisma/client","ioredis"]`; PWA headers for `/sw.js` (Service-Worker-Allowed: /, no-cache) + `/manifest.json` |
| `tsconfig.json` | Strict TS; `@/*` → `./src/*` path alias |
| `eslint.config.mjs` | ESLint 9 flat config (`eslint-config-next`) |
| `vitest.config.ts` | jsdom, globals, setup `tests/setup.ts`, includes `tests/**` + colocated `src/**/*.test.*`, excludes `e2e/**` |
| `playwright.config.ts` | Port **3001** (must match `BETTER_AUTH_URL`); 5 projects (setup/chromium/google/authed/camera); webServer = `npm run build:standalone && node .next/standalone/server.js` with `PORT=3001` |
| `vercel.json` | Cron: `/api/cron/sync-cards` at `0 2 * * *` (daily 02:00 UTC) |
| `Dockerfile` / `docker-compose.yml` / `Caddyfile` | Multi-stage standalone Docker deploy; compose adds Redis service; `REDIS_URL=redis://redis:6379` in compose |
| `.env.example` | Full env template with per-var instructions (see ARCHITECTURE.md §Environment) |
| `postcss.config.mjs` | Tailwind 4 via `@tailwindcss/postcss` |
| `prisma/schema.prisma` | 13 models — see §11 below + ARCHITECTURE.md §Data model |

---

## 2. `src/middleware.ts` — Edge route guard

- **Runs ONLY on** `/dashboard/:path*` and `/admin/:path*` (matcher). Does NOT intercept `/api/*`.
- Cookie **presence** check only (`better-auth.session_token` / `__Secure-` variant) — Edge runtime can't hit Prisma, so it's UX-redirect only; every data endpoint re-validates.
- Unauthenticated → `/login?callbackUrl=<original path>`.
- Exposes constants `SESSION_COOKIE_NAME`, `SECURE_SESSION_COOKIE_NAME`, `LOGIN_PATH`, `DEFAULT_AUTHENTICATED_PATH` — update if `advanced.cookiePrefix` changes in `auth.ts`.

---

## 3. `src/app` core files

| File | Type | Purpose |
|---|---|---|
| `layout.tsx` | S | Root HTML. Fonts: Ubuntu Sans (body), Marcellus (serif display) as `--font-ubuntu-sans` / `--font-marcellus`. Metadata (title template `%s · Dojo`, manifest, OG, iOS web-app), viewport themeColor `#0D0D0D`, `viewportFit: cover`. Wraps children in `<Providers>` + mounts `<PwaRegistrar />`. `suppressHydrationWarning` on html/body. |
| `page.tsx` | S | `/` → `redirect("/login")`. The landing page IS the sign-in screen. |
| `providers.tsx` | C | The ONLY global client provider: `QueryClientProvider`. Defaults (memorize): `staleTime: 5min`, `gcTime: 10min`, `retry: 1`, `refetchOnWindowFocus: false`, `refetchOnReconnect: false`. Mutations push updates via `invalidateQueries`. |
| `globals.css` | — | Design system: `--color-dojo-*` tokens (gold `#E9B43B`, btn-gold `#FFD52E`, jade `#0AC27E`, vermilion `#EF4423`, app `#0D0D0D`, card `#121212`, raised `#161616`, overlay `#1E1E1E`, ink/body/faint text alphas, stroke/divider alphas), declared in `:root` AND `@theme`. Primitive classes `.dojo-*`: `dojo-input`, `dojo-label`, `dojo-btn(-primary/-outline/-outline-sm)`, `dojo-divider`, `dojo-back`, `dojo-link`, `dojo-select(-trigger/-menu)`, `dojo-seg(-tight)`, `dojo-statgrid`, `dojo-tag(.acc)`, `dojo-card-row/-grid/-tile`, `dojo-scrim/-sheet`, `dojo-scroll-hidden`, `dojo-heading`, `dojo-error`, `dojo-avatar-placeholder`, `dojo-otp-box`, `dojo-popup-in`, `dojo-pulse`, `dojo-fade-up`, `dojo-scan`, `dojo-shake`, `dojo-mark-animated`, `dojo-count-up`, tab-glow classes. `html,body{height:100%;overflow:hidden}` — each layout owns its scroll region. `border-radius: 0` everywhere BY DESIGN. `prefers-reduced-motion` respected. |

---

## 4. `src/app/(auth)/` — auth pages (URLs have NO prefix)

All client components. Layout (`layout.tsx`, S): own-scroll 390px-max centered column (html/body scroll is globally locked).

| File | Route | What it does |
|---|---|---|
| `login/page.tsx` | `/login` | Screen 01. `authClient.signIn.email` / `.signIn.social({provider:"google"})` (manual `window.location.href` handoff to the returned url). Post-login fetches `GET /api/users/me` → routes admins to `/admin`, users to `/dashboard`. URL banners: `?verified=true`, `?registered=true`, `?reset=true`, `?error=…`. Animated DojoMark SVG. `useTimeoutToast` for hung requests. |
| `signup/page.tsx` | `/signup` | Screen 02. Live password validation (8+ chars, ≥1 number), match feedback, `authClient.signUp.email` → `/profile`. |
| `otp/page.tsx` | `/otp` | **MVP stub** — redirects to `/profile` (phone auth disabled). |
| `verify-otp/page.tsx` | `/verify-otp` | **MVP stub** — redirects to `/profile`. |
| `forgot-password/page.tsx` | `/forgot-password` | `authClient.requestPasswordReset`; enumeration-safe same-message confirmation. Reset link is console-logged in dev (no email provider). |
| `reset-password/page.tsx` | `/reset-password` | Reads `?token`; `authClient.resetPassword` → `/login?reset=true`. Missing/expired token → inline error + re-request link. |

---

## 5. `src/app/(dashboard)/` — the app shell + main pages

### 5.1 Shell architecture

| File | Type | Purpose |
|---|---|---|
| `layout.tsx` | S | `getServerSession()` → redirect `/login` if none; **bounces `isAdmin` users to `/admin`** (from cookie-cached `additionalFields`). Renders `<DashboardClientShell>{children}`. |
| `dashboard-client-shell.tsx` | C | Two modes via `usePathname()`: **scanner mode** (`/scanner*`) = full-bleed, no chrome; **normal mode** = sticky header (left slot + search-icon Link → `/search` + `<NotificationsPanel/>`) + scrollable `<main>` + fixed 4-tab bottom nav (Home `/dashboard` · Portfolio `/portfolio` · Explore → `/search` · You `/you`). Hover/focus prefetch of destination query data (`["portfolio-collection"]`, `["collection"]`). |
| `header-slot.tsx` | C | `HeaderSlotProvider` + `useHeaderLeft()` + `<HeaderLeftSlot>` — pages inject a header control (DashboardClient uses it for the collection-selector pill). Single consumer at a time; auto-clears on unmount. |

### 5.2 Pages

| File | Route | Type | Notes |
|---|---|---|---|
| `dashboard/page.tsx` | `/dashboard` | S | Screens 09+10. Server-side `Promise.all`: owned cards (`userCollection.findMany`, narrow select) + named collections → passes as `initialData` (SSR-first, no loading flash) to `<DashboardClient>`. |
| `dashboard/loading.tsx` | `/dashboard` | S | Pulsing skeleton (`dojo-pulse`). |
| `dashboard/_components/DashboardClient.tsx` | — | C | ~1k lines. Queries: `["collection"]` (initialData from SSR), `["want-list","all"]`. Tabs: Most Valuable / Collections / Gainers / Losers / Want to Buy / Sell / Trade. F-11 multi-select collection filter (`HeaderLeftSlot` pill, `"__uncat__"` sentinel). F-08 `<CardDetailsPopup>` on card rows. Chart = `MiniAreaChart` (inline SVG, deterministic mock series per range; last point pinned to real value). Gainers/Losers = real cards, mock deltas. Deep links: `/you`, `/wantlist`, `/portfolio`. Empty state → `/scanner` + `/search` CTAs. |
| `explore/page.tsx` | `/explore` | S | Redirect alias to `/search` preserving query string. |
| `search/page.tsx` | `/search` | C | Screens 06+07. **2k lines — the search experience.** URL-driven state: `q, game, set, rarity, graded, minPrice, maxPrice` via `router.replace` (F-06); sort is memory-only. No `q` → trending via `useInfiniteQuery(["trending-cards",game,sort])` + SHOW MORE (F-04); with `q` → `useQuery(["card-search",…])`. 350ms debounced SearchBar (F-05) + autocomplete (`["search-suggest"]`) + localStorage recents (`dojo-recent-searches`). Background `POST /api/cards/reprice` for ≤20 unpriced visible Pokémon tiles. AddCardSheet bottom sheet = graded add (F-19, `data-testid="graded-add-modal"`): RAW/PSA grader, condition/grade listbox, collection dropdown, qty, paid price. Star toggle via `useWantToBuy`. Tile → `/search/[id]`. Multi-select → `/search/multi`. |
| `search/loading.tsx` | `/search` | S | Skeleton. |
| `search/[id]/page.tsx` | `/search/[id]` | C | Card detail. **No get-by-id API** — identity/price/image threaded via query params (`name,game,set,img,price,number,rarity`; game inferred via Bandai-code regex). Queries: `["card-history",id]` (real `PricingHistory` → F-09 tooltip), `["population",id]` (24h stale), `["ebay-sold",…]` (1h stale → "Sellers on the Floor" — ACTIVE listings, honest label). Add mutation (Ungraded Foil + graded rows w/ AddQtyRow steppers). `DojoChart` multi-series SVG. Hero art flip, share menu, report menu. |
| `search/multi/page.tsx` | `/search/multi` | C | Screen 08. Multi-select list (Select All/Deselect), fixed bottom bar (count + total value) → `setPendingCollectionCards()` (sessionStorage `dojo:pending-collection-cards`) → `/collection/add`. Query `["card-multi",game,q]`. |
| `scanner/page.tsx` | `/scanner` | C | F-14. Full-bleed (shell convention by pathname). getUserMedia rear-pref; crop/2×/grayscale/contrast preprocessing; glare/darkness warning; **Vision-first** `POST /api/cards/recognize {image}` → server `ocrSource:"unavailable"` → on-device tesseract.js → re-POST `{text, source:"tesseract"}`. Confidence gate 0.4 → top-5 confirm phase → add + `PATCH /api/cards/recognize {feedbackId, pickedCardId}` (tuning loop). Phases: scan/recognizing/confirm/not-recognized (manual search fallback). Plain fetch, no TanStack. |
| `collection/add/page.tsx` | `/collection/add` | C | Reads pending cards (read-without-clear for Strict Mode), `POST /api/users/me/collection {cards}` (≤50), success/partial-failure states, invalidates `["collection"]`+`["portfolio-collection"]`. |
| `wantlist/page.tsx` | `/wantlist` | C | Thin wrapper rendering `<WantList heading/>`. |
| `portfolio/page.tsx` | `/portfolio` | C | Screen 06. `["portfolio-collection"]` + `["collections"]` + conditional `["want-list","BUY"]`. Automatic card deduplication / quantity consolidation (`consolidatedItems`), Collectr-style Mark as Sold modal with custom selling price & quantity, revert sold, active/sold/all tabs, paid/realized/unrealized metrics. Grid/list view, select mode + bulk delete (`Promise.allSettled` of `DELETE /api/users/me/collection/{id}`). Correct externalId detail navigation. |
| `portfolio/loading.tsx` | `/portfolio` | S | Skeleton. |
| `you/page.tsx` | `/you` | C | Screen 08 account. `useSession()` (Better Auth) for identity; stats: Cards (Σqty), Sealed (hard 0 stub), Graded (condition regex), Total paid, Total value. `<CollectionsSection/>` (F-10 CRUD), linked accounts (`authClient.listAccounts`/`linkSocial`), `<ContactSupport/>` (F-21), logout. |
| `you/_components/CollectionsSection.tsx` | — | C | F-10: create / rename / privacy pill (`PATCH {isPrivate}`) / delete w/ double-confirm. `["collections"]` query; plain fetch + invalidate. |
| `you/_components/ContactSupport.tsx` | — | C | F-21: expanding form → `POST /api/support`. |

---

## 6. `src/app/(onboarding)/` — `/profile`

| File | Type | Notes |
|---|---|---|
| `layout.tsx` | S | Session gate (same 390px own-scroll shell as auth). |
| `profile/page.tsx` | C | Screen 05. Avatar upload preview (FileReader, 2MB cap), Location dropdown (15 cities), Currency, Public/Private segmented control. **Not persisted** — sets `localStorage["profile_completed_{userId}"]` then hard-navigates to `/search` (client decision: land on card-picking). Auto-skips to `/dashboard` if flag exists. |

---

## 7. `src/app/(admin)/admin/` — admin panel (Tailwind utilities allowed here)

| File | Route | Type | Notes |
|---|---|---|---|
| `layout.tsx` | `/admin/*` | S | Two-tier enforcement: middleware cookie check + **this layout re-validates `isAdmin` from DB-backed session, redirect non-admins to `/dashboard` (fail-closed)**. `isAdmin` is cookie-cached ~5 min. Fixed `<AdminSidebar/>` (240px) + scrolling main. |
| `page.tsx` | `/admin` | S | Overview. `getPlatformStats()` + `getRecentPlatformActivity(10)` (admin-metrics service). Financial cards (Total Platform Value, Total Invested), activity cards (Users / Cards Tracked / **Active Floor Listings = explicit 0 stub**), activity feed linking → `/admin/users/{id}`. |
| `_components/AdminSidebar.tsx` | — | C | Nav: Overview / Users / Card Database / Transactions / Audit Logs + "Back to App". `usePathname()` active state. |
| `cards/page.tsx` | `/admin/cards` | S | `prisma.card.findMany` (take 50, `?q=` filters name OR set name). Game column inferred from set `externalId` prefix. Client islands below. |
| `cards/_components/CardSearchInput.tsx` | — | C | 250ms debounced `router.replace(?q=)` inside `useTransition` — URL is source of truth for the server-component filter. |
| `cards/_components/EditCardButton.tsx` | — | C | Modal editing Market Price + Image URL → `useMutation` `PATCH /api/admin/cards/{id}` → `router.refresh()`. |
| `users/page.tsx` | `/admin/users` | S | User list + `getPortfolioValuesByUser(ids)` (one grouped SQL — avoids N+1). |
| `users/[id]/page.tsx` | `/admin/users/[id]` | S | `getUserFinancials(id)` (value/invested/P&L) + portfolio table. "Suspend Account" is a disabled placeholder. |
| `transactions/page.tsx` | `/admin/transactions` | S | **Mock ledger** (real users + synthetic rows), gold "Demo data" banner. |
| `audit-logs/page.tsx` | `/admin/audit-logs` | S | Real `AuditLog` rows (take 100) written by `writeAuditLog`; `ACTION_LABELS` map + change summaries. |

---

## 8. `src/app/api/` — 22 route files

Full contracts in **API_REFERENCE.md**. Quick index:

| Route file | Methods | Auth | Service |
|---|---|---|---|
| `auth/[...all]/route.ts` | GET, POST | public (IS the auth handler) | `toNextJsHandler(auth)` — Better Auth |
| `cards/[id]/ebay-sold/route.ts` | GET | public | `searchEbaySellerListings` (Redis 1h) |
| `cards/[id]/history/route.ts` | GET | public | Prisma `PricingHistory` |
| `cards/[id]/population/route.ts` | GET | public | `getPopulationReport` |
| `cards/recognize/route.ts` | POST, PATCH | optional session | Vision OCR → `recognize()` + `ScanFeedback` |
| `cards/reprice/route.ts` | POST | public | `pickPokemonMarketPrice` + Redis 6h |
| `cards/search/route.ts` | GET | public (`ENFORCE_AUTH=false`) | Prisma local search (`SearchQuerySchema`) |
| `cards/trending/route.ts` | GET | public | Prisma groupBy adds + offset paging (Redis 120s) |
| `collections/route.ts` | GET, POST | `requireAuth` | `collection.service` |
| `collections/[id]/route.ts` | PATCH, DELETE | `requireAuth` | `collection.service` |
| `cron/sync-cards/route.ts` | GET, POST | `CRON_SECRET` (timingSafeEqual) | `runCardSync()` |
| `ebay/marketplace-account-deletion/route.ts` | GET, POST | public (eBay compliance) | challenge SHA-256 / deletion notices |
| `ebay/search/route.ts` | GET | public | `searchEbayListings` (Redis 24h) |
| `health/route.ts` | GET | public | `pingRedis()` → 503 degraded |
| `one-piece-img/[cardId]/route.ts` | GET | public | Bandai CDN same-origin proxy (regex whitelist) |
| `support/route.ts` | POST | `requireAuth` | `submitSupportTicket` |
| `users/me/route.ts` | GET, PATCH | `requireAuth` | GET real profile; PATCH = 501 stub |
| `users/me/collection/route.ts` | GET, POST | `requireAuth` | POST = bulk add (`AddCollectionRequestSchema`, F-15 ordering, deduplication by quantity increment) |
| `users/me/collection/[id]/route.ts` | PATCH, DELETE | `requireAuth` | PATCH = mark card as sold/unsold (`isSold`, `soldPrice`, `soldQuantity`); DELETE = ownership-scoped `deleteMany` |
| `want-list/route.ts` | GET, POST | `requireAuth` | `want-list.service` |
| `want-list/[id]/route.ts` | PATCH, DELETE | `requireAuth` | `want-list.service` |
| `admin/cards/[id]/route.ts` | PATCH | `requireAdmin` | Prisma + `writeAuditLog` (action `card.update`) |

---

## 9. `src/components/` — shared components

| File | Type | Purpose / Consumers |
|---|---|---|
| `ArrowRight.tsx` | S-safe | THE canonical CTA arrow SVG (24×10, `currentColor`). Never inline a copy. Used by auth pages, profile, FindOnEbayLink. |
| `CardImage.tsx` | C | Single source of truth for card thumbnails. 3-state fallback: `<img>` → `fallbackChain` advance on `onError` (keyed remount) → gold-initials placeholder (`cardInitials()`). Plain `<img>` (cross-origin CDNs). Also exports `NoPriceText`. |
| `CardDetailsPopup.tsx` | C | F-08 modal (dashboard rows only; Explore navigates instead). Dialog a11y (focus trap-lite, Escape, backdrop). ADD TO COLLECTION (parent callback → `/search`) + self-contained optimistic WANT TO BUY. `dojo-popup-in`. |
| `FindOnEbayLink.tsx` | C | **Orphaned on purpose** (keep users in-app); `buildEbaySearchUrl` deep link, `<button>` + `window.open` (avoids nested anchors). Kept for future use. |
| `NotificationsPanel.tsx` | C | Header bell + dropdown. **UI-only empty state**; `notifications` prop + list markup ready for a future `GET /api/notifications`. |
| `PwaRegistrar.tsx` | C | Registers `/sw.js` (scope /) after `window.load`. Renders null. |
| `Toast.tsx` | C | Dumb fixed bottom-center toast (`message`, `duration` 2600ms, `tone: neutral\|error`) + **`useTimeoutToast(pending, msg, ms=3000)`** "still working…" helper. Parent owns message state. |
| `WantList.tsx` | C | F-07 reusable body: BUY/SELL/TRADE tabs (`["want-list", active]`), per-item Move menu (`PATCH {intent}`) + Remove (`DELETE`); invalidates whole `["want-list"]` family. Used by `/wantlist`. |

---

## 10. `src/lib/` — data, services, utils, validators, hooks

### 10.1 Core

| File | Type | Exports / notes |
|---|---|---|
| `db/index.ts` | S | `prisma` — globalThis-surviving singleton (hot-reload safe). `PRISMA_LOG_QUERY=1` enables query logging; default errors-only. |
| `redis.ts` | S | `redis` — **lazy Proxy** (never constructs at import/build time; `REDIS_URL` read at first method call), offline-queue, retry backoff. `pingRedis()`. **`RedisKeys`** registry: `cardSearch(game,q)` 24h, `ebayAppToken` 7000s, `ebaySearch(key)` 24h, `ebaySold(key)` 1h, `cardPrice(id)` 6h, `otp*` (disabled). Trending key `card:trending:*` built inline in the route (TTL 120s). Circuit-breaker keys live in fallback-executor (600s). |
| `auth.ts` | S | Better Auth server config. **NEVER import from client.** Prisma adapter; `user.additionalFields.isAdmin` (`input:false` — server-side toggles only); email+password (no email verification, 8–128 pw); Google social (`test` fallbacks in dev/CI); phone/OTP plugin **disabled MVP**; `sendResetPassword` console-logs link in dev; session 7d expiry / 1h updateAge / 5min cookieCache; `trustedOrigins` = localhost:3000+3001, prod domain, `*.vercel.app` previews. Exports `Auth`, `Session` types. |
| `auth-client.ts` | C | `authClient` via `better-auth/react`; baseURL = `window.location.origin` at runtime (avoids preview-URL mismatch). Re-exports `signIn, signOut, signUp, useSession, getSession`. **NEVER import from server code.** |

### 10.2 Services (`src/lib/services/`)

| File | Key exports | Notes |
|---|---|---|
| `card.service.ts` | `searchCards(game, query)`, `searchPokemonCards`, `searchOnePieceCards`, re-export Normalized* types | Cache-first (24h, Zod re-parsed on read) → fallback chain: Pokémon `pokemon-tcg → tcgdex → scrydex-pokemon`; One Piece `apitcg-onepiece → cardmarket-onepiece`. Per-card `NormalizedCardSchema.safeParse`, invalid dropped, 0-valid → `NoResultsError` (chain advances, breaker untouched). One Piece image URLs rewritten to `/api/one-piece-img/` proxy (`rewriteOnePieceImage`). **Mock adapter deleted on purpose.** |
| `ebay.service.ts` | `getEbayAccessToken()`, `buildEbayQuery(params)` (exported for tests), `searchEbayListings(params, limit=3)`, `searchEbaySellerListings(params, limit=4)`, `NormalizedEbayListing`, `EbaySellerListing` | Client-credentials OAuth → Redis token 7000s (200s safety margin). Browse API `item_summary/search`; Pokémon category 183454, One Piece null (Bandai code narrows). `buildEbayQuery`: Pokémon = all quoted phrases; One Piece = quoted name + loose Bandai code. `EBAY_API_URL` defaults **sandbox**. 429 handled explicitly. Service is cache-agnostic — routes own search/sold caching. Seller listings are **ACTIVE, not sold** (Browse API has no sold filter). |
| `sync-cards.service.ts` | `runCardSync()`, types `Game`, `SyncCardInput`, `SyncSetInput`, `SyncRunSummary` | Daily catalog sync. Sets from pokemontcg.io (`/v2/sets`, cards paginated 250/page) + apitcg (`/api/one-piece/sets`, products limit 500). `CardSet.externalId = "{game}-{sourceSetId}"`. **Fetch-before-upsert** (failure stays "missing", retries next run), 7-day staleness window, max 10 sets/run interleaved P/OP, 250s wall budget, upserts in chunks of 10. Per card: `tags = buildTags(...)`, `marketPrice = pickPokemonMarketPrice(...)` (One Piece: tcgplayer market), clean-OP-image resolution via `resolveOnePieceCleanImage` when licensed keys configured. |
| `card-recognition.service.ts` | `WEIGHTS {number:50, set:20, name:30}`, `MAX_SCORE`, `parseOcr()`, `scoreCards()`, `recognize()`, `normalizeNumber()`, types `ParsedOcr`, `CatalogCard`, `ScoredCandidate` | Pure scoring engine (F-14). Parse OCR → collector number (`N/M` + set-code `SV|OP|ST|EB|PRB` regexes), name lines (≥50% letters), then additive score: +50 number match, +20 set match, +30×name similarity (Levenshtein via `fuzzy-match`, 0.6 noise floor, sliding-window recovery). Confidence = score/100. Zero-score dropped. |
| `vision-ocr.service.ts` | `isVisionConfigured()`, `detectTextWithVision(base64)` | Google Vision TEXT_DETECTION. `null` = unavailable signal (no key/failure/empty) → client falls back to tesseract.js. **Key is server-only.** |
| `collection.service.ts` | `listCollections`, `createCollection`, `renameCollection`, `deleteCollection`, `updateCollectionSettings` | F-10 CRUD. All mutations scoped `where: { id, userId }` (P2025 → 404). Zod via `collection.validator`. |
| `want-list.service.ts` | `listWantList(userId, intent?)`, `addWantListItem` (idempotent upsert), `moveWantListItem`, `removeWantListItem` | F-07. **`cardId` = EXTERNAL id** (`base1-4`), not FK — cards can be wanted before catalog sync. List route batch-resolves display fields. |
| `pokemon-price.service.ts` | `fetchPokemonMarketPrice(externalId): Promise<CurrentPrice|null>` | Live pokemontcg.io single-card market price (TCGplayer variant scan). **Never throws** — all failures → null. Used by reprice route + `scripts/snapshot-pokemon-prices.ts` (daily `PricingHistory` snapshots, idempotent per UTC day). |
| `psa-price.service.ts` | `fetchPSACert(certNumber)`, `fetchPSAGradedPrice(input)` | PSA public cert API (verification only — no price guide). Bearer `PSA_API_KEY`; missing/placeholder key → null. Graded value via curated table (`graded-price.ts`, dynamic import to break module cycle). |
| `population.service.ts` | `getPopulationReport()`, `GRADE_LADDER` | **Deterministic REFERENCE data** (`source: "reference"`, PSA 983 / BGS 468). `fetchPsaPopulation()` = documented seam returning null today. |
| `support.service.ts` | `submitSupportTicket(input, {deliver?, userId?})` | F-21. Injectable `deliver` (default: persist `SupportTicket` row). Result-object `{ok, ticketId}\|{ok:false, error}` — never throws. |
| `admin-metrics.ts` | `getPlatformStats()`, `getRecentPlatformActivity(limit)`, `getUserFinancials(userId)`, `getPortfolioValuesByUser(userIds)` | Raw SQL for cross-relation sums; grouped `ANY(...)` query avoids N+1. `activeFloorListings` explicit 0 stub. Admin pages only. |

### 10.3 Utils (`src/lib/utils/`)

| File | Type | Exports / algorithm |
|---|---|---|
| `auth-guard.ts` | S | `requireAuth(req)`, `requireAdmin(req)` → discriminated union `{unauthorized}\|{session}` — the `if (guard.unauthorized) return guard.unauthorized` idiom. 401 / 403 JSON. |
| `get-server-session.ts` | S | `getServerSession()`, `getServerSessionOrRedirect(to="/login")` for RSC/Server Actions (NOT API routes). Next 15 `await headers()`. |
| `audit-log.ts` | S | `writeAuditLog({adminId, adminEmail, action, targetType, targetId?, details?, request?})` — non-fatal try/catch; IP from `x-forwarded-for`/`x-real-ip`. |
| `fallback-executor.ts` | S | `executeWithFallback(tasks)`, `NoResultsError`, `FallbackTask<T>`. Per-task 5s timeout; Redis circuit breaker: 3 failures → open 600s (`circuit_breaker:fail:{name}` counter + `circuit_breaker:{name}` flag). **Fail-open** — Redis outage = attempt anyway. |
| `bulk-add-order.ts` | P | `assignBulkAddOrder(cardIds, base?)` — F-15: strictly-decreasing `addedAt` (item i of n = base + (n−1−i) ms) so bulk adds land at list front in selection order. |
| `card-image.ts` | P (client-safe) | `isOnePieceCode(id)` (regex `OP|ST|EB|PRB\d{2}-\d{3}` + `P-\d{3}`), `onePieceImageUrl(id)` → `/api/one-piece-img/{CODE}`, `onePieceImageChain(id, stored?, storedHi?)` → deduped `[stored, storedHi, proxy]`. |
| `card-image.server.ts` | S | `resolveOnePieceCleanImage(code)` — clean (non-"SAMPLE"-watermark) OP image resolver: TCG Collector (Bearer `TCGCOLLECTOR_API_KEY`) → Cardmarket (`CARDMARKET_APP_TOKEN`) → null (keep existing, never blank). Never throws. |
| `card-price.ts` | P | `pickPokemonMarketPrice(card)` — first TCGplayer variant with finite market > 0; else Cardmarket `averageSellPrice → trendPrice → avg7 → avg30`; else null. Shared by sync + reprice + backfill. |
| `card-sort.ts` | P | `CardSortEnum` (`trending|market_desc|market_asc|name_asc|recent`), `CARD_SORT_LABELS`, `orderByForCardSort()` → Prisma orderBy (nulls-last price sorts). Shared by search + trending routes. |
| `card-tags.ts` | P | `buildTags({rarity, types, number, set})` — lowercase deduped keyword tags (types, rarity/number/set/series word tokens ≥2 chars). Same builder across seed + sync + backfill. |
| `collection-aggregation.ts` | P | `aggregateCollectionStats(items, selectedId)`, `ALL_COLLECTIONS` sentinel, types. Σ(marketPrice×qty), Σqty, synthetic 12-point chart series (last point pinned). F-11. |
| `compare-collections.ts` | P | `compareCollections(items, idA, idB)` (built on the aggregator so numbers can never disagree), `canCompare(n≥2)`, F-22 constants. |
| `format.ts` | P | `formatCurrency` ("—" for null/NaN), `formatDate`, `formatDateTime`, `formatRelative` (ladder: just now → minutes → … → years). Admin pages. |
| `fuzzy-match.ts` | P | `levenshtein(a,b)`, `similarity(a,b)` (normalized 0..1), `scoreCandidate(ocrText, name)` (max of whole/window/line similarities). F-14. |
| `graded-price.ts` | P | `getGradedPrice(name, set, grade, raw)`, `gradedPrice(raw, grade)`, `resolveGradedPrice(input)` (+`isStale` 7d / `isFallback` flags), `STALE_AFTER_MS`. Curated 20-entry `GRADED_PRICE_LOOKUP` (WOTC holos, modern chases, OP leaders) + `FALLBACK_MULTIPLIER {8:1.2, 9:1.5, 10:2.5}` — strictly increasing so grade hierarchy can never invert. F-17. |
| `pending-collection.ts` | C | sessionStorage handoff `dojo:pending-collection-cards`: `set/get/clearPendingCollectionCards` (get-without-clear for Strict Mode; `take…` deprecated). `PendingCollectionCard` mirrors `AddCardSchema` exactly. |
| `price-comparison.ts` | P | `evaluateDeal(market, ebay)` (`GOOD_DEAL_THRESHOLD` 10%), `lowestEbayPrice`, `averageEbayPrice`, `buildEbaySearchUrl(name, set?, code?, game?)` (eBay categories 183454/261186/2611). Deal Finder helpers. |

### 10.4 Validators (`src/lib/validators/`)

| File | Schemas |
|---|---|
| `card.validator.ts` | `NormalizedCardSchema` (`imageUrl` refine: `https?://` OR same-origin `/`), `NormalizedSearchResponseSchema`, `parseSearchResponse()` — the contract between adapters, routes, and Redis cache. |
| `collection.validator.ts` | `CollectionTypeEnum` (POKEMON/ONE_PIECE/MIXED), `CollectionNameSchema` (1–100), `CreateCollectionSchema` (defaults private/MIXED), `UpdateCollectionSettingsSchema`. |
| `support.validator.ts` | `ContactSupportSchema` (name ≤120, email, subject ≤160, message ≤5000). |
| `want-list.validator.ts` | `WantIntentEnum` (BUY/SELL/TRADE), `AddWantListSchema`, `MoveWantListSchema`. |

### 10.5 Hooks

| File | Purpose |
|---|---|
| `hooks/useWantToBuy.ts` | C hook. `["want-list","BUY"]` query → `rowByCard` map; `isWanted(externalId)`; `toggle({externalId, name})` → fires add/remove mutation and **returns the new state synchronously** (for instant toasts); `onSettled` invalidates the whole `["want-list"]` family. The reference optimistic-mutation implementation. Used by `/search` + `/search/[id]`. |

---

## 11. `prisma/` — 13 models

`User` (Better Auth + `isAdmin`, `phoneNumber*`), `Session`, `Account`, `Verification` (exact Better Auth field names — DO NOT rename), `CardSet` (`externalId` unique, `@@index([name])` for set filter), `Card` (`externalId` unique; `tags String[]` with GIN index for `has` search; `@@index([updatedAt])` for trending; `marketPrice`/`lastEbayPrice`/`lastPricedAt` snapshot), `Collection` (`@@unique([userId,name])`), `UserCollection` (`@@unique([userId,cardId,isFoil])`, `purchasePrice`, `collectionId` nullable SetNull, `addedAt`), `AuditLog`, `PricingHistory` (`@@index([cardId, recordedAt])`), `SupportTicket`, `WantListItem` (`cardId` = external id; `@@unique([userId,cardId,intent])`), `ScanFeedback` (OCR candidates + picked card = tuning ground truth). Enums: `CollectionType`, `TicketStatus`, `WantIntent`.

`prisma/seed.ts` (full seed) / `prisma/seed-test.ts` (`npm run seed` — test data) / `prisma/drafts/`, `prisma/sql/` (manual SQL scratch).

---

## 12. `scripts/` — operational scripts

| Script | Purpose |
|---|---|
| `compare-chart-accuracy.ts` | ±10% chart-accuracy gate vs MOCKED Collectr reference (10 harness cards). Read-only; exports `CARDS` + `monthly()` reused by the seed. |
| `create-admin.ts` | Bootstrap/promote admin via `auth.api.signUpEmail` (bcrypt-correct password) + `isAdmin:true`. Re-runnable. |
| `assemble-standalone.mjs` | Copies `.next/static` + `public` into `.next/standalone` (e2e + Docker server). |
| `backfill-tags.ts` | Idempotent `Card.tags` backfill via `buildTags` (only `tags: {isEmpty:true}`). |
| `backfill-prices.ts` | Whole-catalog price backfill (per-set bulk fetch, batches, PricingHistory anchor rows). |
| `backfill-images.ts` | Replaces watermarked OP images via `resolveOnePieceCleanImage` (no fabrication when unlicensed). |
| `snapshot-pokemon-prices.ts` | Daily `PricingHistory` snapshot job (idempotent per UTC day, source `pokemon-tcg-api`). |
| `seed-pricing-history.ts` | F-18 seed: PricingHistory within ±9% of reference (mulberry32 jitter). |
| `cleanup-unknown-set.mjs` | Dry-run-by-default dedupe of `pokemon-unknown-set` orphan duplicates. |
| `vision-live-check.mjs` | Live Google Vision key sanity check. |

---

## 13. Tests

### `tests/unit/` (Vitest + jsdom — pure logic)
`card-price`, `card-image`, `card-sort`, `graded-price`, `collection-aggregation`, `card-recognition` (parse+score), `ebay-query` (`buildEbayQuery`), `app-renders` (harness smoke).

### `tests/integration/` (Vitest — mocked Prisma/fetch, no live DB/network)
`bulk-add-order` (F-15), `collections` (F-10 service CRUD), `compare-collections` (F-22), `contact-support` (F-21), `psa-price` (F-17 + resolveGradedPrice interplay), `pokemon-price`, `graded-pricing.golden` (±10% vs `tests/fixtures/golden_prices.json`), `golden-prices` (fixture validity).

### `e2e/` (Playwright, port 3001, standalone build)
`auth.setup.ts` (provisions real session → storageState), `constants.ts` (STORAGE_STATE),
`home` (unauth redirect), `google-login` (mocked OAuth, F-02), `search-debounce` (F-05),
`show-more-duplicates` (F-04), `folder-filters` (F-06), `card-details-popup` (F-08),
`chart-interactivity` (F-09), `collections-ui` (F-10), `want-list` (F-07, serial),
`graded-add-flow` (F-19), `notifications-panel`, `scanner.camera` + `scanner.hardening.camera`
(F-14, fake media device), `visual-regression` (gated behind `VISUAL=1`),
`fixtures/seed-graded-card.ts` (F-19 fixture seeder).

---

## 14. Static & reference assets

| Path | Purpose |
|---|---|
| `public/` | `manifest.json`, `sw.js` (PWA shell), icons, `/cards/card-back.webp` (detail-page hero flip) |
| `.reference/` | Product requirement PDFs/notes — read for intent, not code |
| `dojo-design/`, `dojo prototype/` | Design prototypes (source of the screen-number references + typefaces) |
| `infra/` | Deploy scaffolding notes |
