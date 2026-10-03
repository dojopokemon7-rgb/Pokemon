# Implementation Plan: Scrydex Migration

## Overview

This plan converts the Scrydex Migration design into dependency-ordered, individually
reviewable coding tasks across six phases (P0–P5) matching the design's Checkpoint A–D
phase plan. All code is **TypeScript** (the repo language). Each phase ships F-number
tests changed **before** implementation (Req 2.3), updated `docs/`, and a green
`npm run verify` (Req 2.2). Owner-approval gates (Checkpoint D) are called out as explicit
non-coding stops before any production migration, bulk refresh, or nontrivial paid-credit
operation (Req 4). Property tests reference the design's Correctness Properties (P1–P21);
test sub-tasks are marked optional with `*`.

Dependency order: **P0 gates everything** → P1 (data/pricing core) → P2, P3, P4 depend on
P1 (P4 also on P0 ids) and are independent of each other → P5 depends on P1 + P3.

---

## Tasks

- [ ] 1. P0 — Checkpoint A: Read-only Scrydex audit (gates all later phases)
  - [x] 1.1 Write the read-only audit script `scripts/audit-scrydex.ts`
    - GET-only against `api.scrydex.com`, reusing existing `scrydexHeaders()` (`X-Api-Key` + `X-Team-ID`); space calls 3–5s apart to avoid Cloudflare bot-mitigation hangs
    - Probe per functional area: catalog/current-price endpoints, RAW/PSA/BGS tiers in `variants[].prices[]` (`type:"raw"` vs `company`/`grade`), the UNRESOLVED Vision/identify endpoint (probe spaced candidate paths; record working path + shape + credit cost or GAP), identify-supported upload formats + size, One Piece slug
    - Reference secrets by NAME only (`SCRYDEX_API_KEY present: true`), NEVER value; no secret reaches stdout/report
    - No schema migration, no write path, no bulk refresh in P0
    - _Requirements: 1.1, 1.2, 4.4_
  - [x] 1.2 Write unit test asserting the audit script issues only GET and never emits a secret value
    - Mock the HTTP client; assert method === "GET" on every call; assert formatted output contains key names not values
    - **Property 1 context (boundary) + Req 4.4 secrets-omission**
    - _Requirements: 1.2, 4.4_
  - [x] 1.3 Generate `docs/SCRYDEX_AUDIT.md` (the Audit_Report) from the script's findings
    - Per-area table: endpoint(s) + method (all GET), response fields mapped to Zod fields, identifier taken/returned (`scrydexId` vs `externalId`), observed rate limits/Cloudflare behavior, estimated credit cost per op
    - RAW/PSA/BGS series availability per game; record genuinely-absent tiers as GAPs (Reqs 1.4, 1.5)
    - Vision/identify result (working path + shape + cost, or GAP + probed-404 paths); supported upload formats + size; per-area credit-cost estimate feeding the Checkpoint D bulk-refresh approval
    - _Requirements: 1.3, 1.4, 1.5, 1.6_
  - [~] 1.4 **Owner-approval checkpoint (Checkpoint D — NON-CODING STOP).**
    - Present `docs/SCRYDEX_AUDIT.md` and the measured per-area credit estimates to the owner. Do NOT proceed to any P1+ migration, bulk refresh, or nontrivial paid-credit operation without explicit Owner_Approval. Record approval before continuing.
    - _Requirements: 4.1, 4.2, 4.3_

