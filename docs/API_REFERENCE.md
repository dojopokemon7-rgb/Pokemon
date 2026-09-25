# API_REFERENCE.md — exact request/response contracts for all 22 routes

> Base path: `/api`. All JSON. Auth guards come from `src/lib/utils/auth-guard.ts`:
> `requireAuth` → 401 without session; `requireAdmin` → 401/403.
> **Public card/eBay routes degrade gracefully: HTTP 200 with empty/`fallback`
> payloads instead of 5xx** so the UI renders fallback states (AGENTS.md rule 7).

## Quick matrix

| Route | Method(s) | Auth | Zod | Redis | Never-500s? |
|---|---|---|---|---|---|
| `/auth/[...all]` | GET, POST | public (is the handler) | Better Auth internal | — | — |
| `/cards/[id]/ebay-sold` | GET | public | — | sold 1h | Yes |
| `/cards/[id]/history` | GET | public | — | — | Yes (`points: []`) |
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

### `GET /api/cards/[id]/ebay-sold` — "Sellers on the Floor"
- `[id]` = **externalId** (cache key; doubles as Bandai code for OP). Query: `name` (**required**), `set?`, `number?`, `game?` (default `pokemon`).
- 200 `{ listings: [{ itemId, sellerUsername, price, currency, location, itemWebUrl, title }], source: "cache"|"live" }`.
- Missing name → `200 { listings: [], error: "Missing card name" }`; eBay failure → `200 { listings: [], error: "eBay unavailable" }`.
- **ACTIVE listings, not sold history** (Browse API limitation). Redis `ebay:sold:*` 1h.

### `GET /api/cards/[id]/history`
- `[id]` = **externalId**. Always `200 { points: [{ date: "YYYY-MM-DD", price: number }] }` oldest→newest; unknown card / DB error → `{ points: [] }` (client falls back to mock chart). `Cache-Control: no-store`.

### `GET /api/cards/[id]/population`
- `[id]` ignored today. 200 `{ report: { source: "psa"|"reference", companies: [{ company: "PSA"|"BGS", total, grades: [{ grade, count }] }] } }` or `{ report: null }` (still 200). Deterministic reference data. `Cache-Control: private, max-age=86400`.

### `POST /api/cards/recognize` — scanner OCR + ranking
- Body: `{ image?: base64 (Vision), text?: pre-extracted OCR, game?: "pokemon"|"onepiece", source?: "tesseract"|"manual" }`. Invalid JSON → 400.
- Vision unavailable → `200 { success: true, candidates: [], ocrSource: "unavailable", feedbackId: null }` (client-side tesseract signal).
- 200 `{ success: true, candidates: [{ id, name, set, imageUrl, confidence }], feedbackId, ocrSource: "vision"|"tesseract"|"manual" }`. Top 5; DB prefilter ≤500 rows; errors never 500.

### `PATCH /api/cards/recognize` — feedback label
- Body `{ feedbackId, pickedCardId }` → always `200 { success: true }` (best-effort `ScanFeedback.pickedCardId` update).

### `POST /api/cards/reprice` — background price refresh
- Body `{ externalIds: string[] }` (cap 20). 200 `{ prices: { [externalId]: number } }` — only successful ids; failures skipped silently. Flow: Redis `price:card:*` 6h → live pokemontcg.io (6s timeout) → `pickPokemonMarketPrice` → cache + `Card.marketPrice`/`lastPricedAt` write.

### `GET /api/cards/search`
- Query (zod `SearchQuerySchema`): `game` (required, `pokemon|onepiece`), `query` (required, 1–100), `sort` (`trending|market_desc|market_asc|name_asc|recent`, default `market_desc`), `set?`, `rarity?`, `graded?` (`graded|ungraded`), `minPrice?`, `maxPrice?`.
- 200 `{ cards: NormalizedCard[], source: "local-db" }` — `NormalizedCard = { id, name, number, setImage, rarity, hp: null, types, imageUrl, marketPrice: number|null }`, `take: 60`. OP imageUrl = first of `onePieceImageChain()`.
- 400 zod issues; 404 `{ source: "local-db" }` when zero local matches ("daily sync may not have reached this set yet"). `Cache-Control: public, max-age=30, swr=300`.

