# ARCHITECTURE.md — System design, data flows, and patterns

> Deep context for changing data flows, adding endpoints/services, touching
> caching, auth, external APIs, the sync engine, or the schema.
> Where things live: `docs/CODE_MAP.md`. Route contracts: `docs/API_REFERENCE.md`.

---

## 1. Layering model

```
Browser (React 19 client components)
  │  TanStack Query v5 (query key registry §7) + fetch(credentials:"include")
  │  Better Auth client (auth-client.ts)
  ▼
Next.js 15 App Router
  ├─ src/middleware.ts        Edge cookie-presence guard (UX only — /dashboard/*, /admin/*)
  ├─ Server Components / RSC   getServerSessionOrRedirect() → Prisma direct (SSR-first)
  └─ API routes (src/app/api) thin handlers
        │  requireAuth / requireAdmin (auth-guard.ts)
        │  Zod at every boundary (validators/ + inline schemas)
        ▼
Services (src/lib/services) — business logic, side effects
  ├─ Prisma (src/lib/db)      PostgreSQL via Supabase — SYSTEM OF RECORD
  ├─ Redis (src/lib/redis)    optional cache — try/catch-wrapped, fail-open, never truth
  └─ External APIs            fetch → map → Zod.safeParse per item → NoResultsError on 0-valid
```

**Invariants of the layering:**
- Routes stay thin: guard → validate → delegate to service → map result to HTTP.
- Services own side effects; **pure domain logic lives in `src/lib/utils/*.ts`** and is unit-tested without DB/network.
- Zod guards three boundaries: external API payloads in, Redis payloads on read (re-parse — cache is untrusted), request bodies in.

## 2. Auth architecture (Better Auth)

```
login page ──authClient.signIn.email──► /api/auth/* (toNextJsHandler(auth))
                                          │  Prisma adapter (session table)
                                          │  cookie: better-auth.session_token (7d, __Secure- in prod)
browser ◄────────────────────────────────┘
  every /dashboard|/admin nav:
    1. middleware (Edge): cookie PRESENCE only → redirect /login?callbackUrl=
    2. layout (RSC): getServerSession() → DB-backed check → redirect if absent
       (dashboard layout also bounces isAdmin → /admin; admin layout bounces non-admins → /dashboard)
    3. every API route: requireAuth()/requireAdmin() re-validates — never trust middleware
```

Key facts:
- `isAdmin` flows through `user.additionalFields` (`input:false`) + 5-min `session.cookieCache` → zero extra DB hits per page load; admin revocation propagates ≤5 min.
- `scripts/create-admin.ts` is the only supported way to grant admin (uses `auth.api.signUpEmail` so the bcrypt hash is correct — direct user-table inserts break login).
- Google OAuth fully wired (`test` credential fallbacks keep routes alive in dev/CI; e2e mocks the OAuth dance at network layer).
- OTP/phone plugin disabled for MVP; `sendSmsOtp` + `sendResetPassword` are console-log dev stubs with documented provider swap points (`auth.ts`).
- `trustedOrigins`: localhost:3000 AND 3001 (e2e), prod domain, `*.vercel.app`.
- `BETTER_AUTH_URL` MUST match the port the app is served on (cookie scoping) — e2e boots on :3001 with `BETTER_AUTH_URL=http://localhost:3001`.

### Admin analytics (live panel)

The admin panel surfaces platform metrics through the `admin-metrics.ts` service (REAL grouped SQL only — RULE 2; every number traces to real rows, a quiet day is a true 0, an empty range renders honest "No data yet").

- **Pages.** `/admin` (Overview) + `/admin/analytics` (detail, FEAT-003). Both `force-dynamic` server components that compute aggregates server-side and pass them as TanStack `initialData` to client wrappers (`LiveOverviewStats` / `AnalyticsDetail`) — populated first paint, no empty flash.
- **Routes.** `GET /api/admin/metrics/overview` ({stats, activeUsers}) and `GET /api/admin/metrics/analytics` (the 7 detail aggregates in one object). Both guarded by the EXISTING `requireAdmin` (401 unauth / 403 non-admin, fresh-DB `isAdmin` re-read — platform financials/PII never leak), `force-dynamic` + `Cache-Control: no-store`. NOT Redis-cached (low-traffic admin, cheap grouped queries).
- **Live refresh.** The client queries override the global TanStack defaults (staleTime 5m, `refetchOnWindowFocus:false`) PER-QUERY: `staleTime:0` + `refetchInterval:25s` + `refetchOnWindowFocus:true`, so the panel auto-refreshes.
- **Metric method notes:**
  - *Scan Vision credits are an ESTIMATE* — `estimatedVisionCredits = (successful scans with ocrSource='vision') × 5`. `SyncLog.credits` does NOT meter Vision scans, so this is derived, not read back; the UI labels it "estimated". A scan abandoned before a pick (`pickedCardId IS NULL`) counts as a FAIL.
  - *Active users (DAU/WAU)* use `Session.updatedAt` as the activity proxy (Better Auth refreshes it on session use), `COUNT(DISTINCT "userId")` within 1 day / 7 days.
  - *Financial consistency* — portfolio value/qty sums carry `uc."isSold" = false` (BUG-3 fix: a disposed holding isn't counted as held), keeping the documented raw-`Card.marketPrice`-for-graded limitation (the JS graded helper can't be called cheaply from SQL).
  - *Ranked cards* (top wanted / most scanned) group by the EXTERNAL id (`want_list_item.cardId` / `scan_feedback.pickedCardId`, RULE 3) and LEFT JOIN `Card.externalId` so an uncatalogued id still shows (null name → falls back to the id).

## 3. The two card-id universe (memorize)

