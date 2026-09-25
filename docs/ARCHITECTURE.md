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
GET /api/cards/search (game, query, sort, set?, rarity?, graded?, minPrice?, maxPrice?)
  → reads ONLY local Postgres (take 60) — external APIs are NEVER hit per keystroke
  → filters: set.externalId startsWith "{game}-", set name equals-insensitive,
    rarity contains, graders regex (PSA|BGS|CGC|SGC|Beckett), price range,
    text = OR(name, number, tags has q, set.name contains, set.externalId contains)
  → orderByForCardSort(sort)
  → One Piece images → onePieceImageChain() (stored → storedHi → same-origin proxy)
```
The `card.service.searchCards` fallback chain (pokemontcg.io → tcgdex → scrydex; apitcg → cardmarket) exists for the service-level path and is Zod-normalized (`NormalizedCardSchema`), Redis-cached 24h, circuit-broken.

### 4.3 Price pipeline

- `Card.marketPrice` = snapshot cache, refreshed by sync / reprice / backfill / snapshot scripts; `lastPricedAt` = staleness clock (graded-price staleness = 7 days).
- `POST /api/cards/reprice` (public, ≤20 ids): Redis `price:card:{id}` 6h → live pokemontcg.io fetch (6s timeout) → `pickPokemonMarketPrice` → cache write + `Card.marketPrice` update. Fired by the search page in the background for unpriced tiles — deliberately OFF the search hot path.
- `PricingHistory` rows are written ONLY by scripts (`snapshot-pokemon-prices.ts` daily idempotent rows, `seed-pricing-history.ts`, `backfill-prices.ts` anchors). Real history exists for 10 harness cards; dashboard charts are synthetic PRNG shapes (honest stub), card-detail charts use real points when present.
- Graded pricing (F-17): `fetchPSAGradedPrice` verifies grade via PSA public cert API (verification only, no price guide) → `getGradedPrice` curated 20-entry table / `{8:1.2, 9:1.5, 10:2.5}` multipliers (strictly increasing so grade hierarchy never inverts) → `resolveGradedPrice` flags `isFallback`/`isStale`.

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
The feedback table is the ground-truth dataset for re-tuning `WEIGHTS` — measured, never guessed.

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
| `ebay:sold:{id\|name\|set\|number\|game}` | 1h | `/api/cards/[id]/ebay-sold` |
| `price:card:{externalId}` | 6h | `/api/cards/reprice` |
| `card:trending:{game\|all}:{sort}:{limit}:{offset}` (built inline in route) | 120s | `/api/cards/trending` |
| `circuit_breaker:fail:{name}` / `circuit_breaker:{name}` | 600s | `fallback-executor` |
| `otp:{phone}` / `otp:rate:{phone}` | 600s / 3600s | phone plugin (disabled MVP) |

**Every** Redis read/write is individually try/caught → outage falls through to live data. Non-fatal `[Redis] … falling through` logs in dev are expected. `redis` is a lazy Proxy so `next build` never needs `REDIS_URL`.

### 6.2 Circuit breaker + fallback chain

`executeWithFallback(tasks)` runs ordered sources; each task gets a 5s `Promise.race` timeout. **`NoResultsError` = "healthy but no match"** → advance to next source WITHOUT counting a failure. Real failures count: 3 consecutive → breaker opens 600s → source is skipped (half-open retry after TTL). Breaker itself is fail-open (Redis down = attempt anyway).

### 6.3 HTTP cache headers

- `/api/cards/search`: `public, max-age=30, stale-while-revalidate=300`
- `/api/cards/trending`: `private, max-age=30, swr=120`
- `/api/cards/[id]/population`: `private, max-age=86400`
- `/api/one-piece-img/[cardId]`: `public, max-age=86400, swr=604800` (upstream fetch `force-cache`)
- collection/want-list/users-me GETs: `no-store`
- `/api/cron/sync-cards`: `force-dynamic`

## 7. TanStack Query key registry (client)

| Key | Fetch | Notes |
|---|---|---|
| `["collection"]` | `GET /api/users/me/collection` | DashboardClient with SSR `initialData`; `/you` |
| `["portfolio-collection"]` | same endpoint | portfolio page; both keys prefetched by shell on nav hover |
| `["want-list", "all"\|"BUY"\|"SELL"\|"TRADE"]` | `GET /api/want-list(?intent=)` | whole family invalidated by any want-list mutation |
| `["collections"]` | `GET /api/collections` | AddCardSheet, portfolio filter, CollectionsSection |
| `["trending-cards", game, sort]` | `GET /api/cards/trending` | **infinite query**, offset cursor |
| `["card-search", game, q, sort, set, rarity, graded, minPrice, maxPrice]` | `GET /api/cards/search` | enabled only when q non-empty |
| `["search-suggest", game, q]` | same route | autocomplete, staleTime 60s |
| `["card-multi", game, q]` | search or trending (normalized) | `/search/multi` |
| `["card-history", id]` | `GET /api/cards/[id]/history` | staleTime 60s |
| `["population", id]` | `GET /api/cards/[id]/population` | staleTime 24h |
| `["ebay-sold", id, name, set, rarity, number, game]` | `GET /api/cards/[id]/ebay-sold` | staleTime 1h (matches server cache) |
| `["linked-accounts"]` | `authClient.listAccounts()` | `/you` |

**Invalidation map:** add-to-collection → `["collection"]` + `["portfolio-collection"]`; want-list add/remove/move → whole `["want-list"]`; bulk delete → `["portfolio-collection"]` + `["collection"]`; admin card PATCH → no query invalidation (RSC `router.refresh()`).

## 8. Data model (Prisma)

```
User 1─n Session / Account / UserCollection / Collection / SupportTicket / WantListItem
CardSet 1─n Card
Card 1─n UserCollection (unique [userId, cardId, isFoil] — re-add increments quantity)
      1─n PricingHistory