- [ ] 2. P1 — Scrydex data & pricing core (depends on P0)
  - [~] 2.1 Update F-09/F-18 tests and the chart-accuracy harness FIRST (TDD, behavior change)
    - Rewrite `tests/unit` price/graded expectations and `scripts/compare-chart-accuracy.ts` reference so they assert REAL points sourced from the documented `GET /pokemon/v1/cards/{id}/price_history` endpoint with honest gaps and NO `scrydex-trend` rows (±10% gate). Do NOT assert fabricated graded (PSA/BGS) series — graded-series drawability is UNRESOLVED (Audit L2)
    - These tests must fail against current `scrydex-trend` behavior before 2.2–2.6 land
    - _Requirements: 2.3, 7.2, 7.3, 7.4_
  - [~] 2.2 Extend `ScrydexCardSchema` metadata + add BGS to `pickGradedPrice` in `scrydex.service.ts`
    - Add nullish fields: `supertype`, `subtypes[]`, `hp`, `types[]`, `rules[]`, `abilities[]`, `attacks[]`, `weaknesses[]`, `retreat_cost`/`retreat`, `artist`, `rarity`, `rarity_code`, `language`/`language_code`, `number`, `printed_number`, `expansion.{name,series,code}` — each missing field → `null`, never fabricated
    - Keep client Prisma-free; `pickGradedPrice(card, grade, "BGS")` as first-class tier alongside PSA; accessors stay pure, never cross tiers
    - _Requirements: 6.1, 6.2, 7.1_
  - [ ] 2.2a Verify the Scrydex-returned-id → Dojo-id mapping BEFORE wiring history/listings (no fabricated mapping)
    - LOCAL FIRST (0 credits): inspect `resolveScrydexCard` + the IDs already stored in Postgres for a known card (`Card.externalId` vs cached `Card.scrydexId`); determine whether the stored `scrydexId` equals `externalId` or differs
    - Preserve all three ids (Card.id / externalId / scrydexId); do NOT hardcode a mapping or assume the price_history/listings `{id}` equals externalId
    - If local inspection is inconclusive, STOP and request Owner_Approval for the smallest single-card live check (Audit L0, ≤5 credits per candidate id) with an explicit credit estimate — do not dispatch without approval
    - _Requirements: 6.6, 5.5_
  - [~] 2.3 Write property tests for schema boundary + price accessors
    - **Property 1: Zod validates and drops at every boundary** — Validates Requirements 5.2, 6.2, 6.5
    - **Property 2: Zero valid cards raises NoResultsError** — Validates Requirements 6.3
    - **Property 4: Price accessors never cross tiers** — Validates Requirements 7.1
    - _Requirements: 5.2, 6.2, 6.3, 6.5, 7.1_
  - [x] 2.4 Remove `scrydex-trend` backfill; source RAW history from the documented `price_history` endpoint in `scrydex-pricing.service.ts`
    - Delete `buildTrendBackfill()` and the step-4 first-pull `source="scrydex-trend"` write (Req 7.2)
    - Fetch RAW history from `GET /pokemon/v1/cards/{id}/price_history` using the **Scrydex-returned card id** (do NOT assume it equals externalId/scrydexId — see 2.2a); filter type=raw/condition=NM for the NM series; store each returned point verbatim with its real `date` as recordedAt, `source="scrydex"`, variant, condition, `sourceCurrency`; write NOTHING when `market==null && low==null` (honest gap, never `$0`)
    - Keep the 24h `SyncLog(job="scrydex_history")` freshness gate + per-call credit meter (`SyncLog.credits`, price_history = 3 credits)
    - GRADED (PSA/BGS) history series are UNRESOLVED (Audit L2 — response may not label company/grade; one-call-vs-N-call unknown): do NOT store or draw graded history series yet. Current graded PRICE via `pickGradedPrice` on the card object is separate and allowed
    - NO live history call / bulk pull without Owner_Approval + explicit credit estimate (Checkpoint D)
    - _Requirements: 6.3, 6.6, 7.1, 7.2, 7.3, 7.4, 7.6, 8.3_
  - [~] 2.5 Write property test for no-fabrication
    - **Property 5: No fabricated or synthesized price points** — Validates Requirements 7.2, 7.3, 7.4, 16.2
    - _Requirements: 7.2, 7.3, 7.4, 16.2_
  - [~] 2.6 Add Prisma schema deltas and generate the additive migration
    - `User.scanCount Int @default(0)`, `User.onboardingCompletedAt DateTime?`, `UserCollection.costBasisAttemptedAt DateTime?`, `PricingHistory.sourceCurrency String?` (backfill legacy = `currency`)
    - Run `prisma generate`; create the migration file but do NOT apply to prod here
    - _Requirements: 10.1, 12.1, 17.1, 9.1_
  - [~] 2.7 Implement `fx.service.ts` (NEW, server-only) current-price-only conversion
    - `convertCurrent(amount, from, to:"USD"|"EUR")` → `{amount, currency, converted}`; identity when `from===to`; no rate → source-native + `converted:false` (never fabricated) (Reqs 9.2, 9.4, 9.5)
    - Daily rate cached in Redis `RedisKeys.fxRate(base)` TTL 24h, re-Zod on read, fail-open to live fetch; pure helper `applyRate(amount, rate)` extracted for unit test
    - NEVER convert history points (Req 9.3)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_
  - [~] 2.8 Write property test for FX conversion
    - **Property 7: FX converts current prices only, never history, with honest conversion math** — Validates Requirements 9.1, 9.2, 9.3, 9.5
    - **Property 17: Redis failure falls through to live data** — Validates Requirements 5.4
    - _Requirements: 5.4, 9.1, 9.2, 9.3, 9.5_
  - [~] 2.9 Constrain `pokewallet.service.ts` to current-price-only fallback
    - Expose only current-price getters (`fetchOnePieceSetPrices`, `fetchPokemonCardPrice`); NO history producer (Req 8.1)
    - Enforce fallback precedence: resolved current = Scrydex current ?? PokéWallet current ?? null; label each stored price with its `DataSource` (`SCRYDEX`/`POKEWALLET`/`TCGDEX`) (Reqs 8.2, 8.3)
    - _Requirements: 8.1, 8.2, 8.3_
  - [~] 2.10 Write property test for PokéWallet fallback behavior
    - **Property 6: PokéWallet is current-price-only and used only as fallback** — Validates Requirements 8.1, 8.2, 8.3
    - _Requirements: 8.1, 8.2, 8.3_
  - [~] 2.11 Extend `/api/cards/[id]/history` payload with native `currency`/`tier`/`grade`; keep 200-on-failure
    - Empty `points[]` = honest no-history; client no longer falls back to a mock series (Reqs 5.6, 7.4)
    - _Requirements: 5.6, 7.4, 9.1_
  - [~] 2.12 Write integration test for public history route graceful degradation
    - **Property 16: Public card/pricing routes degrade to 200 + fallback** — Validates Requirements 5.6, 14.3, 7.4
    - _Requirements: 5.6, 7.4_
  - [~] 2.13 Update docs for P1
    - `docs/ARCHITECTURE.md` (fx.service, removed backfill, schema deltas, `fx:rate` Redis key + TTL), `docs/API_REFERENCE.md` (history payload shape), `docs/CODE_MAP.md` (new/changed files)
    - _Requirements: 2.2_
  - [~] 2.14 **Owner-approval checkpoint (Checkpoint D — NON-CODING STOP) + phase close.**
    - Request Owner_Approval before applying the additive migration AND the destructive data migration deleting `PricingHistory where source="scrydex-trend"` (runs via `prisma migrate` with `DIRECT_URL`) (Reqs 4.1, 4.2)
    - Then run lint + type-check + `npm run verify`; report Checkpoint C evidence (changed files, migrations, commands, Scrydex credits consumed, data gaps)
    - _Requirements: 2.2, 3.1, 3.3, 4.1, 4.2, 5.8_