| ID | Example | Where it's used |
|---|---|---|
| `Card.id` (internal cuid) | `clx…` | React keys, `/search/[id]` detail links, admin `PATCH /api/admin/cards/[id]`, `UserCollection.cardId` FK |
| `Card.externalId` (catalog id) | `base1-4`, `OP01-064` | search results, trending `externalId` field, want-list `cardId`, `/api/cards/[id]/history|population|ebay-sold|reprice`, add-to-collection payload, `PricingHistory` lookups |

Trending returns BOTH (`id` + `externalId`) because tiles need a React key/detail link AND a stable catalog identity for add/mutations. `CardSet.externalId` is `"{game}-{sourceSetId}"` (e.g. `pokemon-base1`) — game filtering joins through the set prefix.

## 4. Card catalog data flow

### 4.1 Ingestion (write path — cron only)

```
Vercel Cron 02:00 UTC ──GET /api/cron/sync-cards (Bearer CRON_SECRET)──► runCardSync()
  1. list sets from BOTH games in parallel (per-game failure → [] — one dead API can't kill the run)
  2. filter: missing from CardSet OR updatedAt older than 7 days
  3. interleave P/OP/P/OP…, slice to 10 sets (MAX_SETS_PER_RUN)
  4. per set, inside a 250s wall budget (RUN_BUDGET_MS):
       a. FETCH CARDS FROM SOURCE FIRST — failure aborts BEFORE any DB write,
          so the set stays "missing" and retries next run
          (upserting the set first would refresh updatedAt and hide the failure)
       b. upsert CardSet metadata
       c. upsert cards in parallel chunks of 10, re-checking deadline mid-set
  5. per card enrichment:
       tags       = buildTags(rarity, types, number, set)      — searchable immediately
       marketPrice= pickPokemonMarketPrice(card)               — TCGplayer market, Cardmarket fallback
       OP image   = resolveOnePieceCleanImage(code)            — only when licensed keys configured;
                                                                else keep watermarked (never blank)
```
Idempotent everywhere (`upsert` keyed on `externalId`). Sources: Pokémon → pokemontcg.io (`POKEMON_TCG_API_KEY` optional, raises 30/min → 20k/day); One Piece → apitcg (`APITCG_API_KEY` required for OP sync).

### 4.2 Read path (search)

```
GET /api/cards/search (game, query, sort, set?, rarity?, graded?, minPrice?, maxPrice?, language?)
  → reads ONLY local Postgres (take 60) — external APIs are NEVER hit per keystroke
  → language (en|ja|all, default all): INFERRED from the externalId — Japanese cards contain the
    literal "_ja-" (e.g. bw1b_ja-3), English/other do not. ja → Prisma contains "\_ja-" (underscore
    ESCAPED so Postgres LIKE matches it literally, not as a single-char wildcard); en → NOT contains;
    all → no predicate. Spreads into baseWhere so it composes with every candidate query and keeps
    offset pagination (rule 12). "English" = non-Japanese (other langs lumped in). Distinct from the
    scanner's `language` param, which is echo-only and does NOT filter. ponytail: filtered LIKE scan
    on externalId; upgrade = partial/expression index on `externalId LIKE '%\_ja-%'` or a generated
    boolean `isJapanese` column.
  → sort omitted/"trending" = RELEVANCE: parseSearchQuery → bounded candidate pool (300; +600
    name-prefix recall pool only when no name hit and not identifier-like) → rankCards in JS
    (search-query.ts / search-rank.ts). Cache key sort = "rel-v2". Explicit sort = legacy single query.
  → optional SEARCH_ENGINE=typesense (fetch, no dep): card-search-index.service returns ordered
    externalIds only; rows are hydrated from Postgres with the SAME filters; null/throw/empty →
    Postgres path (still 200). Identifier-shaped queries never go to the index.
  → Index is a rebuildable projection: scripts/backfill-search-index.ts (OWNER-RUN, dry-run default,
    --apply writes). Env: SEARCH_ENGINE, TYPESENSE_URL, TYPESENSE_SEARCH_API_KEY (server, search-only),
    TYPESENSE_ADMIN_API_KEY (backfill only), TYPESENSE_COLLECTION, TYPESENSE_TIMEOUT_MS.
  → Deferred (Epic D): collection-scoped sold records need live credit-gated Scrydex /listings calls
    and provider-rights confirmation; not built.
  → filters: set.externalId startsWith "{game}-", set name equals-insensitive,
    rarity contains, graders regex (PSA|BGS|CGC|SGC|Beckett), price range,
    text = OR(name, number, tags has q, set.name contains, set.externalId contains)
  → image-presence (UNCONDITIONAL, Bug 1): imageUrl not null AND NOT "" — folded into the same
    nested-AND concat as hasPrice/language so imageless catalog rows (e.g. the exu-* Unown) are
    NEVER listed. Excludes on imageUrl ONLY, never marketPrice/price (legit cards can have a null
    Card.marketPrice but a real CurrentPrice NM row). The same predicate rides trending's shared
    gameFilter, so the Explore grid + topTrendingCardIds exclude imageless cards too.
  → orderByForCardSort(sort)
  → One Piece images → onePieceImageChain() (stored → storedHi → same-origin proxy)
```
The `card.service.searchCards` fallback chain (pokemontcg.io → tcgdex → scrydex; apitcg → cardmarket) exists for the service-level path and is Zod-normalized (`NormalizedCardSchema`), Redis-cached 24h, circuit-broken.

### 4.3 Price pipeline

