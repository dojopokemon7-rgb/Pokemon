# Design Document — Scrydex Migration

## Overview

This design migrates Dojo to Scrydex as the authoritative source for Pokémon/One Piece
catalog data and RAW/PSA/BGS price history, and hardens the four product areas that
consume that data (scanner, portfolio sales/accounting, search/detail, dashboard/
collections/onboarding). It is **brownfield**: a partial Scrydex integration already
exists (`scrydex.service.ts`, `scrydex-pricing.service.ts`, `Card.scrydexId`,
`PricingHistory`/`CurrentPrice`/`SyncLog`, the `DataSource` enum, the PokéWallet
pricing-only client, the Vision scanner, the `UserCollection.isSold/soldPrice/soldAt/
purchasePrice` scaffolding). The design grounds every change in that existing code and
the AGENTS.md invariants.

The work is sequenced behind **Checkpoint A: a read-only audit** that produces an
`Audit_Report` artifact gating all implementation. Implementation then proceeds in
dependency-ordered, individually-reviewable phases (Checkpoints B–D), each shipping docs,
tests, and a green `npm run verify`.

Language for all code examples: **TypeScript** (the repo language). Schema deltas are
Prisma; API contracts show Zod + JSON.

### Guiding invariants (AGENTS.md §5, carried into every change)

1. Redis is an optional accelerator — every read/write try/caught, fail-open, re-Zod on read.
2. Never fabricate: a missing real value stays `null` → UI "—". **The `scrydex-trend`
   derived backfill is removed** (it fabricated/interpolated history).
3. Three distinct ids: `Card.id` (cuid) vs `Card.externalId` (catalog id) vs
   `Card.scrydexId` (Scrydex-native). Never cross them.
4. Zod at every boundary (external payload, cache read, request body); 0-valid-card
   response → `NoResultsError` so the fallback chain advances without tripping the breaker.
5. Ownership by `where: { id, userId }` → P2025 → 404.
6. Server/client module discipline; **Scrydex key + team id never reach the browser**.
7. Public card/pricing routes degrade to HTTP 200 + fallback, never 5xx.
8. Design tokens only; square corners; canonical `ArrowRight`.
9. Thin routes, pure domain logic in `src/lib/utils/*.ts`, services own side effects.
10. Offset pagination (`skip` + numeric `nextCursor`).

### Known uncertainties to confirm in the audit (do not pre-commit to these)

- **Scrydex Vision/image-identify endpoint path is UNRESOLVED.** `.agents/tasks/
  api-integration-contracts.md` records that `/v1/vision/identify`, `/pokemon/v1/
  vision/match`, `/pokemon/v1/vision` all 404'd. The audit must probe spaced candidate
  paths (3–5s apart; Cloudflare bot-mitigation hangs on rapid repeats) and record the
  working path + request/response shape + per-call credit cost, or record it as a GAP.
  Until confirmed, the scanner keeps the Tesseract fallback and never fabricates a match.
- **Scrydex HAS a documented Pokémon price-history endpoint** — `GET /pokemon/v1/cards/
  {id}/price_history` (DOC-VERIFIED; see `docs/SCRYDEX_AUDIT.md`). The earlier
  "no history endpoint / store-and-accumulate only" assumption is RETRACTED. Real history
  comes from this endpoint with documented filters (`days`/`start_date`/`end_date`/
  `variant`/`condition`/`company`/`grade`/pagination). UNRESOLVED: whether graded points
  carry identifiable `company`/`grade` labels in the RESPONSE and whether one unfiltered
  call returns separable RAW/PSA/BGS series — do NOT fabricate graded series (Audit L2).
- **Scrydex-returned card id** is used on the path; its mapping to `Card.externalId` vs
  `Card.scrydexId` is UNVERIFIED. The resolver proves only that the returned id feeds the
  by-id fetch. Preserve all three ids; verify mapping (local inspection first, then L0)
  before relying on it.
- **Credit costs are documented** (standard 1 / price_history 3 / Vision 5), with usage
  updated every ~20–30 min via `/account/v1/usage` and a 100 req/s ceiling. Still:
  per-op real burn is confirmed only by delayed reading; bulk refreshes need Owner_Approval.
- **Vision identify is documented**: `POST /vision/v1/cards/identify`, JSON `image_url`
  or `multipart/form-data` `image`, JPEG/PNG/WebP, 20MB, 5 credits, `games` scope. Dojo's
  20MB cap + MIME allow-list are enforced regardless. UNRESOLVED: no-match response shape.
- **Population coverage is PSA English only** (BGS unavailable), via `include=pop_reports`.
- **One Piece routes** are publicly documented; OUR account's One Piece data access/
  coverage and One Piece sold-listing parity are unconfirmed (Audit L1/L3).
- **Provider gates (production):** written commercial-use authorization and uploaded-image
  retention clarification remain open and block commercial launch (Audit; Terms §4/§8).

---

## Phase Plan (Checkpoints A–D, dependency-ordered)

Each phase depends only on the Audit_Report or an earlier phase (Req 2.1). No phase
bundles unrelated areas (Req 2.4). Every phase ships updated `docs/`, F-number tests
changed **before** implementation (Req 2.3), and a green Verification_Gate (Req 2.2).
Checkpoint C evidence (changed files, migrations, commands, credits, gaps) and Checkpoint
D owner-approval gates (prod migration / bulk refresh / nontrivial paid credits) apply to
every phase (Reqs 3, 4).