- [ ] 3. P2 — Search & card detail (depends on P1)
  - [~] 3.1 Update F-06/F-08 tests FIRST for tag-indexed metadata search + UI cleanups (TDD)
    - Assert extended metadata is searchable via `tags`, and that search-icon/Accessories removals and the eBay-sold swap are reflected
    - _Requirements: 2.3, 14.1_
  - [~] 3.2 Index extended metadata into searchable `tags[]` via `buildTags` in `sync-cards.service.ts` → `upsertCard`
    - Fold artist, supertype, subtypes, expansion series/name into GIN-indexed `tags[]` (reuse existing `tags:{has}` search — no schema change); carry `printed_number`/`hp`/`abilities`/`attacks`/`weaknesses`/`retreat`/`rules` for the detail view
    - _Requirements: 14.1_
  - [~] 3.3 Wire Scrydex-backed search route + card-detail view
    - `/api/cards/search` reads local Postgres keyed by `externalId`, offset pagination with numeric `nextCursor`, 200 + fallback on failure (Reqs 14.1, 14.3, 14.4)
    - `(dashboard)/search/[id]/page.tsx`: Scrydex current price FX-converted via `fx.service` + source-native RAW/PSA/BGS series; three-id discipline (detail link=`id`, history/graded/add=`externalId`, Scrydex pull=`scrydexId`); unresolved cost basis → unresolved indicator, never `$0` (Req 14.5)
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 5.5_
  - [~] 3.4 Write property tests for identifier discipline + pagination + degradation
    - **Property 3: Three-id discipline is never crossed** — Validates Requirements 5.5, 6.4, 14.1
    - **Property 16: Public routes degrade to 200 + fallback** — Validates Requirements 14.3
    - _Requirements: 5.5, 6.4, 14.1, 14.3, 14.4_
  - [~] 3.5 Remove search icon + Accessories block; replace Sellers-on-the-Floor with Scrydex eBay sold records
    - Remove top-line search icon and dummy Accessories block (`search/[id]/page.tsx` ~line 1032); keep star (favorite) + plus (add)
    - Section shows real recent SOLD records from the documented `GET /pokemon/v1/cards/{id}/listings` (fields: price/currency/sold_at/source, filter source=ebay, days=N); never active listings; empty → "No recent sales found."; design tokens only, square corners. One Piece sold-listing parity is UNRESOLVED (Audit L1/L3) — treat as GAP (empty state) until confirmed
    - _Requirements: 14.2, 5.7_
  - [~] 3.6 Implement manual-only population refresh — PSA English conditional, BGS unavailable
    - PSA ENGLISH only: fetch with `include=pop_reports`, ONLY on explicit user action ("Refresh population"); never on page load/search/scheduled sync; present only where card-level data is returned; no data → fallback state, never a fabricated number
    - BGS population: UNAVAILABLE under documented coverage — do NOT request/imply it; render fallback. Keep Vision slab grade-detection (PSA/BGS/CGC/TAG) distinct from population coverage
    - _Requirements: 15.1, 15.2, 15.3, 15.6_
  - [~] 3.7 Write integration test for manual-only population
    - **Property 18: Population refresh is manual-only with honest fallback** — Validates Requirements 15.1, 15.2, 15.3
    - _Requirements: 15.1, 15.2, 15.3_
  - [~] 3.8 Update docs for P2 (`CODE_MAP.md` detail-page changes, `API_REFERENCE.md` search contract, `ARCHITECTURE.md` metadata-tag indexing)
    - _Requirements: 2.2_
  - [~] 3.9 Checkpoint — run lint + type-check + matching test scope + `npm run verify`; report Checkpoint C evidence
    - Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 2.2, 3.1, 3.2, 5.8_