Collection 1─n UserCollection (collectionId nullable, onDelete: SetNull — deleting a
             collection unfiles cards, never deletes owned copies)
UserCollection.purchasePrice = what the user paid (distinct from Card.marketPrice)
WantListItem.cardId = EXTERNAL id string (NOT a FK — a card can be wanted pre-sync)
AuditLog, ScanFeedback: append-only operational tables
```
Indexes worth knowing: `Card.@@index([updatedAt])` (trending), `Card.@@index([tags], type: Gin)` (`has` search), `CardSet.@@index([name])` (set filter), `PricingHistory.@@index([cardId, recordedAt])` (history chart). Graded metadata lives in `UserCollection.condition` ("PSA 10") + `Card.rarity` — dedicated columns are the planned migration.

## 9. External API inventory

| API | Used by | Auth env | Fallback chain position |
|---|---|---|---|
| pokemontcg.io `/v2` | card.service, sync, pokemon-price, reprice | `POKEMON_TCG_API_KEY` (optional) | Pokémon source 1 (sync + price source) |
| tcgdex | card.service | none | Pokémon source 2 |
| scrydex | card.service | none | Pokémon source 3 |
| apitcg | card.service (OP search), sync (OP) | `APITCG_API_KEY` (required) | One Piece source 1 |
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
| `GOOGLE_CLIENT_ID/SECRET` | prod | `test` fallbacks keep routes alive in dev |
| `CRON_SECRET` | prod! | unset = sync route unauthenticated (local dev only) |
| `POKEMON_TCG_API_KEY` | no | raises rate limit to 20k/day |
| `APITCG_API_KEY` | for One Piece | x-api-key header |
| `EBAY_CLIENT_ID/SECRET` | for eBay | client-credentials |
| `EBAY_API_URL` | no | defaults **sandbox** |
| `EBAY_MARKETPLACE_DELETION_TOKEN/_ENDPOINT` | prod (eBay compliance) | challenge hash inputs |
| `GOOGLE_VISION_API_KEY` | no | absent → tesseract.js fallback |
| `PSA_API_KEY` | no | absent → curated graded table |
| `TCGCOLLECTOR_API_KEY`, `TCGCOLLECTOR_API_BASE`, `CARDMARKET_APP_TOKEN` | no | clean One Piece images |
| `SMS_PROVIDER_*` | no | OTP plugin disabled MVP |
| `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY` | no | client base URL / future uploads |
| `ADMIN_INITIAL_PASSWORD` | for create-admin script | |

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

## 12. Deploy topology

- **Vercel**: cron 02:00 UTC hits `/api/cron/sync-cards` with `Authorization: Bearer $CRON_SECRET`; preview URLs trusted via `*.vercel.app`.
- **Docker**: multi-stage build of `output:"standalone"`; compose adds Redis; healthcheck `/api/health` (503 when Redis unreachable — the ONLY place Redis affects status).
- **E2E/Docker asset fix**: `scripts/assemble-standalone.mjs` copies `.next/static` + `public` into the standalone tree (Next doesn't).