| Phase | Checkpoint | Area | Depends on | Deliverable |
|---|---|---|---|---|
| **P0** | A | Read-only audit | — | `docs/SCRYDEX_AUDIT.md` (Audit_Report) |
| **P1** | B | Scrydex data & pricing core | P0 | real RAW/PSA/BGS store-and-accumulate; **remove `scrydex-trend`**; schema deltas; FX_Service; PokéWallet constrained |
| **P2** | B | Search & card detail | P1 | indexed metadata, Scrydex-backed search/detail, eBay-sold swap, UI cleanups |
| **P3** | B | Portfolio sales & accounting | P1 | cost-basis lazy resolution, sale/sold section, realized/unrealized P&L |
| **P4** | B | Scanner | P0 (+P1 ids) | Scrydex identify, Scan_Allowance, upload validation |
| **P5** | B | Dashboard, collections & onboarding | P1,P3 | ALL virtual view, comparison chart, chart bug fixes, persisted onboarding, dashboard cleanup |

P2/P3/P4 are independent of each other (all depend on P1's pricing + schema), so they are
individually reviewable. P5 depends on P3 (sold/accounting feeds the dashboard figures).

---

## Phase 0 — Checkpoint A: Read-Only Scrydex Audit

**Deliverable:** `docs/SCRYDEX_AUDIT.md`, committed to the repo documentation set
(Req 1.6). Read-only: the audit code issues only `GET` requests against `api.scrydex.com`
(Req 1.2), reuses the existing `scrydexHeaders()` (both `X-Api-Key` + `X-Team-ID`, missing
team id → instant 401), and spaces calls 3–5s apart.

The report documents, **per functional area** (Req 1.3), a table of:

- Scrydex endpoint(s) + HTTP method (all GET).
- Response fields actually used, mapped to the Zod schema fields.
- Which card identifier the endpoint takes/returns (native `scrydexId` vs `externalId`).
- Observed rate limits / Cloudflare behavior.
- Estimated credit cost per operation (measured where possible).

Plus (Reqs 1.4, 1.5):

- RAW / PSA / BGS series availability per game — which `variants[].prices[]` entries carry
  `type:"raw"` vs graded (`company`/`grade`), and where a tier is genuinely absent → recorded
  as a GAP.
- The Vision/identify endpoint result: working path + shape + credit cost, or GAP + the
  probed-and-404'd paths.
- Scrydex-supported upload formats + size limits for identify.
- A per-area credit-cost estimate feeding the Checkpoint D approval for any bulk refresh.

**No schema migration or write path runs in P0.** The report is the evidence the owner
approves before P1 (Req 1.1).

Audit code lives in a script, e.g. `scripts/audit-scrydex.ts` (invoked manually, never
by cron), that prints findings and never writes secrets to stdout/report (Req 4.4) — it
references keys by name (`SCRYDEX_API_KEY present: true`), never value.

---

## Architecture Overview

```
Browser (React 19) ── TanStack Query v5 ──► Next.js App Router
                                               ├─ (dashboard)/(onboarding)/(admin) RSC + pages
                                               └─ /api/* thin routes
                                                     guard → Zod → service → HTTP
                                                        │
   Services (src/lib/services) ─────────────────────────┘
     scrydex.service.ts         THIN client: fetch → map → Zod (NO Prisma)
     scrydex-pricing.service.ts SINGLE WRITER: freshness gate, store, credit meter
     fx.service.ts              NEW: current-price FX only (cached daily rate)
     scan-allowance.service.ts  NEW: atomic reserve/increment of User.scanCount
     portfolio.service.ts       NEW: cost-basis resolution, sale split, P&L
     pokewallet.service.ts      current-price-only fallback (unchanged scope)
                                                        │
   Postgres (Prisma) = system of record ◄──────────────┤
   Redis (optional) = accelerator, re-Zod on read ◄─────┘
   Scrydex / PokéWallet / eBay / FX provider (external, Zod-validated in)
```

Pure domain logic (allocation math, FX conversion, limit resolution, series valuation,
pagination) lives in `src/lib/utils/*.ts` and is unit-tested without DB/network. Services
own side effects. Routes stay thin.

---

## Phase 1 — Scrydex Data & Pricing

### 1.1 Components / interfaces

**`scrydex.service.ts` (thin client, extended).** Keep it Prisma-free. Extend
`ScrydexCardSchema` to carry the full metadata set the search/detail area needs (Req 14,
indexed in P2): `supertype`, `subtypes[]`, `hp`, `types[]`, `rules[]`, `abilities[]`,
`attacks[]`, `weaknesses[]`, `retreat_cost`/`retreat`, `artist`, `rarity`, `rarity_code`,
`language`/`language_code`, `number`, `printed_number`, `expansion.{name,series,code}`.
Each field `nullish()` — a missing field drops to `null`, never fabricated. Add
`pickGradedPrice(card, grade, "BGS")` support (already parameterized by `company`) so BGS
is a first-class tier alongside PSA.

```ts
// Accessors stay pure; selection never crosses tiers (Property 4).
export function pickRawPrice(card: ScrydexCard): ScrydexRawPrice | null;
export function pickGradedPrice(card, grade, company?: "PSA" | "BGS" | ...): ScrydexGradedPrice | null;
// Each returns { market, low, currency, source_currency, ... } with source currency preserved.
```

**`scrydex-pricing.service.ts` (single writer, modified — remove the backfill).**
Keep the freshness gate (newest `SyncLog(job="scrydex_history", cardId).ranAt` within
`SCRYDEX_STALE_MS = 24h` → skip, no HTTP, no row — Req 6 reuses `SyncLog`), the native-id
resolution + `Card.scrydexId` caching, the per-call credit meter (`SyncLog(status, credits)`).

**Removed:** `buildTrendBackfill()` and the step-4 first-pull `source="scrydex-trend"`
write (Req 7.2). History now comes from the DOCUMENTED endpoint, not from
accumulate-only snapshots:

```ts
// PRIMARY: GET /pokemon/v1/cards/{scrydexReturnedId}/price_history?days=... (3 credits).
//   → data[].{ date, prices[]{ variant, condition, type, low, market, currency, ... } }.
//   Store each returned point verbatim into PricingHistory with its real `date` as
//   recordedAt, source="scrydex", variant, condition, and source_currency preserved.
//   RAW NM series = filter type=raw, condition=NM. Other raw conditions are CURRENT
//   prices shown beneath the chart (from the card object), not history series.
// GRADED (PSA/BGS) SERIES — UNRESOLVED (Audit L2): the sample response showed only raw
//   points with NO company/grade labels. Until a live check confirms the response labels
//   graded points AND whether one call yields separable series, DO NOT build/store graded
//   chart series from history. No fabricated graded series. Current graded PRICE (from the
//   card object's prices[] via pickGradedPrice) is a separate, allowed value.
// Still: no point written when market==null && low==null (honest gap, never a $0 fill);
//   history points are NEVER FX-converted.
```

The 24h `SyncLog(job="scrydex_history", cardId)` freshness gate still prevents re-pulling a
card inside the window (Req: shared per-card cache). On a cache miss / stale card we call
the history endpoint once (3 credits) rather than fabricating. Periods the endpoint has no
data for stay genuine gaps (Reqs 7.3, 7.4). This is a behavior change pinned by F-09/F-18 —
the chart-accuracy harness (`npm run test:chart-accuracy`) and those tests are updated
first. **Live history calls / any bulk pull require Owner_Approval with an explicit credit
estimate (Checkpoint D).**

**`fx.service.ts` (NEW, server-only).** Converts a source-native **current** price to the
user's profile display currency (USD/EUR only) (Req 9.2). Never touches history points
(Req 9.3).

- **Provider:** a free daily-rate endpoint (e.g. the exchangerate.host / open ECB daily
  reference feed — exact provider confirmed in the audit/doc). Rate cached in Redis
  `RedisKeys.fxRate(base)` TTL 24h, re-Zod on read; Postgres is not needed (a rate is
  reconstructable). Redis-optional: a cache miss/outage fetches live; a live failure →
  conversion unavailable.
- **Failure behavior (Req 9.4, 9.5):** `convertCurrent(amount, from, to)` returns
  `{ amount, currency, converted: boolean }`. If `from === to`, identity (`converted:true`,
  rate 1). If no rate obtainable, returns the **source-native** amount+currency with
  `converted:false` so the UI shows the native price and a "conversion unavailable"
  indicator — never a fabricated converted number.

```ts
export async function convertCurrent(
  amount: number, from: string, to: "USD" | "EUR"
): Promise<{ amount: number; currency: string; converted: boolean }>;
// pure helper (unit-tested):
export function applyRate(amount: number, rate: number): number; // amount * rate
```

**PokéWallet (`pokewallet.service.ts`, scope locked).** Already PRICING-ONLY. This phase
enforces the constraint in code shape: the service exposes only current-price getters
(`fetchOnePieceSetPrices`, `fetchPokemonCardPrice`) and **no history producer** (Req 8.1).
Fallback precedence (Req 8.2): resolved current price = Scrydex current price if present,
else PokéWallet current price, else `null`. Each stored price is labeled with its
`DataSource` (`SCRYDEX`/`POKEWALLET`/`TCGDEX`) (Req 8.3).

### 1.2 Data model — Prisma schema deltas (migration impact)

```prisma
model UserCollection {
  // ... existing fields ...
  purchasePrice Float?    // EXISTING — the Cost_Basis (null = Unresolved_Cost_Basis)
  // NEW: when a cost-basis resolution was last attempted. Distinguishes
  // "never priced" (null) from "attempted, still unresolved" (timestamp, value null).
  costBasisAttemptedAt DateTime?   // NEW (P3 uses it; added in P1 migration bundle)
  // NEW: per-copy gross sale price semantics documented; soldPrice stays the
  // gross proceeds for the sold quantity (see P3).
  // (isSold/soldPrice/soldAt already exist.)
}

model User {
  // ... existing fields ...
  // NEW: lifetime successful-identification counter (Req 10.1). Default 0.
  scanCount Int @default(0)   // NEW
  // NEW: account-persisted one-time onboarding completion (Req 17.1). Null = not done.
  onboardingCompletedAt DateTime?   // NEW
}

model PricingHistory {
  // ... existing fields ...
  // NEW: preserve the ORIGINAL source currency of a history point so charts
  // render source-native and are never FX-converted (Req 9.1/9.3).
  sourceCurrency String?   // NEW (nullable; backfilled = currency for legacy rows)
  // `source` string gains "scrydex-psa"/"scrydex-bgs" values for graded tiers;
  // "scrydex-trend" is RETIRED — no new rows; a data migration deletes existing
  // scrydex-trend rows (Req 7.2) under Owner_Approval (Checkpoint D).
}
```

**Migration impact (Checkpoint D — Owner_Approval before prod run, Req 4.1):**
- Additive columns (`User.scanCount`, `User.onboardingCompletedAt`,
  `UserCollection.costBasisAttemptedAt`, `PricingHistory.sourceCurrency`) are
  backward-compatible with defaults/nullable — safe, but still gated.
- A **data migration deletes `PricingHistory where source="scrydex-trend"`** — this is
  destructive and bulk; it requires explicit Owner_Approval and runs via `prisma migrate`
  with `DIRECT_URL`. `Card.scrydexId @unique` already exists.
- No index on new columns needed initially (`scanCount`/`onboardingCompletedAt` read by PK;
  `sourceCurrency` filtered alongside `cardId`).

### 1.3 API contracts (P1 touches internal routes)

Existing public routes (`/api/cards/[id]/history`, `/graded`, `/prices`) keep their
contracts; `history` now returns points carrying their native currency so the client can
render source-native (shape extended, backward compatible):

```jsonc
// GET /api/cards/[id]/history   (public, 200 even on failure — Req 5.6/7.4)
{ "points": [ { "date": "2026-10-02", "price": 191.34, "currency": "USD",
                "tier": "raw", "grade": null } ] }
// empty points[] = honest no-history; the client no longer falls back to a mock series.
```

### 1.4 Error handling / graceful degradation

- Scrydex fetch failure or 0 valid cards → `NoResultsError` (advance fallback, don't trip
  the breaker — Req 6.3); `SyncLog(status:"failed", credits:0)`.
- FX rate unavailable → source-native + `converted:false` (Req 9.5).
- Public history/graded routes always 200 (Req 5.6).

---

## Phase 2 — Search & Card Detail

### 2.1 Components / interfaces

- **Catalog metadata indexing.** The daily sync (`sync-cards.service.ts` → `upsertCard`)
  maps the extended Scrydex fields onto `Card` so search can match them. Fields already on
  `Card`: `name`, `number`, `rarity`, `types[]`, `tags[]`. New metadata that doesn't fit an
  existing column is folded into the searchable `tags[]` via `buildTags` (artist, supertype,
  subtypes, expansion series/name) so the existing GIN-indexed `tags: { has }` search picks
  them up without a schema change — the laziest correct path (reuse the existing index).
  `printed_number`/`hp`/`abilities`/`attacks`/`weaknesses`/`retreat`/`rules` are carried for
  the detail view; if any need to be searchable beyond tags, add columns in a follow-up —
  not required by Req 14.1 (search by name/set/number + "other fields" satisfied by tags).
- **Search route (`/api/cards/search`).** Unchanged shape; reads local Postgres (Req 14.1
  — results keyed by `externalId`), offset pagination with numeric `nextCursor` (Req 14.4),
  200 + fallback on failure (Req 14.3).
- **Card detail (`(dashboard)/search/[id]/page.tsx`).** Shows Scrydex current price (FX-
  converted to profile currency via `fx.service`) + RAW/PSA/BGS series (source-native)
  (Req 14.2). Three-id discipline: detail link uses `Card.id`; history/graded/add use
  `externalId`; Scrydex pulls use `scrydexId` (Req 5.5).

### 2.2 UI changes (design tokens, no new colors/radii)

- **Remove** the top-line search icon.
- **Remove** the dummy "Accessories" block (`search/[id]/page.tsx` ~line 1032).
- **Replace** "Sellers on the Floor" with **Scrydex eBay sold records**: the section now
  shows real recent **sold** records from Scrydex (if the audit confirms Scrydex exposes
  sold comps for a card). Empty → "No recent sales found." **Never** active listings
  (removes the eBay Browse active-listings path from this section). If the audit finds
  Scrydex has no sold-comps capability, this is recorded as a GAP and the section renders
  the empty state rather than reverting to active listings.
- Keep the **star** (favorite) and **plus** (add) actions.
- **Manual-only PSA/BGS population refresh** (Req 15): population is fetched only on an
  explicit user action (a "Refresh population" control), never on page load/search/sync
  (Reqs 15.1, 15.2). No refreshed data → fallback state, never a fabricated number
  (Req 15.3). The population report stays the labeled reference/fallback until refreshed.

### 2.3 Error handling

Search/detail source unavailable → 200 + fallback payload (Req 14.3). Unresolved cost
basis in the user's collection → detail shows the unresolved indicator, never `$0`
(Req 14.5).

---

## Phase 3 — Portfolio Sales & Accounting

### 3.1 Components / interfaces

**`portfolio.service.ts` (NEW) + `src/lib/utils/portfolio-accounting.ts` (NEW, pure).**

**Cost-basis snapshot at add (lazy-resolved).** `POST /api/users/me/collection` already
defaults `purchasePrice = item.purchasePrice ?? item.marketPrice ?? card.marketPrice ?? null`.
This phase makes the unresolved path explicit (Req 12):

- If no price is determinable at add, store `purchasePrice = null` and set
  `costBasisAttemptedAt = now()` (Req 12.1). The add **always succeeds** regardless
  (Req 12.2). Never store `0` or an invented value (Req 12.3).
- Snapshot source precedence: current Scrydex/stored price → nearest Scrydex history point
  → unresolved (null).
- **Lazy resolution:** when the next successful Scrydex price fetch happens for that card
  (via `pullAndStoreScrydexPrice`), resolve unresolved holdings — set `purchasePrice` to
  the resolved price, scoped `where: { id, userId }` (Reqs 12.4, 12.6). `costBasisAttemptedAt`
  is retained as the add-time attempt marker.

**Sale recording (`POST /api/users/me/collection/[id]/sell`, NEW).**

```jsonc
// Request (Zod-validated at the boundary — Req 13.2)
{ "quantity": 2,            // partial sale; 1 <= quantity <= row.quantity
  "grossPricePerCopy": 95.0,
  "soldAt": "2026-10-02" }  // editable; defaults to today
```

Semantics (Req 13.1):
- Scoped `where: { id, userId }` → P2025 → 404 (Req 13.5).
- **Partial sale splits the row**: the sold `quantity` moves to a sold row
  (`isSold:true`, `soldPrice = grossPricePerCopy * quantity`, `soldAt`), the remaining
  quantity stays in the active row. Quantity is conserved: `soldQty + remainingQty ==
  originalQty`. The sold row **keeps the same `collectionId`** (moves to a "Sold" section
  **within the same collection**, preserving association + history — Area 3 requirement).
- Full sale (`quantity == row.quantity`) flips the existing row to sold.

**Realized P&L (pure, `portfolio-accounting.ts`).** `realized = grossProceeds -
allocatedCostBasis`, **no fees/shipping** (Area 3). For partial sales, cost basis is
allocated **proportionally**: `allocatedCostBasis = perCopyBasis * soldQty` (equivalently
`totalBasis * soldQty / originalQty`), so the sum of allocations across partial sales
equals the original total basis (Req 13.3).

```ts
export type PnL = { status: "resolved"; value: number } | { status: "unresolved" };
export function realizedPnL(soldQty: number, grossPerCopy: number, basisPerCopy: number | null): PnL;
// basisPerCopy == null → { status: "unresolved" } (Reqs 12.5, 13.4) — NEVER a number, never 0.
export function allocateBasis(totalBasis: number, soldQty: number, originalQty: number): number;
```

**Portfolio stats (Area 3 — show Market Value / Paid / Realized / Unrealized).**
- Market Value = Σ (current stored price × qty) over active holdings.
- Paid = Σ resolved cost basis × qty (unresolved holdings excluded + flagged, never 0).
- Realized = Σ realized P&L over sold rows (unresolved → shown unresolved).
- Unrealized = Market Value − Paid (over resolved holdings only).

### 3.2 Data model

Reuses existing `UserCollection.isSold/soldPrice/soldAt/purchasePrice` +
`costBasisAttemptedAt` (added P1). No new models. Partial-sale split creates a second
`UserCollection` row with the same `cardId`, `userId`, `collectionId`, `isFoil`,
`condition` — note the existing `[userId, cardId, isFoil]` dedup logic in the add route
must be bypassed for sold rows (a sold row and an active row of the same card coexist; the
add route already filters `isSold:false` when finding an existing copy, so this holds).

### 3.3 Error handling

Add never blocked by missing basis (Req 12.2). Sale on a foreign/absent id → 404
(Req 13.5). Over-quantity sale → 400 (Zod `quantity <= row.quantity` checked in service).

---

## Phase 4 — Scanner

### 4.1 Components / interfaces

**Scrydex image identification replaces Google Vision.** The audit (P0) supplies the
identify endpoint path + request shape. `scrydex.service.identifyCard(imageBase64)` is
wired to that endpoint (Zod-parse the body; name the path in a load-bearing comment per
AGENTS.md §14). The Scrydex key + team id stay **server-side only** (Req 10.7, invariant 6)
— identify is called from the `/api/cards/recognize` route, never the browser.
`vision-ocr.service.ts` (Google Vision) is removed from the recognize path; the on-device
Tesseract fallback remains for when identify yields no match or is unavailable.

**`scan-allowance.service.ts` (NEW) + `User.scanCount` (added P1).**

- **Scan_Limit resolution** (pure, `src/lib/utils/scan-limit.ts`): read from env
  `SCAN_LIMIT` (or a tier-specific constant); default **10** (Req 10.2). Invalid/empty/
  negative env → default. Paid tier → that tier's configured limit (Req 10.3).
- **Atomic reserve (Req 10.4 — concurrency safety).** Increment only succeeds when under
  limit, in a single atomic conditional update (no read-then-write race):

```ts
// Conditional atomic update: increments iff scanCount < limit. Returns the
// updated row or null (already at limit). Prisma updateMany with a guard, or a
// raw UPDATE ... WHERE scanCount < limit RETURNING. Guarantees final count <= limit
// under concurrency (Property: granted == min(attempts, remaining)).
async function reserveScan(userId: string, limit: number): Promise<boolean> {
  const res = await prisma.user.updateMany({
    where: { id: userId, scanCount: { lt: limit } },
    data: { scanCount: { increment: 1 } },
  });
  return res.count === 1; // false → limit reached (Req 10.6)
}
```

Flow in `/api/cards/recognize` (image path):
1. Identify the user from the **Better Auth server session** (Req 10.7). Scan allowance
   requires auth (anonymous recognition by `text` keeps the existing anonymous path, but
   the counted **successful identify** path is session-scoped).
2. **Validate upload BEFORE identify** (Req 11): reject > 20MB (Req 11.1); validate MIME
   server-side against the Scrydex-supported allow-list (Req 11.2); on failure → reject,
   **no increment**, no identify call (Reqs 11.4, 10.5).
3. If already at limit → `limit-reached` response, no identify call (Req 10.6).
4. Call Scrydex identify. **Only on a successful match**, `reserveScan` increments
   atomically (Req 10.4). A no-match/failure does **not** increment (Reqs 10.5, 11.4).
5. **Discard the image** — the handler holds the buffer in memory only, writes nothing to
   storage/DB (Req 11.3). `ScanFeedback` stores the match reference, never the image bytes.

### 4.2 API contract

```jsonc
// POST /api/cards/recognize  { image: "<base64>", game? }  (multipart or JSON)
// Success match:
{ "success": true, "candidates": [ { "id": "<externalId>", "name", "set",
    "imageUrl", "confidence" } ], "feedbackId", "ocrSource": "scrydex",
  "scanAllowance": { "used": 3, "limit": 10 } }
// Limit reached:
{ "success": false, "error": "limit-reached", "scanAllowance": { "used": 10, "limit": 10 } }  // HTTP 200 (public-route degradation) with explicit state
// Upload too large / unsupported type:
{ "success": false, "error": "unsupported" | "too-large" }  // HTTP 400 (client input error, pre-identify)
// No match / identify unavailable:
{ "success": true, "candidates": [], "ocrSource": "unavailable" }  // client runs Tesseract
```

### 4.3 Error states (safe)

timeout → treat as no-match (no increment, Tesseract fallback); unsupported type/too-large
→ 400 reject (no increment); no-match → empty candidates (no increment); exhausted →
limit-reached; retriable transient errors → the client may retry (identify is idempotent;
only a successful match increments).

---

## Phase 5 — Dashboard, Collections & Onboarding

### 5.1 Components / interfaces

**Dashboard cleanup (`DashboardClient.tsx`).**
- **Remove the intent (Want to Buy/Sell/Trade) sections** from the dashboard — keep them on
  the Wantlist page only (the `WantList` component + `/wantlist` route already own them).
- **Fix the home chart**: replace the mock `generateMockChartData` series + the mocked
  shading/date-range with the real stored-history pipeline; shading and the visible
  date-range must agree with the plotted real points; no value before a card entered the
  collection (see comparison chart below); honest gaps.
- **Fix the home card-image click + loading bugs**: card tiles' image click opens the detail
  popup reliably; the loading state resolves to real data (SSR `initialData` already removes
  the first-paint flash — the remaining loading-state bug is addressed where tiles render).

**Collections as normal owned-card collections + ALL virtual view.**
- Named `Collection`s are treated as ordinary owned-card groupings (they already are via
  `UserCollection.collectionId`).
- **Built-in, non-editable virtual `ALL` view** aggregating **all owned copies including
  unassigned** (`collectionId == null`). ALL is synthesized in the query/selector layer, has
  a reserved id (e.g. `"__all__"`), and **rejects mutation** (rename/delete/file-into) — the
  collections API refuses writes targeting the virtual id (Req: ALL non-editable).
- **Per-collection carousel summaries**: each collection (and ALL) gets a summary card
  (count, market value, realized/unrealized with unresolved flagged).

**Multi-collection comparison chart (`MultiLineComparisonChart`, exists — made real).**
One series/area per selected collection, **never summed** (Area 5). Built from
`src/lib/utils/collection-series.ts` (NEW, pure):

```ts
// For a collection, value at time t = Σ over copies owned-at-t (addedAt <= t, and not
// sold-before-t) of (stored market value at the nearest real history point <= t) * qty.
// Before a collection's earliest addedAt, the series has NO value (null/absent), never 0-
// extrapolated. Gaps where no real price exists remain gaps. Returns one series per
// collection; the chart renders one shaded area each — it NEVER sums series.
export function buildCollectionSeries(
  holdings: Holding[], history: HistoryPoint[], range: Range
): CollectionSeries[];
```

X = time, Y = value; shaded areas per series; honest gaps; correct date/quantity/ownership
intervals (a copy contributes only within `[addedAt, soldAt)`).

**Persisted onboarding (`User.onboardingCompletedAt`, added P1).**
- Post-signup → Explore. Choosing **Continue** → card-adding flow; **Skip** → Dashboard.
- Completion (reaching either terminal once) persists `onboardingCompletedAt` to the DB for
  that user (Req 17.1), read/written from the **server session** (Req 17.3). A completed
  user is **never re-prompted**, across devices (Reqs 17.2, 17.1 — it's account-scoped, not
  localStorage). New routes:

```jsonc
// GET  /api/users/me/onboarding  → { completed: boolean }       (session-scoped)
// POST /api/users/me/onboarding  { action: "continue" | "skip" } → { completed: true }
//   sets onboardingCompletedAt = now() if not already set (idempotent, one-time)
```

The `(onboarding)/profile` localStorage flag is replaced by this account-persisted state.

### 5.2 Data model

Reuses `Collection` + `UserCollection.collectionId` + `User.onboardingCompletedAt`. The
`ALL` view is virtual (no row). No new models.

### 5.3 Error handling

Collections queries scoped to the authenticated user (Req 16.4). Totals computed from
Scrydex-sourced stored prices only; no synthetic points (Reqs 16.1, 16.2); unresolved
holdings contribute an "unresolved" P&L, never silent 0 (Req 16.3). Mutation targeting the
virtual ALL id → 400/rejected.

---

## Caching & Credit Strategy

**Redis keys (extend `RedisKeys` registry in `src/lib/redis.ts`):**

| Key | TTL | Writer / Reader | Notes |
|---|---|---|---|
| `fx:rate:{base}` (NEW) | 24h | `fx.service` | daily FX rate; re-Zod on read; fail-open → live fetch → source-native |
| existing `price:card:{id}`, `card:search:*`, `ebay:*`, `card:trending:*` | unchanged | — | — |

Every Redis op stays try/caught, fail-open (invariant 1). Postgres remains the system of
record; nothing in Redis is non-reconstructable.

**Credit strategy:** the 24h freshness gate on `SyncLog(job="scrydex_history")` keeps burn
to ≤1 credit/card/day (reused from the existing single-writer). Credits metered per pull
in `SyncLog.credits`; the Checkpoint C report sums them per phase. **Bulk refreshes and
any nontrivial paid consumption require Owner_Approval (Checkpoint D, Reqs 4.2, 4.3).**
`SCRYDEX_CREDITS_PER_CALL` is updated from the audit's measured cost.

---

## FX Provider Design (Req 9.4 — documented)

- **Provider:** a daily reference-rate feed (confirmed in P0/doc). Only USD and EUR targets
  are supported (profile currencies).
- **Caching:** one Redis key per base, 24h TTL, Zod-validated on read; a cache miss triggers
  one live fetch per day per base.
- **Scope:** current prices only. History points carry `sourceCurrency` and are rendered
  source-native, **never converted** (Reqs 9.1, 9.3).
- **Failure:** no rate obtainable → return source-native amount + currency with
  `converted:false`; UI shows the native price and a "conversion unavailable" indicator
  (Req 9.5). No fabricated converted number is ever shown (invariant 2).

---

## Error Handling & Graceful Degradation (cross-cutting)

- Public card/pricing/search/detail routes: HTTP 200 + fallback payload on any source
  failure (Req 5.6, 14.3, 7.4). Authed CRUD (sell, onboarding) may return real 4xx/5xx.
- Scrydex 0-valid or fetch failure → `NoResultsError` (advance fallback, don't trip breaker,
  Req 6.3); failed pull → `SyncLog(status:"failed")`.
- FX unavailable → source-native + flag (Req 9.5).
- Scanner: validation failure → 400 no-increment; no-match/timeout → Tesseract; exhausted →
  limit-reached (Reqs 10, 11).
- Secrets never logged/reported/committed (Req 4.4): error messages reference key **names**,
  never values; the audit script prints presence booleans only.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid
executions of a system — a formal statement about what the system should do.*

Following the prework analysis and a property-reflection pass that consolidated overlapping
criteria (ownership scoping 5.3/12.6/13.5/16.4 → one property; Zod-boundary 5.2/6.5/13.2 →
one property; unresolved-P&L 12.5/13.4/16.3 → one property; graceful-degradation 5.6/14.3 →
one property; identifier-discipline 5.5/6.4/14.1 → one property; backfill-removal 7.2 and
no-synthetic 7.3/7.4/16.2 → one property; allowance invariant 10.4/10.6/11.4 → one
property), the testable criteria reduce to the following properties.

### Property 1: Zod validates and drops at every boundary

For any mix of valid and malformed payloads at a boundary schema (Scrydex card, cached
price, request body), parsing accepts exactly the valid payloads, drops the invalid ones,
and never throws an unhandled error; a cache round-trip (write a valid payload, read it
back) re-parses successfully.

**Validates: Requirements 5.2, 6.2, 6.5, 13.2**

### Property 2: Zero valid cards raises NoResultsError

For any Scrydex response that yields zero valid cards (empty or all-invalid), the service
raises a `NoResultsError` so the fallback chain advances without counting a breaker failure.

**Validates: Requirements 6.3**

### Property 3: Three-id discipline is never crossed

For any card with distinct `id`, `externalId`, and `scrydexId`, each data path emits the
identifier its consumer expects — the Scrydex by-id endpoint receives `scrydexId`, search
results and add/history use `externalId`, React keys/detail links use `id` — and no path
substitutes one namespace for another.

**Validates: Requirements 5.5, 6.4, 14.1**

### Property 4: Price accessors never cross tiers

For any `ScrydexCard` with a mix of RAW and graded (PSA/BGS, varying grades) price entries,
`pickRawPrice` returns only a `type:"raw"` entry and `pickGradedPrice(grade, company)`
returns only an entry matching that company and grade — never a different tier, company,
or grade.

**Validates: Requirements 7.1**

### Property 5: No fabricated or synthesized price points

For any card pull (first or subsequent) and any history series with missing periods, no
`PricingHistory` row with `source="scrydex-trend"` is produced, no interpolated/invented
point is inserted into gaps, no `$0`/null point is emitted, and the rendered chart series
equals exactly the real non-null Scrydex-sourced points in order.

**Validates: Requirements 7.2, 7.3, 7.4, 16.2**

### Property 6: PokéWallet is current-price-only and used only as fallback

For any PokéWallet response, the service yields only current-price values (never a
multi-point history series), and for any `(scrydexCurrent, pokewalletCurrent)` pair the
resolved current price equals the Scrydex value when present, else the PokéWallet value,
else null; every stored price is labeled with the `DataSource` matching its origin.

**Validates: Requirements 8.1, 8.2, 8.3**

### Property 7: FX converts current prices only, never history, with honest conversion math

For any current amount, source currency, target currency (USD/EUR), and rate, the converted
value equals `amount * rate` (identity when source == target), while every history-series
point's amount and currency are left unchanged by the display pipeline; if no rate is
obtainable the output is the source-native amount+currency flagged `converted:false` and
never a fabricated converted number.

**Validates: Requirements 9.1, 9.2, 9.3, 9.5**

### Property 8: Scan_Limit resolution

For any environment configuration (valid integer, empty, non-numeric, zero/negative), the
resolved Scan_Limit equals the parsed positive integer when valid, otherwise the default
of 10.

**Validates: Requirements 10.2**

### Property 9: Scan allowance never exceeds the limit under concurrency, and only successful matches consume

For any starting `scanCount`, limit, and number of concurrent scan attempts, the number of
granted (incrementing) scans equals `min(attempts, limit − startingCount)`, the final
`scanCount` never exceeds the limit, a no-match/failed scan or a pre-identify validation
rejection increments nothing, and a user already at the limit is rejected with
`limit-reached` without calling identify.

**Validates: Requirements 10.4, 10.5, 10.6, 11.4**

### Property 10: Upload size is accepted iff within the 20MB cap

For any upload byte size, the upload passes the size check iff `size <= 20MB` and is
rejected (without incrementing the allowance or calling identify) when larger.

**Validates: Requirements 11.1**

### Property 11: Upload MIME is accepted iff in the supported set

For any MIME string, the upload is accepted iff it is a member of the Scrydex-supported
format allow-list, and rejected (no increment, no identify) otherwise.

**Validates: Requirements 11.2**

### Property 12: Unresolved cost basis is null-not-zero and reported as "unresolved"

For any add where no cost basis is determinable, the holding persists with
`purchasePrice === null` (never 0, never an invented value) and a `costBasisAttemptedAt`
timestamp, the add still succeeds, and any P&L computed for a holding or sale with a null
basis is reported with status "unresolved" (never a numeric or zero P&L).

**Validates: Requirements 12.1, 12.2, 12.3, 12.5, 13.4, 16.3**

### Property 13: Lazy cost-basis resolution persists the next real price

For any holding with an unresolved cost basis, when a subsequent Scrydex price fetch for
that card succeeds, the holding's `purchasePrice` is set to the resolved price (scoped to
the owning user), and remains unresolved until such a fetch succeeds.

