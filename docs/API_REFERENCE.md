# API_REFERENCE.md — exact request/response contracts for all 22 routes

> Base path: `/api`. All JSON. Auth guards come from `src/lib/utils/auth-guard.ts`:
> `requireAuth` → 401 without session; `requireAdmin` → 401/403.
> **Public card/eBay routes degrade gracefully: HTTP 200 with empty/`fallback`
> payloads instead of 5xx** so the UI renders fallback states (AGENTS.md rule 7).

## Quick matrix

| Route | Method(s) | Auth | Zod | Redis | Never-500s? |
|---|---|---|---|---|---|
| `/auth/[...all]` | GET, POST | public (is the handler) | Better Auth internal | — | — |
| `/card-img` (`?u=`) | GET | public | SSRF host allowlist | 24h + SWR | No (400/404/502) |
| `/card-img/[id]` | GET | public | id→DB url + SSRF allowlist | 24h + SWR | No (400/404/502) |
| `/cards/[id]/ebay-sold` | GET, POST | public | — | soldRows 120s | Yes (`listings: []`) |
| `/cards/[id]/enrich` | POST | public | — | — | Yes (always 200 `{enriched}`) |
| `/cards/[id]/history` | GET | public | — | — | Yes (`points: []`) |
| `/cards/[id]/prices` | GET | public | — | — | Yes (`prices: []`) |
| `/cards/[id]/graded` | GET | public | — | — | Yes (`price: null`) |
| `/cards/[id]/population` | GET | public | — | — | Yes (`report: null`) |
| `/cards/recognize` | POST, PATCH | optional session | — | — | Yes |
| `/cards/reprice` | POST | public | — | price 6h | Yes |
| `/cards/search` | GET | public (`ENFORCE_AUTH=false`) | `SearchQuerySchema` | — | No (400/404) |
| `/cards/trending` | GET | public | `TrendingQuerySchema` | trending 120s | No |
| `/collections` | GET, POST | `requireAuth` | `CreateCollectionSchema` (in service) | — | No |
| `/collections/[id]` | PATCH, DELETE | `requireAuth` | service schemas | — | No |
| `/cron/sync-cards` | GET, POST | `CRON_SECRET` | — | — | No |
| `/ebay/marketplace-account-deletion` | GET, POST | public (compliance) | — | — | POST always 200 |
| `/ebay/search` | GET | public | — | search 24h | Yes (fallback 200) |
| `/health` | GET | public | — | ping | 503 degraded |
| `/one-piece-img/[cardId]` | GET | public | regex whitelist | — | No (400/404/502) |
| `/support` | POST | `requireAuth` | `ContactSupportSchema` (in service) | — | 502 delivery |
| `/users/me` | GET, PATCH | `requireAuth` | — | — | PATCH = 501 stub |
| `/users/me/collection` | GET, POST | `requireAuth` | `AddCollectionRequestSchema` | — | Partial |
| `/users/me/collection/[id]` | DELETE | `requireAuth` | — | — | No |
| `/want-list` | GET, POST | `requireAuth` | `AddWantListSchema` (in service) | — | GET → `[]` |
| `/want-list/[id]` | PATCH, DELETE | `requireAuth` | `WantIntentEnum` | — | No |
| `/admin/cards/[id]` | PATCH | `requireAdmin` | inline body schema | — | No |

Error envelope (authed routes): `{ "error": "<Type>", "message": "<human readable>" }`.

---

## Auth

### `GET|POST /api/auth/[...all]`
Better Auth catch-all via `toNextJsHandler(auth)`. Subpaths: `sign-in/email`, `sign-up/email`, `sign-out`, `get-session`, `callback/{provider}` (Google), `request-password-reset`, `reset-password`… Config in `src/lib/auth.ts`: email+password (8–128 chars, no email verification), Google social, 7-day session / 1h roll / 5-min cookie cache.

---

## Cards (public, graceful)

### `POST /api/cards/[id]/ebay-sold` and `POST /api/cards/[id]/enrich` — on-view Scrydex pulls
- Both gated by env `SCRYDEX_ONVIEW_ENABLED=true` (`isScrydexOnViewApproved`, separate from `SCRYDEX_LIVE_CREDITS_APPROVED`). Unset = honest no-op, no Scrydex service called. Always 200, fail-open.
- `ebay-sold` POST (button-gated "Load recent sales"): `{ pulled:boolean, stored?, reason? }` via `pullAndStoreSoldListings`.
- `enrich` POST (fired once on detail-page mount): `{ enriched:boolean, reason?: "unknown"|"disabled"|"fresh" }`; pulls missing history (365d) + PSA population, store-once with 7-day freshness.