- [ ] 4. P3 — Portfolio sales & accounting (depends on P1)
  - [~] 4.1 Update F-11/F-15 tests FIRST and add F-23 (sales) scaffolding (TDD)
    - Pin unresolved-basis null-not-zero, realized/unrealized P&L, proportional allocation, and partial-sale quantity conservation before implementation
    - _Requirements: 2.3, 12.1, 13.1, 13.3_
  - [~] 4.2 Implement pure `src/lib/utils/portfolio-accounting.ts`
    - `realizedPnL(soldQty, grossPerCopy, basisPerCopy|null)` → `{status:"resolved",value}` or `{status:"unresolved"}` (null basis → unresolved, never number/0); `allocateBasis(totalBasis, soldQty, originalQty)` proportional so partial-sale allocations sum to original total basis
    - _Requirements: 12.3, 12.5, 13.3, 13.4_
  - [~] 4.3 Write property tests for accounting math
    - **Property 12: Unresolved cost basis is null-not-zero and reported "unresolved"** — Validates Requirements 12.1, 12.2, 12.3, 12.5, 13.4, 16.3
    - **Property 14: Sale conserves quantity and allocates cost basis proportionally** — Validates Requirements 13.1, 13.3
    - _Requirements: 12.1, 12.2, 12.3, 12.5, 13.1, 13.3, 13.4, 16.3_
  - [~] 4.4 Implement `portfolio.service.ts` (NEW): lazy cost-basis snapshot + resolution
    - At add: if no price determinable, store `purchasePrice=null` + `costBasisAttemptedAt=now()`; add ALWAYS succeeds; never store 0/invented (Reqs 12.1–12.3). Snapshot precedence: current Scrydex/stored → nearest Scrydex history point → unresolved
    - Lazy resolution on next successful `pullAndStoreScrydexPrice` for that card: set `purchasePrice` scoped `where:{id,userId}`, retain `costBasisAttemptedAt` (Reqs 12.4, 12.6)
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.6_
  - [~] 4.5 Write integration test for lazy resolution + ownership scoping
    - **Property 13: Lazy cost-basis resolution persists the next real price** — Validates Requirements 12.4
    - **Property 15: User-scoped mutations reject foreign ids** — Validates Requirements 5.3, 12.6, 13.5, 16.4
    - _Requirements: 5.3, 12.4, 12.6, 13.5_
  - [~] 4.6 Implement sell route `POST /api/users/me/collection/[id]/sell` (NEW)
    - Zod-validate body `{quantity (1≤q≤row.quantity), grossPricePerCopy, soldAt (editable, default today)}` (Req 13.2); scoped `where:{id,userId}` → P2025 → 404 (Req 13.5); over-quantity → 400
    - Partial sale splits row: sold `quantity` → sold row (`isSold:true`, `soldPrice=grossPerCopy*quantity`, `soldAt`, SAME `collectionId`), remainder stays active; quantity conserved. Full sale flips existing row. Bypass `[userId,cardId,isFoil]` dedup for the sold row (add route filters `isSold:false`, so active+sold coexist)
    - _Requirements: 13.1, 13.2, 13.5_
  - [~] 4.7 Wire portfolio stats + Sold section (same collection)
    - Market Value = Σ(current stored price × qty) active; Paid = Σ resolved basis × qty (unresolved excluded + flagged, never 0); Realized = Σ realized P&L over sold rows (unresolved shown unresolved); Unrealized = Market − Paid over resolved only
    - Sold rows render in a "Sold" section WITHIN the same collection; design tokens only
    - _Requirements: 13.3, 16.3_
  - [~] 4.8 Write integration test for sell route + sold-section invariants
    - Partial/full sale quantity conservation, same `collectionId`, 404 on foreign id (**Property 15**)
    - _Requirements: 13.1, 13.5_
  - [~] 4.9 Update docs for P3 (`API_REFERENCE.md` sell contract, `ARCHITECTURE.md` portfolio.service + accounting util + cost-basis flow, `CODE_MAP.md`)
    - _Requirements: 2.2_
  - [~] 4.10 Checkpoint — run lint + type-check + matching test scope + `npm run verify`; report Checkpoint C evidence
    - Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 2.2, 3.1, 3.2, 5.8_