**Validates: Requirements 12.4**

### Property 14: Sale conserves quantity and allocates cost basis proportionally

For any holding of `originalQty` copies and any sale of `soldQty` (1 ≤ soldQty ≤
originalQty) at `grossPerCopy`, the sold quantity plus the remaining quantity equals
`originalQty`, the sold row carries `isSold`/`soldPrice`/`soldAt` and keeps the same
`collectionId`, and (when the basis is resolved) realized P&L equals
`soldQty*grossPerCopy − soldQty*basisPerCopy` with cost-basis allocated proportionally so
the allocations across partial sales sum to the original total basis.

**Validates: Requirements 13.1, 13.3**

### Property 15: User-scoped mutations reject foreign ids

For any user-scoped mutation (sale, cost-basis resolution, collection write, onboarding
write) and any id not owned by the authenticated user (foreign or nonexistent), the Prisma
query scoped `where: { id, userId }` yields a 404 (P2025) and leaves the real owner's row
unchanged.

**Validates: Requirements 5.3, 12.6, 13.5, 16.4**

### Property 16: Public card/pricing routes degrade to 200 + fallback

For any failure of the underlying source on a public card, pricing, search, or detail
route, the HTTP response is status 200 with a fallback-shaped payload rather than a 5xx.

**Validates: Requirements 5.6, 14.3, 7.4**