### `GET /api/cards/trending`
- Query (zod): `limit` (1–50, default 10), `cursor` (**offset**, not keyset), `game?`, `sort` (default `trending`).
- 200 `{ cards: [{ id, externalId, name, setImage, imageUrl, imageChain?, price, rarity, delta: null, up: null }], nextCursor: number|null }`.
- `sort=trending` page 1 = curated: `userCollection.groupBy` adds in last 7 days, `_count desc`, backfilled by `updatedAt desc`. `delta`/`up` always null (never fabricated). Redis `card:trending:*` 120s.

---

## Collections & want list (authed CRUD)

### `GET /api/collections` → 200 `{ data: Collection[] }` (`createdAt desc`, `no-store`).
### `POST /api/collections`
- Body `{ name, isPrivate? = true, typeTag? = "MIXED" }`. 201 `{ data: Collection }`; 400 zod; 409 duplicate name (`P2002` on `@@unique([userId,name])`).

### `PATCH /api/collections/[id]`
- Body `{ name? }` and/or `{ isPrivate?, typeTag? }` (at least one, else 400). 200 `{ data }`; 404 foreign/nonexistent id (P2025 — no existence leak); 409; 400.

### `DELETE /api/collections/[id]` → 200 `{ data: { id } }`; 404. (Cards unfile, not deleted — SetNull.)

### `GET /api/want-list` — Query `intent?` (`BUY|SELL|TRADE`; invalid silently ignored → all).
- 200 `{ data: [{ id, userId, cardId /* EXTERNAL id */, intent, createdAt, name?, imageUrl?, marketPrice?, setName? }] }` — display fields null when card not in local catalog. DB error → 200 `{ data: [] }`. `no-store`.

### `POST /api/want-list` — Body `{ cardId /* externalId */, intent }`. Idempotent upsert. 201 `{ data: item }`; 400.

### `PATCH /api/want-list/[id]` — Body `{ intent }` (move tab). 200; 404; 409 already-in-target (`P2002`).

### `DELETE /api/want-list/[id]` → 200 `{ data: { id } }`; 404.

---

## User collection (the add funnel)

### `GET /api/users/me/collection`
- 200 `{ items: [{ id, cardId, quantity, condition, notes, isFoil, purchasePrice, collectionId, addedAt, updatedAt, card: { id, externalId, name, number, rarity, imageUrl, imageUrlHi, marketPrice, set: { id, name } } }] }` ordered `addedAt desc`.

### `POST /api/users/me/collection` — bulk add (F-15)
- Body (`AddCollectionRequestSchema`): `{ cards: [{ externalId, name, setName?, imageUrl?, rarity?, types?, marketPrice?, quantity = 1 (1–999), isFoil = false, condition?, purchasePrice?, collectionId? }] }` — 1–50 cards.
- Flow: `assignBulkAddOrder` (selection-order `addedAt` stamps) → per card: upsert `CardSet` (`user-added-<slug>`) → upsert `Card` by `externalId` → upsert `UserCollection` on `[userId, cardId, isFoil]` (**re-add increments quantity**); `purchasePrice` defaults `?? marketPrice ?? card.marketPrice`.
- 200 `{ added, total, results: [{ externalId, ok: true } | { externalId, ok: false, error }] }`; 400 zod/JSON; 500 only if EVERY card failed.

### `DELETE /api/users/me/collection/[id]` — `[id]` = UserCollection row id, ownership-scoped. 200 `{ ok: true }`; 404; 500.

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
- 200 `{ status: "ok", timestamp, services: { app: "ok", redis: "ok" } }`; Redis unreachable → **503** `{ status: "degraded", services: { redis: "unreachable" } }` (the only place Redis affects status).

### `GET /api/one-piece-img/[cardId]` — Bandai CDN same-origin proxy
- `[cardId]` must match `/^((?:OP|ST|EB|PRB)\d{2}-\d{3}|P-\d{3})$/` (whitelist — prevents open proxy) else 400.
- Upstream `https://en.onepiece-cardgame.com/images/cardlist/card/{id}.png` fetched `force-cache`; 200 streams bytes with upstream Content-Type; 404 upstream miss; 502 fetch error. Why: Bandai sends `Cross-Origin-Resource-Policy: same-site` → browser `<img>` blocked; same-origin re-serve fixes it. `Cache-Control: public, max-age=86400, swr=604800`.