- `Card.marketPrice` = snapshot cache, refreshed by sync / reprice / backfill / snapshot scripts; `lastPricedAt` = staleness clock (graded-price staleness = 7 days).
- `POST /api/cards/reprice` (public, ≤20 ids): Redis `price:card:{id}` 6h → live pokemontcg.io fetch (6s timeout) → `pickPokemonMarketPrice` → cache write + `Card.marketPrice` update. Fired by the search page in the background for unpriced tiles — deliberately OFF the search hot path.
- `PricingHistory` rows grow from several sources: the Scrydex store-and-reuse orchestrator (`source="scrydex"` current points; real multi-point history from the documented `price_history` endpoint under Owner_Approval), the collection add-snapshot (`source="add-snapshot"`), and the legacy harness scripts. The fabricated `"scrydex-trend"` backfill is REMOVED (Req 7.2). Rows carry `source`/`currency`/`variant`/`condition`; the history chart drops `priceMarket == null` rows (never a fabricated `$0`). Real history grows per card on the daily sync cadence; dashboard portfolio chart reads real stored history when ≥1 point exists (else the empty state), card-detail chart uses real points when present.
- **Scrydex store-and-reuse (FR-4, the single writer).** `scrydex-pricing.service.pullAndStoreScrydexPrice(card, { force? })` is the ONLY place that pulls + stores Scrydex pricing, so the gate / first-pull invariant / credit metering cannot drift between callers (daily sync, backfill pilot, graded route all route through it):
  1. **Freshness gate** (unless `force`) — reads the newest `SyncLog(job="scrydex_history", cardId).ranAt`; within `SCRYDEX_STALE_MS` (24h) → skip entirely (no HTTP, no credit, no row). Gated on `SyncLog` not `CurrentPrice`, so a graded-only / no-raw card is still throttled 24h.
  2. **Pull** — by cached `Card.scrydexId` (`fetchScrydexCardById`) else `resolveScrydexCard` (search by name, match on number+set); on resolve, cache the native id back onto `Card.scrydexId`. null/throw → `SyncLog(status="failed", credits:0)` and return.
  3. **Persist** — one `PricingHistory` row (`source="scrydex"`, headline RAW NM) + **full current-price capture (C1):** every `variants[].prices[]` entry becomes its own `CurrentPrice` row (all raw conditions + all graded company/grade incl half `8.5` / qualified `9Q`), keyed `[cardId, source, currency, variant, condition, company, grade, type]` (`type` = `raw`|`graded`; raw rows keep `company`/`grade` NULL, graded rows use the stable `condition="GRADED"` sentinel). Because Prisma can't target a nullable column in a compound-unique `where`, the writer REPLACES the card's SCRYDEX set atomically — `deleteMany(where: source=SCRYDEX)` + `createMany` inside a `$transaction` (idempotent: the 24h gate guarantees one complete fresh set per pull). Runs for graded-only cards too (outside the `if (raw)` block). Both-null entries skipped (never a fabricated `$0`). The RAW-NM headline / `Card.marketPrice` / weekly-change / cost-basis logic is unchanged.
  4. **Real history (documented endpoint)** — the fabricated first-pull `scrydex-trend` backfill is REMOVED (Req 7.2). Real multi-point history comes from `GET /{slug}/v1/cards/{id}/price_history` via `fetchScrydexPriceHistory` (3 credits/call), gated behind Owner_Approval (Checkpoint D) and NOT invoked by the writer. UNRESOLVED (Audit L2): whether graded points are labeled in the response and whether one call returns separable RAW/PSA/BGS series — no fabricated graded series.
  5. **Meter** — `SyncLog(status="ok", credits=SCRYDEX_CREDITS_PER_CALL)` once per successful fetch (trend points add no credits).
- **Daily owned-price refresh.** `GET /api/cron/refresh-owned-prices` (Vercel cron 03:00 UTC, `CRON_SECRET`-guarded via constant-time compare, **fail-closed in production** — a missing secret rejects in prod, local dev only pass-through) → `refreshOwnedPrices()` in `owned-price-refresh.service.ts`. It keeps CURRENT price DAILY-fresh for the OWNED set ONLY: the distinct `Card.id` across every active `UserCollection(isSold:false)` row for ALL users (NOT user-scoped, NOT the whole catalog), deduped in JS and mapped to `ScrydexPullCard` (selects both `Card.id` and `externalId`/`scrydexId` per the two-id rule). Each card goes through the single writer `pullAndStoreScrydexPrice` (NO `force`) behind the SOFT credit gate — when `SCRYDEX_LIVE_CREDITS_APPROVED` is unset the whole run is a safe no-op (no DB read, no HTTP, zero credits, logs "skipped: credits not approved"). Bounded by a per-run cap `DAILY_OWNED_PRICE_CAP` (default 250, cards handed to a width-5 pool) + a ~250s wall-clock budget; leftover owned cards refresh on the next daily run because the writer's per-card 24h freshness gate skips already-fresh cards (resumable, no cursor table). It writes `CurrentPrice` only (**NOT `Card.marketPrice`** — stays on the existing single-writer path) and never fabricates (a card with no Scrydex current price leaves `CurrentPrice` unchanged). One summary `SyncLog(job="daily_owned_price", status="ok", credits=<total>, error="summary: owned=… attempted=… refreshed=… skipped=… failed=…")` row is written per run for admin/logs visibility. **History / population / deeper Scrydex data stay on the existing on-view 7-day cadence — this job does NOT change their schedule or scope.** (The old `/api/cron/sync-cards` daily catalog sync was removed in commit `bf1eb28`; this is the only scheduled job.)
- **Price fallback chain (FR-1).** Catalog + first price come from the primary catalog source (TCGdex for Pokémon, apitcg for One Piece). PokéWallet/BerryWallet are **PRICING ONLY** gap-fills: One Piece fills `marketPrice` from `fetchOnePieceSetPrices(setCode)` where apitcg's TCGplayer price was null (join key = `Card.externalId` == PokéWallet `card_number`); Pokémon gaps fall to `fetchPokemonCardPrice(name)`. Scrydex (store-and-reuse) then refines the real history series. A missing value stays `null` → UI "—", never coerced to 0.
- Graded pricing (F-17 + FR-6): the public `GET /api/cards/[id]/graded` route runs `resolveGradedPrice` with a Scrydex `priceSource` (`pickGradedPrice` over the ScrydexCard returned by `pullAndStoreScrydexPrice`). Live Scrydex PSA market → `isFallback:false`; null → `getGradedPrice` curated 20-entry table / `{8:1.2, 9:1.5, 10:2.5}` multipliers (strictly increasing so grade hierarchy never inverts) with `isFallback:true`. `fetchPSAGradedPrice` (PSA public cert API, verification only) remains the offline cert-verify fallback.