### Property 17: Redis failure falls through to live data

For any request whose Redis read or write throws, the request still completes using live
data and returns a correct payload.

**Validates: Requirements 5.4**

### Property 18: Population refresh is manual-only with honest fallback

For any automatic trigger (page load, search, scheduled sync), no PSA/BGS population fetch
occurs; a population fetch happens only in response to an explicit manual action; and a
card with no refreshed population renders a fallback state, never a fabricated population
number.

**Validates: Requirements 15.1, 15.2, 15.3**

### Property 19: The ALL view aggregates all owned copies and is non-editable

For any user's holdings across named collections and the unassigned (`collectionId == null`)
set, the virtual ALL view's membership equals the union of all owned copies, and any
mutation targeting the ALL view (rename, delete, file-into) is rejected.

**Validates: Requirements 16.1 (aggregation scope), Area 5 ALL-view requirement**

### Property 20: Comparison chart renders per-collection series, never summed, with no pre-entry value

For any set of collections with per-copy entry dates and quantities, each chart series'
value at a time `t` equals that collection's own holdings valued at the nearest real price
point ≤ `t`, is absent/null before the collection's earliest entry date, leaves genuine
price gaps as gaps, and no rendered series equals the cross-collection sum.

**Validates: Area 5 comparison-chart requirement (one series per collection, never summed; no value before entry; honest gaps)**