### `GET /api/cards/[id]/ebay-sold` — "Recent Sales"
- `[id]` = **externalId** OR internal **cuid** (resolved to `Card.id` via `findFirst OR`). No query params read.
- **PART D — pure Postgres read, NO credit gate:** reads the `SoldListing` table (`where { cardId } orderBy soldAt desc nulls-last take 8`) and maps each row to `{ itemId, source, title, price, currency, soldAt (ISO), grade, company, url }`. 200 `{ listings: SoldRecord[], source: "db"|"cache" }`.
- These are **REAL SOLD records** (`soldAt`), persisted by the owner-approval-gated single writer `pullAndStoreSoldListings` — **never** active listings, never fabricated. Unknown card / no rows → `200 { listings: [] }`.
- **Cache:** short-TTL (120s) read-through on `RedisKeys.soldRows(cardId)` (fail-open; Postgres is source of truth). The legacy `ebay:sold:*` key is **retired** here (ages out on its own TTL). The old Redis-only + credit-gated live-fetch model is removed — reading never spends a credit.

### `GET /api/cards/[id]/history`
- `[id]` = **externalId**. Always `200 { raw: HistoryPoint[], graded: Record<"${company}|${grade}", HistoryPoint[]> }` where `HistoryPoint = { date: "YYYY-MM-DD", price: number }`, each series oldest→newest, sourced from stored `PricingHistory` (real `scrydex` / `add-snapshot` points — never fabricated; `scrydex-trend` retired). A row with `type==="graded"` **and** both `company` + `grade` lands under `graded["${company}|${grade}"]` (e.g. `"PSA|10"`); everything else is `raw`. Rows with `priceMarket == null` are **dropped** (NFR-2 — no fabricated `$0` point). Payload is Zod-parsed before send; the `cardHistory(externalId)` Redis read-through is re-`safeParse`d on read, so a stale OLD-shape `{points}` blob fails the parse and falls through to Postgres (fail-open; cache key version **not** bumped). Unknown card / DB error → `{ raw: [], graded: {} }`. `Cache-Control: no-store`.

### `GET /api/cards/[id]/prices`
- `[id]` = **externalId**. 200 `{ prices: CurrentPrice[] }` — the stored current prices for the card. **Full capture (C1):** one row per `source`/`currency`/`variant`/`condition`/`company`/`grade`/`type` — all raw conditions (`type:"raw"`, `company`/`grade` null) plus all graded entries (`type:"graded"`, `condition:"GRADED"`, uppercased `company`, verbatim `grade` incl `8.5`/`9Q`). New columns flow through verbatim (no route change). Unknown card **and** any thrown error → `{ prices: [] }` + 200 (NFR-4 — public card route never 4xx/5xx; UI renders "—"). `Cache-Control: no-store`.

### `GET /api/cards/[id]/graded` — PSA graded price (FR-6)
- `[id]` = **externalId**. Query: `grade?` (default `"10"`; accepts `"PSA 10"`/`"10"`/`10`). `game` is read from DB `Card.game` (NFR-3), never the query string.
- 200 `{ price: number|null, isStale: boolean, isFallback: boolean }`.
  - `isFallback: false` → a **live Scrydex PSA** market for the requested grade.
  - `isFallback: true` → the curated graded-price table / coarse multiplier (no live quote this call).
- Routes the Scrydex fetch through `pullAndStoreScrydexPrice(card, { force: false })` so it obeys the SAME 24h freshness gate + `SyncLog` credit metering + `Card.scrydexId` write-back as every other Scrydex caller — a repeat public view within `SCRYDEX_STALE_MS` short-circuits (no HTTP, no credit) and serves the curated fallback (graded prices are not persisted; only raw is).
- Unknown card, unpriced card (`marketPrice == null`), or any thrown error → `{ price: null, isFallback: true, isStale: true }` + 200 (NFR-4). `Cache-Control: no-store`.