- [ ] 5. P4 — Scanner (depends on P0 audit + P1 ids/schema)
  - [~] 5.1 Update F-14 tests FIRST for Scrydex identify, scan allowance, upload validation (TDD)
    - Pin Scan_Limit resolution, atomic reserve concurrency, size/MIME rejection with no increment, image-discard, and safe error states before implementation
    - _Requirements: 2.3, 10.2, 10.4, 11.1, 11.2_
  - [~] 5.2 Implement pure `src/lib/utils/scan-limit.ts`
    - Read `SCAN_LIMIT` env (or tier constant); default 10; invalid/empty/negative/non-numeric → default; paid tier → that tier's configured limit
    - _Requirements: 10.2, 10.3_
  - [~] 5.3 Write property test for Scan_Limit resolution
    - **Property 8: Scan_Limit resolution** — Validates Requirements 10.2
    - _Requirements: 10.2_
  - [~] 5.4 Implement `scan-allowance.service.ts` (NEW) atomic reserve
    - `reserveScan(userId, limit)` via `prisma.user.updateMany({where:{id,scanCount:{lt:limit}}, data:{scanCount:{increment:1}}})` → `count===1`; guarantees final count ≤ limit under concurrency; `false` → limit reached (Req 10.6)
    - _Requirements: 10.1, 10.4, 10.6_
  - [~] 5.5 Write property/integration test for allowance concurrency
    - **Property 9: Scan allowance never exceeds limit under concurrency; only successful matches consume** — Validates Requirements 10.4, 10.5, 10.6, 11.4
    - _Requirements: 10.4, 10.5, 10.6, 11.4_
  - [~] 5.6 Wire Scrydex identify into `/api/cards/recognize`, replacing Vision; add upload validation + image discard
    - `scrydex.service.identifyCard(imageBase64)` to the audit-confirmed endpoint (Zod-parse body; name the path in a load-bearing comment); key + team id server-side only (Req 10.7); remove Vision from the recognize path, keep Tesseract fallback for no-match/unavailable
    - Flow: identify user from Better Auth server session → validate upload BEFORE identify (>20MB → 400, MIME against Scrydex allow-list → 400, no increment, no identify) → at-limit → `limit-reached` (200, no identify) → identify → increment via `reserveScan` ONLY on successful match → discard image (in-memory only, persist nothing; `ScanFeedback` stores match reference, never image bytes)
    - _Requirements: 10.4, 10.5, 10.6, 10.7, 11.1, 11.2, 11.3, 11.4_
  - [~] 5.7 Write unit/integration tests for upload validation + image disposal + session-scoping
    - **Property 10: Upload size accepted iff ≤ 20MB** — Validates Requirements 11.1
    - **Property 11: Upload MIME accepted iff in supported set** — Validates Requirements 11.2
    - Image-discard (nothing persisted) and server-session user identity (Reqs 11.3, 10.7); secrets not logged (Req 4.4)
    - _Requirements: 10.7, 11.1, 11.2, 11.3, 4.4_
  - [~] 5.8 Update docs for P4 (`API_REFERENCE.md` recognize contract + scanAllowance states, `ARCHITECTURE.md` scan-allowance.service + identify path + Vision removal, `CODE_MAP.md`)
    - _Requirements: 2.2_
  - [~] 5.9 Checkpoint — run lint + type-check + matching test scope + `npm run verify`; report Checkpoint C evidence (incl. identify credit cost)
    - Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 2.2, 3.1, 3.3, 5.8_