### Property 21: Onboarding completion persists per account across sessions

For any user who completes onboarding (Continue or Skip once), `onboardingCompletedAt` is
persisted to the database for that user and, on any subsequent load from any device, the
gate decision is "do not re-prompt".

**Validates: Requirements 17.1, 17.2**

---

## Testing Strategy

**Dual approach.** Property tests (≥100 iterations each, randomized) cover the universal
properties above; example/edge/integration tests cover specific scenarios, wiring, and
infrastructure. Each property test is tagged
**Feature: scrydex-migration, Property N: {property text}** and references its design
property. Behavior changes change the pinned F-number test **first** (Req 2.3).

**F-number mapping (existing tests updated before implementation):**

| Area / Property | F-number(s) | Test location & kind |
|---|---|---|
| Zod boundary (P1, P2) | F-06, FR-2 | `tests/unit` (schema parse/drop), `tests/integration` (route body) — property |
| Price accessors / tiers (P4) | F-17, F-18 | `tests/unit/card-price`, `graded-price` — property |
| No fabricated points / backfill removed (P5) | F-09, F-18, chart-accuracy | `tests/unit`, `scripts/compare-chart-accuracy.ts` (±10% gate) — property + gate |
| PokéWallet current-only + fallback (P6) | F-18 | `tests/unit/pokewallet`, `tests/integration/pokemon-price` — property |
| FX current-only (P7) | F-18 (new) | `tests/unit/fx` (`applyRate`, convert, history-untouched) — property |
| Scan_Limit resolution (P8) | F-14 | `tests/unit/scan-limit` — property |
| Scan allowance concurrency (P9) | F-14 | `tests/integration` (concurrent `reserveScan`) — property |
| Upload size/MIME (P10, P11) | F-14 | `tests/unit` (validation helpers) — property |
| Unresolved basis / realized P&L / allocation (P12, P14) | F-11, F-15 (new F-23 sales) | `tests/unit/portfolio-accounting` — property |
| Lazy resolution (P13) | new | `tests/integration` — property |
| Ownership scoping (P15) | F-10, F-22 | `tests/integration` (foreign-id 404) — property |
| Graceful degradation (P16) | F-16, FR | `tests/integration` (forced source failure → 200) — property |
| Redis fail-open (P17) | — | `tests/integration` (throwing Redis mock) — property |
| Manual-only population (P18) | — | `tests/integration` (no auto fetch) — property |
| ALL view / comparison chart (P19, P20) | F-10, F-11, F-22 | `tests/unit/collection-series`, `collection-aggregation` — property |
| Onboarding persistence (P21) | F-02 (new F-24 onboarding) | `tests/integration` — property |
| eBay-sold swap, UI cleanups | F-16, F-08 | `tests/integration` + `e2e` (visual VISUAL=1) — example/integration |
| Scanner identify wiring, discard image | F-14 | `tests/integration` + `e2e` camera project — example |
| Secrets not logged (Req 4.4) | — | `tests/unit` (error formatting omits key value) — example |

**Verification Gate (Req 5.8, run per phase):** `npm run verify` = lint → unit →
integration → chart-accuracy → e2e. E2E runs the standalone production build on :3001
(`BETTER_AUTH_URL` must match) with the existing `setup/chromium/google/authed/camera`
projects. New e2e: onboarding one-time gate (authed), sale/sold-section flow (authed),
scanner limit-reached (camera, mocked identify).

Integration tests mock Prisma/fetch/Redis (no live DB/network, no live Scrydex credits).
Scrydex identify/pricing are mocked in tests; real credit consumption only happens in the
audit (P0) and under Owner_Approval.