### `GET /api/cards/[id]/population`
- `[id]` = **externalId** (or cuid). 200 `{ report: { source: "scrydex", companies: [{ company: "PSA", language: "English", total, gradeTotal, qualifiedGradeTotal, halfGradeTotal, grades: [{ grade, count }] }], refreshedAt }, bgsSupported: false }` or `{ report: null, bgsSupported: false }` (still 200). **PSA English ONLY, never fabricated** — pure read of the stored `PopulationReport`; null until a manual owner-approval-gated Scrydex refresh persists data. BGS unavailable. **Full ladder (C3):** the stored `grades` JSON is a widened object carrying the per-grade array (incl half `8.5` / qualified `9Q`) + the three ladder sub-totals (`gradeTotal`/`qualifiedGradeTotal`/`halfGradeTotal`, null when the source omitted them); a legacy bare `{grade,count}[]` blob still reads back with null ladder totals (back-compat). `Cache-Control: private, max-age=86400`.

### `POST /api/cards/recognize` — scanner OCR + ranking
- Body: `{ image?: base64 (Vision), text?: pre-extracted OCR, game?: "pokemon"|"onepiece", source?: "tesseract"|"manual" }`. Invalid JSON → 400.
- Vision unavailable → `200 { success: true, candidates: [], ocrSource: "unavailable", feedbackId: null }` (client-side tesseract signal).
- 200 `{ success: true, candidates: [{ id, name, set, imageUrl, confidence }], feedbackId, ocrSource: "vision"|"tesseract"|"manual" }`. Top 5; DB prefilter ≤500 rows; errors never 500.
- Optional `language`: `"all"|"en"|"ja"` (absent = `"all"`; old bodies unchanged). Invalid value → `400 { success: false, error: "invalid-language" }`. Success responses echo `language` and `languageApplied: false` — `Card` has no language column and OCR is not language-restricted, so it is validated and echoed only, never used to filter.

### `PATCH /api/cards/recognize` — feedback label
- Body `{ feedbackId, pickedCardId }` → always `200 { success: true }` (best-effort `ScanFeedback.pickedCardId` update).

### `POST /api/cards/reprice` — background price refresh
- Body `{ externalIds: string[] }` (cap 20). 200 `{ prices: { [externalId]: number } }` — only successful ids; failures skipped silently. Flow: Redis `price:card:*` 6h → live pokemontcg.io (6s timeout) → `pickPokemonMarketPrice` → cache + `Card.marketPrice`/`lastPricedAt` write.

### `GET /api/cards/search`
- Query (zod `SearchQuerySchema`): `game` (required, `pokemon|onepiece`), `query` (required, 1–100), `sort?` (`CardSortEnum`; **omitted or `trending` = relevance ranking**, any other key overrides it and keeps the DB order), `set?`, `rarity?`, `graded?` (`graded|ungraded`), `minPrice?`, `maxPrice?`, `language?` (`en|ja|all`, default `all`).
- **Language filter**: there is no language column — language is inferred from the `externalId`. Japanese cards contain the literal substring `_ja-` (e.g. `bw1b_ja-3`); English/other cards do not. `ja` → `contains "\_ja-"` (underscore escaped so LIKE matches it literally, not as a wildcard); `en` → `NOT contains`; `all`/omitted → no predicate. "English" therefore means non-Japanese (other languages are lumped in). ponytail: filtered LIKE scan on `externalId`; upgrade = expression index or generated `isJapanese` column.
- 200 `{ cards: NormalizedCard[], source: "local-db" }` — `NormalizedCard = { id, name, number, setImage, rarity, hp: null, types, imageUrl, marketPrice: number|null }`, `take: 60` (no pagination). Relevance order: exact `externalId` (`mee-16` = `mee 16`) > exact number+set code > exact name > name prefix > all-token match (name > set > rarity/tags) > name/set-name typo (never for identifier queries); ties by `externalId` asc. OP imageUrl = first of `onePieceImageChain()`.
- 400 zod issues; 404 `{ source: "local-db" }` when zero local matches ("daily sync may not have reached this set yet"). `Cache-Control: public, max-age=30, swr=300`.

### `GET /api/cards/trending`
- Query (zod): `limit` (1–50, default 10), `cursor` (**offset**, not keyset), `game?`, `sort` (default `trending`).
- 200 `{ cards: [{ id, externalId, name, setImage, imageUrl, imageChain?, price, rarity, delta: null, up: null }], nextCursor: number|null }`.
- `sort=trending` page 1 = curated: `userCollection.groupBy` adds in last 7 days, `_count desc`, backfilled by `updatedAt desc`. `delta`/`up` always null (never fabricated). Redis `card:trending:*` 120s.