- [ ] 6. P5 — Dashboard, collections & onboarding (depends on P1 + P3)
  - [~] 6.1 Update F-02/F-09/F-10/F-11/F-22 tests FIRST and add F-24 (onboarding) (TDD)
    - Pin real home-chart (no mock series), ALL virtual non-editable view, per-collection series (never summed, no pre-entry value), and account-persisted onboarding before implementation
    - _Requirements: 2.3, 16.1, 17.1_
  - [~] 6.2 Implement pure `src/lib/utils/collection-series.ts`
    - `buildCollectionSeries(holdings, history, range)` → one series per collection; value at `t` = Σ copies with `addedAt<=t` and not sold-before-`t` of (nearest real history point ≤ `t`) × qty; no value before earliest `addedAt`; genuine gaps stay gaps; NEVER sums series
    - _Requirements: 16.1, 16.2_
  - [~] 6.3 Write property tests for ALL view + comparison chart
    - **Property 19: ALL view aggregates all owned copies and is non-editable** — Validates Requirements 16.1, Area 5 ALL-view
    - **Property 20: Comparison chart renders per-collection series, never summed, no pre-entry value** — Validates Area 5 comparison-chart
    - _Requirements: 16.1, 16.2_
  - [~] 6.4 Implement virtual non-editable ALL view + per-collection carousel summaries
    - Synthesize ALL in the query/selector layer with reserved id `"__all__"` aggregating all owned copies incl. `collectionId==null`; collections API REJECTS writes targeting the virtual id (rename/delete/file-into → 400); per-collection + ALL summary cards (count, market value, realized/unrealized with unresolved flagged); scope collection queries to the authenticated user
    - _Requirements: 16.1, 16.3, 16.4_
  - [~] 6.5 Write integration test for ALL-view mutation rejection + user-scoped collection queries
    - **Property 15: User-scoped mutations reject foreign ids** — Validates Requirements 16.4
    - **Property 19** mutation-rejection branch — Validates Area 5 ALL-view
    - _Requirements: 16.3, 16.4_
  - [~] 6.6 Fix dashboard home chart + card-image/loading bugs; remove intent sections
    - Replace mock `generateMockChartData` + mocked shading/date-range with the real stored-history pipeline (shading + visible range agree with plotted real points; no value before a card entered; honest gaps); fix card-tile image click → detail popup; resolve loading-state bug where tiles render; remove Want to Buy/Sell/Trade intent sections from `DashboardClient.tsx` (kept on `/wantlist`); design tokens only
    - _Requirements: 16.1, 16.2_
  - [~] 6.7 Wire real `MultiLineComparisonChart` from `collection-series.ts`
    - One shaded area per selected collection, never summed; honest gaps; correct date/quantity/ownership intervals (`[addedAt, soldAt)`)
    - _Requirements: 16.1, 16.2_
  - [~] 6.8 Implement account-persisted onboarding + routes
    - `GET /api/users/me/onboarding` → `{completed}` (session-scoped); `POST` `{action:"continue"|"skip"}` sets `onboardingCompletedAt=now()` if unset (idempotent, one-time), read/written from Better Auth server session; replace `(onboarding)/profile` localStorage flag; completed user never re-prompted across devices
    - _Requirements: 17.1, 17.2, 17.3_
  - [~] 6.9 Write integration test for onboarding persistence
    - **Property 21: Onboarding completion persists per account across sessions** — Validates Requirements 17.1, 17.2
    - _Requirements: 17.1, 17.2, 17.3_
  - [~] 6.10 Update docs for P5 (`API_REFERENCE.md` onboarding routes + ALL-view write rejection, `ARCHITECTURE.md` collection-series + ALL virtual view + onboarding persistence, `CODE_MAP.md`)
    - _Requirements: 2.2_
  - [~] 6.11 Final checkpoint — run lint + type-check + `npm run verify`; report Checkpoint C evidence; confirm Verification_Gate green
    - Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 2.2, 3.1, 3.2, 5.8_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Property-test sub-tasks reference the design's Correctness Properties (P1–P21) and the requirement clauses they validate.