### 4.4 Scanner pipeline (F-14)

```
camera frame → crop/2×/grayscale/contrast → glare check (warning only)
  → POST /api/cards/recognize {image}                (Vision TEXT_DETECTION, server key only)
  → if ocrSource:"unavailable" (no key / failed) → on-device tesseract.js → POST {text, source:"tesseract"}
  → DB prefilter: first ≤8 tokens (≥3 chars) → card.findMany name contains, game-scoped, capped 500 rows
  → parseOcr (collector number + set-code regexes, name lines ≥50% letters)
  → scoreCards: +50 number, +20 set, +30×fuzzy name similarity (0.6 floor, sliding windows)
  → top 5 candidates, confidence = score/100; client gate = 0.4
  → ScanFeedback row (ocrText, candidates) → feedbackId
  → user picks → POST /api/users/me/collection + PATCH /api/cards/recognize {feedbackId, pickedCardId}
```

Scanner inputs: live camera, or **Choose photo** (JPEG/PNG/WebP, ≤20 MB; client `validateScanFile` checks MIME + magic bytes, decodes with EXIF orientation, downscales to ≤1600px, then feeds the same Vision → Tesseract → text flow; object URLs revoked on retake/unmount; image data never logged). A **Card language** select (All/English/Japanese, `localStorage` `dojo:scan-language`) is sent as `language`; it is echoed only (`languageApplied:false`) because the catalog has no per-card language column.
The feedback table is the ground-truth dataset for re-tuning `WEIGHTS` — measured, never guessed.


**7-day change provenance (FEAT-003):** `Card.weeklyChangeAbs/Pct` are written only by the Scrydex pricing pull from `trends.days_7` (each independently, only when numeric). There is NO staleness column (`Card.weeklyChangeAt` is deferred, needs an owner DB change), so values reflect the last provider refresh. Search/trending sort them DB-side (`nulls: last`); the portfolio sorts in memory with `sortByWeeklyChange`. Chart/`PricingHistory`/synthetic data is never used for this sort.

## 5. eBay integration

