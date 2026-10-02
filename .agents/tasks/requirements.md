# Requirements — External API Integration (catalog, pricing, charts, scanning, PSA grading)

## Summary

Wire Dojo's external data providers so that catalog data, current prices, real
chart history, card scanning, and PSA graded pricing work end to end against the
**verified live contracts** in `.agents/tasks/api-integration-contracts.md`. Nine
deliverables span three rewritten service clients (PokéWallet/BerryWallet,
Scrydex), the sync engine, two new persistence behaviours (store-and-reuse Scrydex
pricing; portfolio value snapshots on add), UI wiring to real stored data, a
backfill pilot script, a full test pass, and a user-facing manual testing checklist.

The guiding principle from AGENTS.md is **never fabricate data**: a missing real
value becomes `null` and renders "—". The only sanctioned derived data is the
Scrydex trend-delta backfill, which is explicitly labelled so it is distinguishable
from fresh snapshots.

### Working context the design MUST reconcile first (verified, not assumed)

Investigation of the worktree at `.worktrees/api-integration` (branch
`feat/api-integration`, commit `022233c`) found that it does **not** yet contain
several files the task treats as the starting point. Those files exist only as
**uncommitted/untracked changes on the main checkout** (`d:\…\Pokemon`, same commit
`022233c`):

- `src/lib/services/scrydex.service.ts` — untracked (the "wrong auth" scaffold).
- `src/lib/services/pokewallet.service.ts` — untracked (the "wrong `.com/v1` + Bearer" scaffold).
- `src/lib/services/tcgdex.service.ts` — untracked.
- `scripts/scrydex-backfill.ts` — untracked.
- `src/app/api/users/me/collection/history/route.ts` — untracked (real-history endpoint).
- `prisma/schema.prisma` — modified: adds `Game` enum, `DataSource` enum
  (`TCGDEX`/`POKEWALLET`/`SCRYDEX`), `Card.game` + `Card.source`, the **enriched**
  `PricingHistory` (`priceMarket`, `priceLow`, `source`, `currency`, `variant`,
  `condition`, unique on `[cardId, recordedAt, source, currency, variant, condition]`),
  the new `CurrentPrice` model (unique on `[cardId, source, currency, variant, condition]`),
  and the new `SyncLog` model (`job`, `cardId`, `credits`, `status`, `error`, `ranAt`).

The worktree's committed `schema.prisma` still has the **old** `PricingHistory`
(single `price` column) and **no** `CurrentPrice`/`SyncLog`/`Game`/`DataSource`.
The task text ("model exists", "Rewrite the service") was written against the main
checkout's working tree, not against the worktree. **This is OPEN QUESTION #0 and
must be resolved before any deliverable can proceed** (see Open Questions). All
acceptance criteria below assume the enriched schema and scaffold files are present
in the worktree once #0 is resolved.

## Functional Requirements

### FR-1 — PokéWallet / BerryWallet client (`pokewallet.service.ts`), PRICING ONLY
- Call the real base `https://api.pokewallet.io` with header `X-API-Key:
  <POKEWALLET_API_KEY>` (NOT `Authorization: Bearer`; NOT the `.com/v1` domain).
- One Piece pricing: `GET /op/sets/{setCode}?limit=200`; per card read
  `tcgplayer.prices.market_price` (and `cardmarket.prices` as secondary). CM-only
  sets (negative `group_id`) have `tcgplayer: null` — fall back to `cardmarket` or
  `null`, never throw.