- F-number-pinned behavior changes update the test FIRST (Req 2.3) — see the `.1` TDD sub-task opening each phase.
- Checkpoint tasks run `npm run verify` and report Checkpoint C evidence (changed files, migrations, commands, Scrydex credits, data gaps) per Req 3.
- **Owner-approval gates (Checkpoint D)** are explicit NON-CODING stops at task 1.4 (audit sign-off) and task 2.14 (additive + destructive `scrydex-trend` migration). No production migration, bulk refresh, or nontrivial paid-credit operation proceeds without recorded Owner_Approval (Req 4).
- Secrets are referenced by NAME only across all phases; never logged, reported, or committed (Req 4.4).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["2.1"] },
    { "id": 3, "tasks": ["2.2", "2.7", "2.9"] },
    { "id": 4, "tasks": ["2.3", "2.8", "2.10"] },
    { "id": 5, "tasks": ["2.4", "2.6", "2.11"] },
    { "id": 6, "tasks": ["2.5", "2.12"] },
    { "id": 7, "tasks": ["2.13"] },
    { "id": 8, "tasks": ["3.1", "4.1", "5.1", "6.1"] },
    { "id": 9, "tasks": ["3.2", "4.2", "5.2", "6.2"] },
    { "id": 10, "tasks": ["3.4", "4.3", "5.3", "6.3"] },
    { "id": 11, "tasks": ["3.3", "4.4", "5.4"] },
    { "id": 12, "tasks": ["3.5", "4.5", "5.5", "6.4"] },
    { "id": 13, "tasks": ["3.6", "4.6", "5.6", "6.5"] },
    { "id": 14, "tasks": ["3.7", "4.7", "5.7", "6.6"] },
    { "id": 15, "tasks": ["4.8", "6.7"] },
    { "id": 16, "tasks": ["3.8", "4.9", "5.8", "6.8"] },
    { "id": 17, "tasks": ["6.9", "6.10"] }
  ]
}
```