---

## Collections & want list (authed CRUD)

### `GET /api/collections` → 200 `{ data: Collection[] }` (`createdAt desc`, `no-store`).
- F-#8: each entry carries `buckets: { main, all, buy, sell, sold }`. UNITS DIFFER: `main`/`all`/`sold` = summed QUANTITIES (`_sum.quantity`); `buy`/`sell` = ROW COUNTS (`_count._all`). A trailing `{ id: "__uncat__", buckets }` pseudo-collection carries the loose (`collectionId=null`) counts. Degradation (rule 7/8): a `groupBy` hiccup → every collection's `buckets` ZEROED (always present, never omitted); a base `findMany` failure → 200 `{ data: [] }`.
### `POST /api/collections`
- Body `{ name, isPrivate? = true, typeTag? = "MIXED" }`. 201 `{ data: Collection }`; 400 zod; 409 duplicate name (`P2002` on `@@unique([userId,name])`). FEAT-004: 409 `MainCollectionProtectedError` when `name` is "Main" in any case/spacing and the user already has a Main (Main is created lazily by the first add, see below).

### `PATCH /api/collections/[id]`
- Body `{ name? }` and/or `{ isPrivate?, typeTag? }` (at least one, else 400). 200 `{ data }`; 404 foreign/nonexistent id (P2025 — no existence leak); 409 (duplicate name, or FEAT-004 Main protected: Main cannot be renamed or have privacy/tag changed); 400.

### `DELETE /api/collections/[id]` → 200 `{ data: { id } }`; 404; 409 if the collection is the protected Main (FEAT-004). (Cards unfile, not deleted — SetNull.)

### `GET /api/want-list` — Query `intent?` (`BUY|SELL|TRADE`; invalid silently ignored → all) + F-#8 `collectionId?`.
- `collectionId=<id>` → that collection; `collectionId=__account__` → account-level (`null`) rows; ABSENT → all scopes.
- 200 `{ data: [{ id, userId, cardId /* EXTERNAL id */, intent, collectionId, createdAt, name?, imageUrl?, marketPrice?, setName? }] }` — display fields null when card not in local catalog. DB error → 200 `{ data: [] }`. `no-store`.

### `POST /api/want-list` — Body `{ cardId /* externalId */, intent, collectionId? }`. Idempotent find-or-create per `(userId, cardId, intent, collectionId)` (null scope matches by IS NULL). 201 `{ data: item }` (a concurrent `P2002` on `wli_scope_coalesced` is re-read → same idempotent 201, NEVER a 409); 400; 404 if a non-null `collectionId` isn't owned by the user (ownership guard — no existence leak).

### `PATCH /api/want-list/[id]` — Body `{ intent, collectionId? }` (move tab and/or re-scope collection; omitting `collectionId` changes only intent). 200; 404 (foreign item id OR non-owned target `collectionId`); 409 collision on `wli_scope_coalesced` (`P2002`).

### `DELETE /api/want-list/[id]` → 200 `{ data: { id } }`; 404.

---

## User collection (the add funnel)

### `GET /api/users/me/collection`
- 200 `{ items: [{ id, cardId, quantity, condition, notes, isFoil, purchasePrice, collectionId, addedAt, updatedAt, card: { id, externalId, name, number, rarity, imageUrl, imageUrlHi, marketPrice, weeklyChangePct, weeklyChangeAbs, set: { id, name } } }] }` ordered `addedAt desc`. `weeklyChangeAbs/Pct` (FEAT-003) are the stored real Scrydex 7-day change (`null` until a priced pull; portfolio sorts them last) and drive the portfolio "7-day change" sort.