- OAuth2 client-credentials → app token cached in Redis **7000s vs 7200s expiry** (200s safety margin).
- `EBAY_API_URL` **defaults to sandbox** — flipping to production is an env change.
- `buildEbayQuery`: Pokémon = all quoted phrases (`"Charizard ex" "Obsidian Flames" "125/197"`), category 183454; One Piece = quoted name + loose Bandai code (forcing set phrases returned ZERO listings — pinned by `tests/unit/ebay-query.test.ts`), no category.
- `filter=buyingOptions:{FIXED_PRICE|AUCTION}` skips classified ads with no price.
- **"Sellers on the Floor" = ACTIVE listings, not sold history.** eBay's Browse API has no sold/completed filter; true sold data is behind the restricted Marketplace Insights API — `searchEbaySellerListings` is the documented swap point.
- Compliance endpoint `/api/ebay/marketplace-account-deletion`: GET challenge (SHA-256 of `challenge_code + verification_token + endpoint`) and POST notifications (always 200 to avoid eBay's retry storm).
- Route-level degradation contract: eBay failures → HTTP **200** `{ fallback: true, listings: [] }` so the UI renders "eBay unavailable" instead of a 5xx toast.

## 6. Caching model

### 6.1 Redis — optional accelerator (never source of truth)

| Key (builder in `redis.ts` unless noted) | TTL | Writer / Reader |
|---|---|---|
| `card:search:{game}:{query}` | 24h | `card.service.searchCards` (Zod re-parsed on read) |
| `ebay:app-token` | 7000s | `ebay.service.getEbayAccessToken` |
| `ebay:search:{name\|set\|number\|game}` | 24h | `/api/ebay/search` |
| `card:soldrows:{cardId}` | 120s | `/api/cards/[id]/ebay-sold` (Postgres `SoldListing` read-through; legacy `ebay:sold:*` retired) |
| `price:card:{externalId}` | 6h | `/api/cards/reprice` |
| `card:trending:{game\|all}:{sort}:{limit}:{offset}` (built inline in route) | 120s | `/api/cards/trending` |
| `circuit_breaker:fail:{name}` / `circuit_breaker:{name}` | 600s | `fallback-executor` |
| `otp:{phone}` / `otp:rate:{phone}` | 600s / 3600s | phone plugin (disabled MVP) |
| `dashboard:{userId}` | 90s | dashboard SSR `page.tsx` — **per-user (RULE 5)** |
| `collection:{userId}` | 90s | `GET /api/users/me/collection` — **per-user (RULE 5)** |
| `wantlist:{userId}:{intent\|all}` | 60s | `GET /api/want-list` — **per-user (RULE 5)**, per-intent |
| `collections:{userId}` | 60s | `GET /api/collections` — **per-user (RULE 5)** |
| `card:searchq:{normalizedParams}` | 300s | `GET /api/cards/search` — user-agnostic (RULE 3); cards re-parsed with `NormalizedCardSchema` on read; only non-empty 200s cached |
| `card:prices:{externalId}` | 300s | `GET /api/cards/[id]/prices` — user-agnostic (RULE 3), DB-read-only (no Scrydex) |
| `card:history:{externalId}` | 600s | `GET /api/cards/[id]/history` — user-agnostic (RULE 3), DB-read-only (no Scrydex) |
| `card:pop:{externalId}` | 86400s | `GET /api/cards/[id]/population` — user-agnostic (RULE 3), stored-read only (no Scrydex) |
| `ratelimit:{bucket}:{u:userId\|ip:ip}` | 60s (tier window) | `enforceRateLimit` (`src/lib/utils/rate-limit.ts`) — fixed-window counter, FAIL-OPEN; `bucket` = `credit`\|`auth`\|`search`; a miss/outage ALLOWS the request (not a source of truth) |

The per-user keys above (`dashboard`/`collection`/`wantlist`/`collections`) go through `src/lib/utils/cache.ts` (`cacheGetJson`/`cacheSetJson`), and TTLs live in `CACHE_TTL` in `redis.ts`. **Every** per-user key embeds the `userId` (RULE 5 — a key without it would leak one user's private data to another); the card keys are deliberately user-AGNOSTIC (RULE 3 — the catalog result is identical for everyone). `/api/cards/[id]/graded` is intentionally NOT cached — it routes through the credit-gated `pullAndStoreScrydexPrice`, so a cache there could alter gate/freshness behavior.

#### Mutation → invalidated keys

Every mutation deletes the keys its data feeds, best-effort via `invalidateUserCaches(userId, scopes)` on the WRITE path (after the DB write commits — a failed delete never fails the mutation, only costs one later cache miss). The want-list family is dropped via `redis.keys(wantlist:{userId}:*)` so a move between tabs can't leave a stale intent list.

| Mutation | Invalidated keys |
|---|---|
| add / sell / update / delete collection item (`POST/PATCH/DELETE /api/users/me/collection[...]`, `POST .../[id]/sell`) | `collection:{userId}` + `dashboard:{userId}` |
| want-list add / move / remove (`POST /api/want-list`, `PATCH/DELETE /api/want-list/[id]`) | `wantlist:{userId}:*` (whole family) + `dashboard:{userId}` |
| collection create / rename / delete (`POST /api/collections`, `PATCH/DELETE /api/collections/[id]`) | `collections:{userId}` + `dashboard:{userId}` |

**Every** Redis read/write is individually try/caught → outage falls through to live data. Non-fatal `[Redis] … falling through` logs in dev are expected. `redis` is a lazy Proxy so `next build` never needs `REDIS_URL`.

### 6.2 Circuit breaker + fallback chain

`executeWithFallback(tasks)` runs ordered sources; each task gets a 5s `Promise.race` timeout. **`NoResultsError` = "healthy but no match"** → advance to next source WITHOUT counting a failure. Real failures count: 3 consecutive → breaker opens 600s → source is skipped (half-open retry after TTL). Breaker itself is fail-open (Redis down = attempt anyway).

### 6.3 HTTP cache headers

- `/api/cards/search`: `public, max-age=30, stale-while-revalidate=300`
- `/api/cards/trending`: `private, max-age=30, swr=120`
- `/api/cards/[id]/population`: `private, max-age=86400`
- `/api/card-img` + `/api/card-img/[id]`: `public, max-age=86400, swr=604800` (upstream fetch `force-cache`). The id-based twin resolves `Card.imageUrl` server-side so the browser never sees the upstream `images.scrydex.com` host; both share the SSRF allowlist (`card-img/ssrf.ts`).
- `/api/one-piece-img/[cardId]`: `public, max-age=86400, swr=604800` (upstream fetch `force-cache`)
- collection/want-list/users-me GETs: `no-store`
- `/api/cron/refresh-owned-prices`: `force-dynamic`

## 7. TanStack Query key registry (client)

| Key | Fetch | Notes |
|---|---|---|
| `["collection"]` | `GET /api/users/me/collection` | DashboardClient with SSR `initialData`; `/you` |
| `["portfolio-collection"]` | same endpoint | portfolio page; both keys prefetched by shell on nav hover |
| `["want-list", intent, collectionId ?? "__account__"]` | `GET /api/want-list(?intent=&collectionId=)` | F-#8: 3-tuple adds the collection dimension (`__account__` = null scope). TanStack PREFIX invalidation on `["want-list"]` still matches BOTH this and the legacy 2-tuple keys, so the whole family is invalidated by any want-list mutation |
| `["collections"]` | `GET /api/collections` | AddCardSheet, portfolio filter, CollectionsSection, **CollectionBucketBar** (F-#8 per-collection `buckets`) |
| `["trending-cards", game, sort]` | `GET /api/cards/trending` | **infinite query**, offset cursor |
| `["card-search", game, q, sort, set, rarity, graded, minPrice, maxPrice]` | `GET /api/cards/search` | enabled only when q non-empty |
| `["search-suggest", game, q]` | same route | autocomplete, staleTime 60s |
| `["card-multi", game, q]` | search or trending (normalized) | `/search/multi` |
| `["card-history", id]` | `GET /api/cards/[id]/history` | staleTime 60s |
| `["population", id]` | `GET /api/cards/[id]/population` | staleTime 24h |
| `["ebay-sold", id, name, set, rarity, number, game]` | `GET /api/cards/[id]/ebay-sold` | Postgres `SoldListing` read (Part D); server read-through 120s |
| `["linked-accounts"]` | `authClient.listAccounts()` | `/you` |
| `["admin-overview"]` | `GET /api/admin/metrics/overview` | **Live admin** — SSR `initialData`, `staleTime:0`, `refetchInterval:25s`, `refetchOnWindowFocus:true` (overrides global defaults) |
| `["admin-analytics"]` | `GET /api/admin/metrics/analytics` | **Live admin** — same per-query live overrides as `admin-overview` |

**Invalidation map:** add-to-collection → `["collection"]` + `["portfolio-collection"]`; want-list add/remove/move → whole `["want-list"]`; bulk delete → `["portfolio-collection"]` + `["collection"]`; admin card PATCH → no query invalidation (RSC `router.refresh()`).

## 8. Data model (Prisma)

```
User 1─n Session / Account / UserCollection / Collection / SupportTicket / WantListItem
CardSet 1─n Card
Card 1─n UserCollection (per-variant uniqueness: PARTIAL expression unique index
      `uc_variant_coalesced` UNIQUE(userId, COALESCE(collectionId,''), cardId, isFoil,
      COALESCE(condition,'')) WHERE isSold=false — re-add of the same variant increments
      quantity; NOT a plain Prisma @@unique (NULL-distinct + non-partial); sold lots repeat)
      1─n PricingHistory
      1─n CurrentPrice
      1─n SoldListing (Part D — real eBay SOLD records, onDelete: Cascade)
Collection 1─n UserCollection (collectionId nullable, onDelete: SetNull — deleting a
             collection unfiles cards, never deletes owned copies)
Collection 1─n WantListItem (F-#8: collectionId nullable, onDelete: SetNull — null =
             legacy account-level scope surfaced under top-level All)
UserCollection.purchasePrice = what the user paid (distinct from Card.marketPrice)
WantListItem.cardId = EXTERNAL id string (NOT a FK — a card can be wanted pre-sync).
WantListItem per-scope uniqueness: expression unique index `wli_scope_coalesced`
  UNIQUE(userId, cardId, intent, COALESCE(collectionId,'')) — same card+intent once per
  collection and once at the null/account scope; replaced the old [userId,cardId,intent].
AuditLog, ScanFeedback: append-only operational tables
SyncLog: append-only metering/metering table (job, cardId?, credits, status, error, ranAt)
```

**Main collection & legacy nulls (FEAT-004).** Each user has one protected `Collection` named "Main" (case/space-insensitive via `isMainCollectionName`), created lazily by `getOrCreateMainCollection` (idempotent; a P2002 race re-reads the winner). It cannot be renamed, deleted or have settings changed (`MainCollectionProtectedError` → 409) and nothing else can claim the name. Adds default to Main. `UserCollection.collectionId = null` rows are LEGACY: they are never rewritten by adds, remain visible under "All collections", and the `__uncat__` "Uncategorized" bucket is shown ONLY while some active or sold lot is still null (`shouldShowUncategorized`; the dashboard SSR page and `DashboardClient` build `defaultCollectionIds` through the same `defaultSelectorIds` helper so the chart query key stays byte-identical). No schema change was made.
**Null → Main backfill runbook (OWNER-RUN, NOT RUN by agents).** `scripts/backfill-main-collection.ts` (planner: `src/lib/utils/main-backfill.ts`). `npx tsx scripts/backfill-main-collection.ts` = DRY RUN (counts only; default). `--user <id>` limits scope. `--apply` creates Main per user and moves only `where { id, userId, collectionId: null }`, writing `backfill-main-manifest-<timestamp>.json`. `--rollback <file> [--apply]` sets `collectionId` back to null only for manifest ids currently in that user's Main. Rows that would collide with `uc_variant_coalesced` (same user+card+foil+normalized condition already active in Main) are reported as conflicts and left unassigned; sold rows are skipped; want-list rows are untouched. Writes to the configured `DATABASE_URL`.
**Removal semantics (FEAT-004).** Portfolio select-mode action is "Remove from collection" behind a confirm dialog ("…from your collection only"); it fans out `DELETE /api/users/me/collection/[id]` (owner-scoped, one `UserCollection` row), never touches the catalog, keeps failed ids selected, and invalidates `["portfolio-collection"]`, `["collection"]`, `["collections"]`. Multi-select Add (`/search/multi`) posts `{ collectionId, onExisting: "skip", cards }` and reports added / already-present / invalid.
**Three id namespaces (NFR-3).** `Card.id` (internal cuid, FK target for `PricingHistory.cardId` / `CurrentPrice.cardId`) vs `Card.externalId` (catalog id — TCGdex `base1-4` for Pokémon, Bandai `OP01-001` for One Piece) vs the additive `Card.scrydexId` (Scrydex-native id like `me55c-4`, cached after `resolveScrydexCard` matches by name+number+set). Never confuse the three.

**P&L / portfolio accounting (`portfolio-accounting.ts`).** The pure `statsFromLots` helper is the SINGLE source of truth for Market Value / Paid / Realized / Unrealized — the portfolio page, dashboard stat card + per-collection buckets, and the `/you` page all route through it (never inline reduces, so the surfaces can't diverge). Honesty rules live in the engine: null cost basis is excluded + counted (never `$0`), sold lots are split out of market value (realized uses `soldPrice` as a GROSS TOTAL, not re-multiplied). **Graded value:** a lot whose `condition` names a grading company (`isGraded`) is valued at its GRADED price via `graded-price.ts` (`gradedPrice`/`parseGrade` — curated lookup, else a coarse per-grade multiplier), matching the card-detail / add-sheet surfaces; raw lots keep `Card.marketPrice` verbatim. **P&L is USD-only** — no FX conversion is applied to either side (latent, out of scope). **Admin limitation:** `admin-metrics.ts` SQL excludes sold rows from value/invested (`AND uc."isSold" = false`) but sums RAW `Card.marketPrice` for graded holdings — the JS graded helper can't be called cheaply from SQL, so admin value is raw-for-graded as a documented limitation (reconciling needs post-fetch JS resolution per row, not a SQL port).

**Pricing models (enriched baseline):**
- `Card.game` (`Game` enum: `POKEMON`/`ONE_PIECE`) + `Card.source` (`DataSource` enum: `TCGDEX`/`SCRYDEX`/…) stamped by the sync on upsert; `Card.scrydexId String? @unique`.
- `PricingHistory` — append-only time series. Columns `priceMarket`/`priceLow`/`source`/`currency`/`variant`/`condition`/`recordedAt`; unique `[cardId, recordedAt, source, currency, variant, condition]`. Sources: `scrydex`, `add-snapshot` (+ legacy harness rows). `scrydex-trend` is retired (no new rows; existing rows cleaned under Owner_Approval per task 2.14).
- `CurrentPrice` — latest price per provenance. **Full capture (C1):** columns `company String?` / `grade String?` / `type String @default("raw")` (`raw`|`graded`); unique `[cardId, source, currency, variant, condition, company, grade, type]` (migration `20250103000000_current_price_full_capture`, index `current_price_cardId_source_currency_variant_condition_comp_key`). Raw rows → `company`/`grade` NULL + real condition; graded rows → `condition="GRADED"` sentinel + uppercased company + verbatim grade. `source=DataSource` enum.
- `SyncLog` — `job`/`cardId?`/`credits`/`status`/`error`/`ranAt`; the Scrydex freshness gate + credit meter read/write `job="scrydex_history"` rows. Population pulls meter under `job="scrydex_population"`, sold-listings under `job="scrydex_listings"` (both separable, neither touches the history gate).
- `SoldListing` (**Part D**) — persisted real eBay SOLD records for the card-detail "Recent Sales" section (migration `20250104000000_sold_listing`). Columns `source?`/`itemId`/`title?`/`price?`/`currency?`/`soldAt?`/`grade?`/`company?`/`url?`/`fetchedAt`; unique `[cardId, itemId]` (idempotent upsert); index `[cardId, soldAt]` (read `orderBy soldAt desc nulls-last take 8`); FK `cardId → card(id)` ON DELETE CASCADE. Written ONLY by the owner-approval-gated single writer `pullAndStoreSoldListings` (gate stays DENY; not invoked live). The read route `/api/cards/[id]/ebay-sold` is a pure Postgres read (NO credit gate), with a 120s `soldRows` read-through; the legacy Redis-only `ebay:sold` cache is retired.

Indexes worth knowing: `Card.@@index([updatedAt])` (trending), `Card.@@index([tags], type: Gin)` (`has` search), `CardSet.@@index([name])` (set filter), `PricingHistory.@@index([cardId, recordedAt])` (history chart), `UserCollection.@@index([userId, addedAt])` (dashboard/portfolio/collection `where userId + orderBy addedAt desc`), `SyncLog.@@index([job, ranAt])` + `@@index([job, cardId, ranAt])` (the Scrydex freshness-gate query), `WantListItem.@@index([userId, intent])` (back-compat intent-only query) + `@@index([userId, collectionId, intent])` (F-#8 per-collection want query), plus the two F-#8 partial/expression unique indexes `uc_variant_coalesced` and `wli_scope_coalesced` (first real migration under `prisma/migrations/`; the project previously used `db push`). Graded metadata lives in `UserCollection.condition` ("PSA 10") + `Card.rarity` — dedicated columns are the planned migration.

## 9. External API inventory

| API | Used by | Auth env | Fallback chain position |
|---|---|---|---|
| pokemontcg.io `/v2` | card.service, sync, pokemon-price, reprice | `POKEMON_TCG_API_KEY` (optional) | Pokémon source 1 (sync + price source) |
| tcgdex | card.service | none | Pokémon source 2 (catalog + first price) |
| scrydex | scrydex.service + scrydex-pricing.service (store-and-reuse), graded route | `SCRYDEX_API_KEY` + `SCRYDEX_TEAM_ID` (BOTH required — missing team id → instant 401) | Pricing history + PSA graded (both games). **Vision identify UNRESOLVED** → `identifyCard` returns null → tesseract fallback |
| apitcg | card.service (OP search), sync (OP catalog) | `APITCG_API_KEY` (required) | One Piece source 1 (catalog) |
| PokéWallet / BerryWallet | pokewallet.service (PRICING ONLY) | `POKEWALLET_API_KEY` (`X-API-Key`) | Pokémon price gap-fill (`/search`); One Piece price gap-fill (`/op/sets/{code}`) |
| cardmarket | card.service (OP metadata), card-image.server (clean OP images) | `CARDMARKET_APP_TOKEN` | One Piece source 2 / clean-image source 2 |
| eBay Browse + OAuth | ebay.service | `EBAY_CLIENT_ID/SECRET`, `EBAY_API_URL` (sandbox default) | — |
| eBay account-deletion | compliance route | `EBAY_MARKETPLACE_DELETION_TOKEN` + `_ENDPOINT` | — |
| PSA public cert | psa-price.service | `PSA_API_KEY` | — (verification only) |
| Google Cloud Vision | vision-ocr.service | `GOOGLE_VISION_API_KEY` | tesseract.js on-device fallback |
| TCG Collector | card-image.server (clean OP images) | `TCGCOLLECTOR_API_KEY` (+ `_BASE`) | clean-image source 1 |
| Bandai `onepiece-cardgame.com` | one-piece-img proxy | none | CORP-blocked direct → proxy |

## 10. Environment variables

| Var | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Supabase **pooled** (PgBouncer, port 6543) — runtime |
| `DIRECT_URL` | yes | Supabase direct (port 5432) — migrations only (prepared statements) |
| `REDIS_URL` | runtime only | `redis://localhost:6379` dev / `redis://redis:6379` compose; never read at build |
| `BETTER_AUTH_SECRET` | yes | 32+ random chars |
| `BETTER_AUTH_URL` | yes | MUST match serving origin/port (cookie scoping; e2e uses :3001) |
| `SIGNUP_ALLOWLIST` | no | gates NEW signups (email/pw + Google) via `user.create.before`; comma-separated exact emails and/or `@domain`; empty/unset = open |
| `GOOGLE_CLIENT_ID/SECRET` | prod | `test` fallbacks keep routes alive in dev |
| `CRON_SECRET` | prod! | guards `/api/cron/refresh-owned-prices`; unset = fail-closed in prod (rejected), unauthenticated pass-through local dev only |
| `DAILY_OWNED_PRICE_CAP` | no | max owned cards refreshed per daily run (default 250); leftovers drain next run via the 24h gate |
| `POKEMON_TCG_API_KEY` | no | raises rate limit to 20k/day |
| `APITCG_API_KEY` | for One Piece | x-api-key header |
| `EBAY_CLIENT_ID/SECRET` | for eBay | client-credentials |
| `EBAY_API_URL` | no | defaults **sandbox** |
| `EBAY_MARKETPLACE_DELETION_TOKEN/_ENDPOINT` | prod (eBay compliance) | challenge hash inputs |
| `GOOGLE_VISION_API_KEY` | no | absent → tesseract.js fallback |
| `PSA_API_KEY` | no | absent → curated graded table |
| `TCGCOLLECTOR_API_KEY`, `TCGCOLLECTOR_API_BASE`, `CARDMARKET_APP_TOKEN` | no | clean One Piece images |
| `SMS_PROVIDER_*` | no | OTP plugin disabled MVP |
| `RESEND_API_KEY` + `EMAIL_FROM` (or `EMAIL_PROVIDER_API_KEY` + `EMAIL_PROVIDER_BASE_URL` + `EMAIL_FROM`) | prod (password reset) | configured → reset links emailed via Resend REST; dev w/o provider logs link; prod w/o provider logs a clear error (never silent) |
| `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY` | no | client base URL / future uploads |
| `ADMIN_INITIAL_PASSWORD` | for create-admin script | |
| `RATELIMIT_CREDIT_PER_MIN` | no | per-USER cap on Scrydex-credit routes (recognize/enrich/reprice/ebay-sold POST/portfolio refresh); default **10**/min |
| `RATELIMIT_AUTH_PER_MIN` | no | per-IP cap on auth sign-in/sign-up POSTs (get-session never limited); default **10**/min |
| `RATELIMIT_SEARCH_PER_MIN` | no | per-user-if-authed-else-IP cap on `/api/cards/search`; default **60**/min |

## 11. Pattern catalog (the house style)

1. **Cache-optional wrapping** — every Redis call try/caught; cache is accelerator not dependency.
2. **Never-fabricate** — no value → null → UI "—"; reference data labeled `source:"reference"`; mock adapters deleted.
3. **Null-as-signal** — `fetchPokemonMarketPrice`/`fetchPSACert`/`detectTextWithVision`/`resolveOnePieceCleanImage` return null on failure; callers translate to fallbacks.
4. **Result-object over exceptions** — `requireAuth` discriminated union; `submitSupportTicket` `{ok}`; eBay routes `{fallback:true}`.
5. **Ownership by query scoping** — `where: { id, userId }` → P2025 → 404 identical to nonexistent.
6. **Graceful degradation on public card routes** — 200 + empty payload, never 5xx; authed CRUD may 4xx/5xx.
7. **Offset pagination** — `skip: offset` + numeric `nextCursor`; composes with any sort (don't switch to keyset casually).
8. **Bulk-add ordering** — `assignBulkAddOrder` stamps strictly-decreasing `addedAt` (F-15).
9. **Fail-open circuit breakers** — Redis outage can't block traffic.
10. **Server/client module discipline** — `auth.ts` & `card-image.server.ts` server-only; `auth-client.ts` & `card-image.ts` client-safe; secrets never reach the browser.
11. **SSR-first pages** — dashboard pre-fetches and hands `initialData` to the client query (no loading flash).
12. **URL-driven UI state** — search filters, admin card filter; sort in memory + query keys.
13. **SessionStorage handoff** — `pending-collection.ts` for multi-select → add flow (mirrors `AddCardSchema` exactly).
14. **TDD F-numbers** — behavior changes change the test FIRST; features trace to F-02…F-22.
15. **Design tokens only** — `--color-dojo-*`, square corners, canonical `ArrowRight`.
16. **Rate limiting (`src/lib/utils/rate-limit.ts`)** — Redis-backed fixed-window counter guarding Scrydex credits, the DB pool, and login. `enforceRateLimit(req, tier, identity)` returns a 429 (`Retry-After` header + `{ error:"Too Many Requests", message }`) or `null`. **Keying:** authenticated → user id (`u:<id>`), unauthenticated → client IP (`ip:<ip>`) read from `x-forwarded-for` first hop → `x-real-ip` → `"unknown"` (the app is behind a proxy, so the socket IP is the proxy's). **FAIL-OPEN (RULE 1):** every Redis call is try/caught; any error ALLOWS the request (a cache outage disables limiting, never blocks). **Limited routes:** the five Scrydex-credit routes (recognize/Vision, `[id]/enrich`, `cards/reprice`, `[id]/ebay-sold` POST, `users/me/portfolio/refresh`) per user via `RATELIMIT_CREDIT_PER_MIN` (10/min); `/api/cards/search` per user-or-IP via `RATELIMIT_SEARCH_PER_MIN` (60/min); the Better Auth `sign-in`/`sign-up` POSTs per IP via `RATELIMIT_AUTH_PER_MIN` (10/min). `get-session` (fired on every page) and other auth POSTs (sign-out, OAuth callbacks) are deliberately NOT limited. ponytail ceiling: fixed-window allows a ~2× burst across a window boundary — accepted for an abuse cap.

## 12. Deploy topology

- **Vercel**: cron 03:00 UTC hits `/api/cron/refresh-owned-prices` with `Authorization: Bearer $CRON_SECRET` (the old `/api/cron/sync-cards` 02:00 catalog sync was removed in `bf1eb28`); preview URLs trusted via `*.vercel.app`.
- **Docker**: multi-stage build of `output:"standalone"`; compose adds Redis; healthcheck `/api/health` gates on **Postgres** (503 only when Postgres is unreachable). Redis is cache-only/optional (RULE 1) — a Redis outage yields HTTP 200 `status:"degraded"`, never 503.
- **E2E/Docker asset fix**: `scripts/assemble-standalone.mjs` copies `.next/static` + `public` into the standalone tree (Next doesn't).