- Pokémon price fallback: `GET /search?q=<name>`; read `market_price`.
- Remove the dead endpoints `/prices/pokemon/{id}`, `/one-piece/sets`,
  `/one-piece/sets/{id}/cards` and the `fetchOnePieceSets`/`fetchOnePieceCards`
  catalog functions (catalog is NOT this service's job).
- Validate every external payload with Zod; a malformed/empty payload yields `null`
  price (graceful), not an exception that bubbles to the caller.

### FR-2 — Scrydex client (`scrydex.service.ts`)
- Call `https://api.scrydex.com` with **both** headers together: `X-Api-Key:
  <SCRYDEX_API_KEY>` and `X-Team-ID: <SCRYDEX_TEAM_ID>` (replace the wrong
  `Authorization: Bearer`). Per-game base paths `/pokemon/v1/...` and
  `/onepiece/v1/...` (confirm the One Piece slug with ONE spaced live probe).
- **FR-2a Current + graded prices:** `GET /{game}/v1/cards/{externalId}?include=prices`.
  Prices live in `variants[].prices[]`; each entry carries `type` (`"raw"` =
  ungraded, else graded), `company` (`"PSA"`/`"CGC"`/…), `grade`, `market`, `low`,
  `currency`, and `trends.{days_1,days_7,days_14}.{price_change,percent_change}`.
- **FR-2b Raw price accessor:** a function returning the raw/NM `market` and `low`.
- **FR-2c Graded lookup:** pick the `prices[]` entry where `type != "raw"`,
  `company == "PSA"`, and `grade` matches the requested grade; return `null` when
  absent.
- **FR-2d Vision identify:** discover the Vision endpoint via a FEW live POST probes
  spaced 3–5s apart (rapid repeats trip Cloudflare and hang), using a real small
  base64 image and the live key. Candidate paths are in the contracts file. If a
  working endpoint resolves, return `{ cardId/externalId, confidence, name, setCode }`;
  if none resolves, **keep the existing graceful fallback** (return `null` so
  `recognize/route.ts` signals the client to run on-device Tesseract) and document
  that it was not resolved. Never fabricate a match.
- There is **no** historical time-series endpoint (`/prices/history/...` → 404). The
  rewritten service must not call one; the old `fetchPriceHistory` contract is
  replaced by store-and-accumulate (FR-4).
- Validate all responses with Zod; re-parse cached payloads on read.

### FR-3 — Sync engine (`sync-cards.service.ts`)
- TCGdex stays the **primary Pokémon catalog** (metadata + images, no prices).
- One Piece **catalog** stays on apitcg.com in `card.service.ts` — unchanged.
- Price fallback order for cards that have no TCGdex/apitcg price: TCGdex (none) →
  PokéWallet/BerryWallet (price only, via FR-1). Wire BerryWallet into the One Piece
  price path and PokéWallet into the Pokémon active-card price path.
- Preserve existing smart-sync behaviour: only (re)price cards that appear in a user
  collection or want list; the staleness window; game interleave; the wall-clock
  budget; and fetch-before-upsert so a failed fetch retries next run.

### FR-4 — Store-and-reuse Scrydex pricing
- On each Scrydex price pull for a card: INSERT a `PricingHistory` row
  (`priceMarket`, `priceLow`, `source = "scrydex"`, `variant`, `condition`,
  `recordedAt = now`) and UPSERT the matching `CurrentPrice` row (unique on
  `cardId + source + currency + variant + condition`).
- **First-pull backfill (optional, bounded):** derive up to 3 prior points from the
  `trends` deltas — now, −1d (from `days_1`), −7d (from `days_7`), −14d (from
  `days_14`) — written with a distinguishable `source = "scrydex-trend"` so a
  brand-new card shows a short real-derived line. Never fabricate beyond trend
  deltas.
- **Freshness gate:** skip re-pulling from Scrydex when the newest
  scrydex-sourced `CurrentPrice`/`PricingHistory` row is newer than a stale window
  (named constant, e.g. 24h, with a `ponytail:` comment naming the ceiling).
- Record every pull in `SyncLog(job = "scrydex_history", cardId, credits, status)`.

### FR-5 — Portfolio value snapshot on add
- When a user adds card(s) to a collection, capture a portfolio value data point so
  the portfolio/dashboard average-value graph reads real stored data instead of
  synthetic PRNG shapes.
- Must preserve `assignBulkAddOrder`'s strictly-decreasing `addedAt` behaviour
  (F-15) and the existing add idioms in `api/users/me/collection/route.ts`
  (externalId reuse, graded-vs-raw dedupe, ownership scoping).
- The modelling choice (dedicated snapshot table vs reuse of
  `PricingHistory`/`CurrentPrice` aggregation) is OPEN QUESTION #1.

### FR-6 — Wire UI to real stored data
- Card-detail chart (`search/[id]/page.tsx`): prefer real `PricingHistory`; keep a
  graceful empty/short-line state when no real data exists. Remove mock fallback
  **only** where real data is actually available.
- Dashboard portfolio chart (`DashboardClient.tsx`): read the real-history endpoint
  (`api/users/me/collection/history`) where data exists; keep the empty-chart state
  otherwise. (The current worktree `DashboardClient` still uses
  `generateMockChartData`; the uncommitted mainline version adds a `realHistory`
  path — this must land in the worktree.)
- PSA graded pricing: route through Scrydex (FR-2c), with the curated
  `graded-price.ts` table + PSA cert verify (`psa-price.service.ts`) as the OFFLINE
  fallback when Scrydex has no graded entry or the call fails. `resolveGradedPrice`
  already models the live-source-with-fallback flags — reuse it, do not reinvent.
- Scanner (`scanner/page.tsx` + `api/cards/recognize/route.ts`): add Scrydex Vision
  as a signal with the on-device Tesseract fallback already present. The existing
  "no Vision → `ocrSource: "unavailable"` → client runs Tesseract" path must remain
  intact.

### FR-7 — Backfill pilot (`scripts/scrydex-backfill.ts`)
- Pilot exactly **10 active cards** (cards present in some user collection). Fetch
  their prices from Scrydex, persist via FR-4, and log total credit usage plus a
  per-card `SyncLog` to measure cost before any bulk backfill.
- Idempotent and respects the FR-4 freshness gate.

### FR-8 — Tests (no live network)
- Unit + integration tests with mocked `fetch`/Prisma for: the rewritten PokéWallet
  mapper (incl. a CM-only `tcgplayer: null` card), the Scrydex price/graded mappers,
  the freshness gate, the portfolio snapshot, and graded-price routing. Follow the
  existing `tests/unit` + `tests/integration` style; no new frameworks or fixtures;
  change the F-numbered test first where behaviour changes.
- Playwright e2e: search → add → portfolio chart shows a real point; card-detail
  chart renders; scanner with mocked Vision + Tesseract fallback (camera project
  uses a fake media device); graded (PSA 10) add + price.
- Run `npm run verify` in the worktree and fix all failures; report exact
  pass/fail counts.

### FR-9 — User testing checklist
- Produce `.agents/tasks/USER_TESTING_CHECKLIST.md` (landed on mainline via the
  final rebase): a concrete step-by-step manual script covering catalog search
  (both games), add to collection, portfolio average graph (real + grows on next
  pull), card-detail price + real chart, One Piece pricing via BerryWallet, Pokémon
  pricing via TCGdex→PokéWallet fallback, PSA graded via Scrydex, scanning via
  Scrydex Vision + Tesseract fallback, and daily sync via the cron route — each with
  its exact expected result and how to tell real data from a graceful fallback
  ("—" = no data, not a bug).

## Non-Functional Requirements (AGENTS.md non-negotiables)

- **NFR-1 Zod at every boundary.** External payloads, cached payloads (re-parse on
  read), and request bodies all pass Zod. A source with 0 valid cards throws
  `NoResultsError` so the fallback chain advances without tripping the breaker.
- **NFR-2 Never fabricate data.** No invented prices; missing value → `null` → "—".
  The only derived data allowed is the FR-4 trend backfill, labelled
  `source = "scrydex-trend"`.
- **NFR-3 Two card ids.** `Card.id` (cuid) vs `Card.externalId` (catalog id).
  Scrydex/PokéWallet/history all key on `externalId`; never confuse them.
- **NFR-4 Graceful degradation on public card routes.** Public card/scan routes
  return HTTP 200 with empty/fallback payloads, never 5xx, on upstream failure.
- **NFR-5 Server/client discipline.** Service clients and secret-reading code are
  server-only; the Scrydex/PokéWallet/Vision keys never reach the browser.
- **NFR-6 Ownership scoping.** User-scoped reads/writes use `where: { …, userId }`.
- **NFR-7 Redis optional.** Any caching added is try/catch with fall-through to live
  data; nothing stored in Redis that isn't reconstructable from Postgres.
- **NFR-8 Rate/credit discipline.** Respect PokéWallet's 1,000 req/day free tier via
  batching/caching; gate Scrydex pulls with the freshness window (FR-4) to minimise
  credit burn; space any live probing 3–5s apart.
- **NFR-9 Load-bearing comments.** Preserve the WHY comments in sync-cards,
  collection route, bulk-add-order, graded-price, and recognize route.

## Acceptance Criteria

1. `pokewallet.service.ts` calls `api.pokewallet.io` with `X-API-Key`; the old
   `.com/v1` domain, `Authorization: Bearer`, and the three dead endpoints are gone.
2. The PokéWallet One Piece mapper returns a numeric `market_price` for a normal
   card and `null` (no throw) for a CM-only card where `tcgplayer: null`; a vitest
   check exercises both shapes against the real response structure.
3. The PokéWallet Pokémon fallback reads a price from `GET /search?q=<name>`.
4. `scrydex.service.ts` sends both `X-Api-Key` and `X-Team-ID` on every request;
   omitting `X-Team-ID` is proven (by test or documented probe) to 401.
5. The Scrydex raw accessor returns `market` + `low` from the `type == "raw"` entry;
   it returns `null` cleanly when no raw entry exists.
6. The Scrydex graded lookup returns the `type != "raw"`, `company == "PSA"`,
   grade-matching entry, and `null` when no such entry exists.
7. The Vision endpoint is either resolved (documented path + working identify) OR
   explicitly documented as unresolved with the `null` → Tesseract fallback intact;
   no fabricated match is ever returned.
8. The sync engine prices One Piece via BerryWallet and Pokémon active cards via
   PokéWallet only when TCGdex/apitcg has no price; One Piece catalog still comes
   from apitcg.com; smart-sync, staleness, interleave, and wall-clock budget are
   unchanged.
9. A Scrydex price pull writes one `PricingHistory` row (`source = "scrydex"`) and
   upserts one `CurrentPrice` row keyed by `cardId + source + currency + variant +
   condition`.
10. A first pull optionally writes up to 3 `source = "scrydex-trend"` backfill points
    derived from `days_1`/`days_7`/`days_14` deltas, distinguishable from fresh
    snapshots; no points are written beyond the trend-derived ones.
11. A re-pull within the freshness window is skipped (no new Scrydex call, no new
    row); a pull outside the window proceeds. The window is a named constant with a
    `ponytail:` comment.
12. Every Scrydex pull writes a `SyncLog(job = "scrydex_history", cardId, credits,
    status)` row.
13. Adding card(s) to a collection records a portfolio value data point readable by
    the portfolio/dashboard graph; `assignBulkAddOrder`'s strictly-decreasing
    `addedAt` ordering is preserved (F-15 test still passes).
14. The card-detail chart renders real `PricingHistory` where it exists and a
    graceful empty/short-line state otherwise (never crashes, never fabricates).
15. The dashboard portfolio chart reads real history where it exists and keeps the
    empty-chart state otherwise.
16. PSA graded price resolves from Scrydex when available, else from the curated
    table / PSA cert fallback, with the live-vs-fallback distinction surfaced via
    `resolveGradedPrice` flags.
17. The scanner uses Scrydex Vision when available and falls back to on-device
    Tesseract via the existing `ocrSource: "unavailable"` signal when it is not.
18. `scripts/scrydex-backfill.ts` processes exactly 10 collection-active cards,
    persists via FR-4, logs total + per-card credit usage, is idempotent, and
    respects the freshness gate.
19. New unit/integration tests exist for FR-1, FR-2, FR-4 (freshness gate), FR-5
    (snapshot), and FR-6 (graded routing), using mocked `fetch`/Prisma only.
20. `npm run verify` passes in the worktree; the report states exact pass/fail
    counts for lint, unit, integration, chart-accuracy, and e2e.
21. `.agents/tasks/USER_TESTING_CHECKLIST.md` exists with step-by-step manual steps,
    exact expected results, and the real-vs-fallback ("—") guidance for every
    feature listed in FR-9.

## Out of Scope

- Changing the One Piece **catalog** source (stays apitcg.com) or TCGdex as the
  Pokémon catalog primary.
- Any Scrydex PRO / Marketplace-Insights endpoints or the PokéWallet PRO bulk
  `/op/prices` endpoint.
- A general historical time-series import (no such Scrydex endpoint exists); history
  accumulates one real point per pull plus the bounded trend backfill.
- Bulk backfill beyond the 10-card pilot (the pilot measures cost; bulk is a later,
  separately-approved step).
- Vercel environment-variable cleanup (the earlier CLI token was rejected; this is a
  manual dashboard task for the user).
- Replacing the dashboard's mocked per-card deltas / gainers-losers tabs — only the
  portfolio **value chart** is converted to real data in this task.
- OTP/phone auth, population report, `/admin/transactions`, and other intentional
  stubs in AGENTS.md §6.

## Open Questions (design MUST resolve)

0. **Worktree vs mainline state (blocking).** The rewritten-target service files,
   the real-history route, and the enriched schema (`Game`, `DataSource`,
   `CurrentPrice`, `SyncLog`, enriched `PricingHistory`) exist only as uncommitted
   changes on the main checkout, not in the worktree. How do they land in the
   worktree — cherry-pick/import the uncommitted work, re-create it fresh, or treat
   the mainline working tree as the authoritative scaffold to copy in? And is a
   Prisma migration (`db:migrate`/`db:push`) against the remote Supabase DB in
   scope, given e2e needs a reachable `DATABASE_URL` with these tables present?
   *Assumption pending confirmation:* the uncommitted mainline scaffold + schema is
   the intended starting point and should be brought into the worktree, with the
   schema applied to the DB before e2e.
1. **Portfolio-snapshot modelling.** Dedicated snapshot table/model vs reuse of
   `PricingHistory`+quantity aggregation (the existing history route already
   aggregates `PricingHistory.priceMarket × quantity` per day). *Assumption pending
   confirmation:* reuse `PricingHistory`/`CurrentPrice` aggregation (smallest
   correct change) and ensure an add triggers a priced snapshot for the added
   card(s), rather than adding a new table — but confirm whether the graph must
   capture total-portfolio value at add-time (needs a new table) vs per-card prices
   it can aggregate on read (no new table).
2. **Trend-derived backfill point semantics.** Confirm the backfill writes exactly
   the points implied by the deltas (now, −1d, −7d, −14d) and that `price_change` is
   applied as `market − delta` to reconstruct the prior absolute price (vs some
   percent-based reconstruction). Confirm backfill runs only on the FIRST pull per
   card/variant/condition.
3. **Freshness-window constant.** Confirm 24h (contracts suggest 24h; `graded-price.ts`
   uses a separate 7-day staleness for graded data). Decide whether the Scrydex
   freshness window and the graded staleness window are the same constant or two.
4. **Vision endpoint resolution contingency.** If no Vision endpoint resolves during
   live probing, confirm shipping with the documented `null`→Tesseract fallback is
   acceptable for this task (vs blocking on a provider answer).
5. **`DataSource` enum vs free-text `source`.** `CurrentPrice.source` is the
   `DataSource` enum (`TCGDEX`/`POKEWALLET`/`SCRYDEX`) while `PricingHistory.source`
   is free text. The `"scrydex-trend"` label fits `PricingHistory` but not the
   `CurrentPrice` enum — confirm trend points go to `PricingHistory` only (not
   `CurrentPrice`), which the design should state explicitly.