### `POST /api/users/me/collection` — bulk add (F-15)
- Body (`AddCollectionRequestSchema`): `{ cards: [{ externalId, name, setName?, imageUrl?, rarity?, types?, marketPrice?, quantity = 1 (1–999), isFoil = false, condition?, purchasePrice?, collectionId? }] }` — 1–50 cards, plus FEAT-004 top-level `collectionId?` and `onExisting? = "increment" | "skip"`.
- **FEAT-004 destination rules:** items are de-duplicated by `externalId` (first wins; `assignBulkAddOrder` runs over the deduped list, so `addedAt` stays strictly decreasing in selection order). Destination per item = its own `collectionId`, else the top-level `collectionId`, else the user's **Main** (resolved lazily via `getOrCreateMainCollection`; new adds never write `collectionId: null`). A non-owned per-item id is coerced to Main (no leak); a non-owned **top-level** `collectionId` → **404 `{ error: "Not Found" }` with ZERO writes**. `onExisting: "skip"` leaves an existing variant untouched and counts it in `alreadyPresent`.
- Flow: `assignBulkAddOrder` (selection-order `addedAt` stamps) → per card: upsert `CardSet` (`user-added-<slug>`) → upsert `Card` by `externalId` → find-or-create `UserCollection` matched on the SAME key as the DB index `uc_variant_coalesced` — `(userId, collectionId ?? null, cardId, isFoil, COALESCE(condition,''))` with `isSold=false` (**re-add of the same variant increments quantity**; F-#8: app-side compare uses EXACT normalized `condition`, so raw `null` vs raw `"NM"` vs `"PSA 10"` are distinct lots). A concurrent `P2002` on `uc_variant_coalesced` is caught per-card → re-read + increment (`ok:true`), never a failed card. `purchasePrice` defaults `?? marketPrice ?? card.marketPrice`.
- **FR-5 add-snapshot:** after each successful add of a **priced** card (`marketPrice ?? card.marketPrice` non-null **and** `> 0`), writes ONE `PricingHistory` point `{ source: "add-snapshot", variant: "normal", condition: "NM", currency: "USD" }` so the portfolio graph has a real datapoint from the moment of add. Best-effort (try/catch — a snapshot failure never fails the add); a null/zero price writes **no** row (NFR-2 — never a fabricated `$0`).
- 200 `{ added, alreadyPresent, invalid, total, results: [{ externalId, ok: true, alreadyPresent? } | { externalId, ok: false, error }] }` (`added` = created/incremented lots, `invalid` = failed items); 400 zod/JSON; 404 foreign top-level `collectionId`; 500 only if EVERY item failed. Invalidates `collection`, `dashboard`, `collections` when `added > 0`.

### `PATCH /api/users/me/collection/[id]` — `[id]` = UserCollection row id, ownership-scoped.
- Body (`UpdateCollectionItemSchema`): `{ quantity?, purchasePrice?, condition?, collectionId?, isSold?, soldPrice?, soldQuantity?, soldAt? }`. Mark-as-sold splits/updates the lot (preserving `collectionId`); the general-update branch may re-file a lot into another collection.
- F-#8 (re-file path): a non-null target `collectionId` must be owned by the user → 404 on miss (cross-user attach guard, no existence leak); a re-file/edit that collides with an existing variant in the target collection trips `uc_variant_coalesced` → **409 "That variant is already in the target collection"** (not a raw 500). 200 `{ ok: true, item }`; 400 zod/JSON.

### `DELETE /api/users/me/collection/[id]` — `[id]` = UserCollection row id, ownership-scoped (`deleteMany where { id, userId }`). 200 `{ ok: true }`; 404 (foreign = nonexistent); 500. Removes only that owned row (the catalog `Card` is untouched). FEAT-004: also invalidates the `collections` cache scope (bucket counts), besides `collection` + `dashboard`.

---

## Profile & support

### `GET /api/users/me` — 200 `{ data: { id, name, email, emailVerified, phoneNumber, phoneNumberVerified, image, isAdmin, createdAt, updatedAt } }` (`no-store`; re-reads DB because cookie cache may be 5-min stale). 404 if user record gone.
### `PATCH /api/users/me` — **501 stub** (`"coming in Week 2"`).

### `POST /api/support`
- Body (service zod): `{ name ≤120, email, subject ≤160, message ≤5000 }` (all trimmed, min 1).
- 201 `{ data: { ticketId } }`; 400 validation; 502 delivery error; 400 invalid JSON.

---

## eBay

### `GET /api/ebay/search` — price comparison
- Query: `name` (required; legacy `?q=` → `game=pokemon` + deprecation warn), `set?`, `number?`, `game` (required `pokemon|onepiece`).
- 200 `{ listings: [{ itemId, title, price, currency, imageUrl, itemWebUrl }], source: "cache"|"live" }`. Missing/invalid params → `400 { error, fallback: true, listings: [] }`; eBay failure → **200** `{ error: "eBay unavailable", fallback: true, listings: [] }`. Redis 24h.

### `GET|POST /api/ebay/marketplace-account-deletion` — eBay compliance, public by design
- GET: `?challenge_code` required → 200 `{ challengeResponse: sha256(challenge_code + EBAY_MARKETPLACE_DELETION_TOKEN + EBAY_MARKETPLACE_DELETION_ENDPOINT) }`; 400 missing code; 500 unconfigured.
- POST: deletion notification → **always 200 `{ received: true }`** (non-2xx triggers eBay retry storm). No eBay PII stored today.

---

## Admin

### `PATCH /api/admin/cards/[id]` — `[id]` = **internal** Card id
- Body (inline zod): `{ marketPrice?: number ≥0 ≤1e9 | null, imageUrl?: url ≤2048 | null }` — at least one (refine). `lastPricedAt` refreshed when price sent.
- Side effect: `writeAuditLog` (action `card.update`, before/after `details`).
- 200 `{ card: { id, name, marketPrice, imageUrl, lastPricedAt } }`; 400; 401; 403; 404; 500.

---

## Ops

### `GET|POST /api/cron/sync-cards`
- Auth: `Authorization: Bearer $CRON_SECRET` or `?secret=`, `timingSafeEqual`; **unauthenticated when `CRON_SECRET` unset (local dev)**. `runtime="nodejs"`, `dynamic="force-dynamic"`, `maxDuration=300` (sync self-budgets 250s).
- 200 `{ ok: true, summary: { startedAt, finishedAt, durationMs, setsConsidered, setsProcessed, cardsUpserted, perSet: [{ game, sourceSetId, setName, cardsUpserted, durationMs, skipped?, error? }], errors } }`; zero-processed is still ok. 500 `{ ok: false, error }` on fatal.

### `GET /api/health` — Docker healthcheck
- Readiness gates on **Postgres only** (the source of truth). 200 `{ status: "ok", timestamp, services: { app: "ok", postgres: "ok", redis: "ok" } }` when both reachable. Redis is cache-only/optional (RULE 1) and NEVER gates readiness → Redis unreachable is **still 200** `{ status: "degraded", services: { postgres: "ok", redis: "unreachable" } }`. Postgres unreachable → **503** `{ status: "error", services: { postgres: "unreachable" } }`.

### `GET /api/card-img` + `GET /api/card-img/[id]` — Pokémon card-art same-origin proxies

- **Why two routes:** both front the Pokémon art CDNs with a same-origin, SSRF-safe, edge-cached proxy (anti-hotlink + 24h+SWR cache). The SSRF guard is shared (`src/app/api/card-img/ssrf.ts`): https-only, no credentials, **exact-host** allowlist Set (`images.scrydex.com`, `assets.tcgdex.net`, `images.pokemontcg.io` — never a substring), `redirect:"manual"`, `image/*` only.
- **`?u=<encoded url>` (legacy):** the url comes from the client, so the upstream host is visible in the query string. Kept as the fallback for live-search cards without a stored DB row.
- **`/[id]` (preferred — hides the source):** `[id]` is the catalog **externalId** (AGENTS.md rule 3; falls back to internal cuid). Resolves `Card.imageUrl` (or `imageUrlHi` when `?hi=1`, falling back to `imageUrl`) **server-side**, so the browser only ever sees `/api/card-img/<id>` — `images.scrydex.com` appears neither in the request nor the page URL. The DB-sourced url STILL passes the SSRF allowlist (defense in depth → disallowed stored host = 400). Unknown id / no stored url = 404; non-image or redirecting upstream = 404; fetch error = 502. `Cache-Control: public, max-age=86400, stale-while-revalidate=604800`. The client builds this via `cardImgById()` + `CardImage`'s `cardId` prop; detail-page links no longer carry `img=<raw url>`.

### `GET /api/one-piece-img/[cardId]` — Bandai CDN same-origin proxy
- `[cardId]` must match `/^((?:OP|ST|EB|PRB)\d{2}-\d{3}|P-\d{3})$/` (whitelist — prevents open proxy) else 400.
- Upstream `https://en.onepiece-cardgame.com/images/cardlist/card/{id}.png` fetched `force-cache`; 200 streams bytes with upstream Content-Type; 404 upstream miss; 502 fetch error. Why: Bandai sends `Cross-Origin-Resource-Policy: same-site` → browser `<img>` blocked; same-origin re-serve fixes it. `Cache-Control: public, max-age=86400, swr=604800`.
