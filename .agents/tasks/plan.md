# Implementation Plan — Portfolio value-over-time chart pipeline (A/B/C)

Worktree: `d:\Pokemon\Pokemon\.worktrees\portfolio-value-series` (branch `portfolio-value-series`).
Windows/PowerShell — quote all paths. Git: `git -C "d:\Pokemon\Pokemon\.worktrees\portfolio-value-series"`.
Zero external credits — pure code + Prisma-read logic only. Do NOT touch `prisma/schema.prisma`,
`src/lib/auth.ts`, or any Scrydex enrich / credit-gate / `SCRYDEX_ONVIEW` config.

## Context discovered during exploration (ground truth, not assumptions)

- **Two chart builders.** `buildCollectionHistories` (`src/lib/services/collection-history.service.ts`,
  server-only, Prisma reads) orchestrates DB reads + timeline + calls the pure
  `buildCollectionSeries` (`src/lib/utils/collection-series.ts`). The dashboard comparison chart
  (one series per collection) AND the portfolio value chart (`collectionIds=all&range=ALL`) BOTH go
  through this same service/route — so a regression here hits both surfaces.
- **(A) The flat branch exists** in the service as the `isAllRange && earliestAdded >= nowMs - SHORT_WINDOW_DAYS*DAY_MS`
  block (SHORT_WINDOW_DAYS = 7). It emits a 2-point FLAT series (`[flatStart, nowMs]`) for a
  recent-but-real portfolio, masking real price movement. This is what must be dropped/neutralized.
- **(B) The ownership gate already drops sold lots** — `buildCollectionSeries` has
  `if (lot.soldAt != null && t >= lot.soldAt) continue;`. Once A makes the series a real moving line,
  the sale's drop becomes visible automatically. `statsFromLots` keeps Realized separate and is NOT
  touched. Requirement B is therefore mostly already satisfied by A; it needs an explicit regression test.
- **(C) Single-source variant parity is PARTLY done.** `collection-history.service.ts` already reads the
  latest graded `CurrentPrice` rows and threads a `gradedVariant` onto each `HoldingInterval`;
  `buildCollectionSeries` honours it; `pickGradedVariant`/`pickGradedFromRows`/`pickRealGradedPrice`
  are the shared selectors; the collection route already ships `card.gradedPrices` from `CurrentPrice`.
  What is MISSING for this task: (1) a shared helper that RETURNS the chosen real row
  `{price, variant, condition}` (today `pickGradedVariant` returns only a variant string); (2) the
  **missing-current-grade historical fallback** — when a lot's company+grade has graded `PricingHistory`
  but NO matching `CurrentPrice` row, both the chart and the API `gradedPrices` payload must value from
  the REAL historical row, preserving its actual variant + condition (never invent `normal`/``); (3)
  **bounded-window parity** — a lot the display path values (from unbounded `CurrentPrice`) must not be
  an all-null gap on the chart because its last matching `PricingHistory` point predates the requested
  window start.
- **Tests.** `tests/unit/collection-series.test.ts` (19) + `tests/unit/collection-history-service.test.ts`
  (22) are green at baseline. The history-service suite has a `describe("QA #6b short-window sparse shaping")`
  block whose assertions pin the OLD 2-point flat behaviour — those tests MUST be rewritten under A (they
  will otherwise fail, which is correct: the behaviour is being removed per owner confirmation). The
  history service is unit-tested with a **hoisted Prisma mock** (`userCollection`/`pricingHistory`/
  `currentPrice` `.findMany`) — follow that exact pattern for new service tests; no live DB.
- **Page-export guard (load-bearing).** `src/app/(dashboard)/portfolio/page.tsx` is a client page; no
  non-default export may be added to it. All new helpers go in `src/lib`. `tsc` does NOT catch this —
  verify by a manual grep (see step 9). `next build` cannot run here (remote DB busy).
- **Build/test commands:** `npm run type-check` (tsc --noEmit), `npm run lint`,
  `npm run test:unit` (vitest run tests/unit src), `npm run test:integration`. `npm run verify` also runs
  chart-accuracy + e2e which need a reachable remote DB / production build and are out of scope to run here.

## Design decisions (made here, grounded in the code above)

1. **A — neutralize, don't branch.** Delete the entire short-window flat block (and its `SHORT_WINDOW_DAYS`,
   `isAllRange`, `earliestAdded`/`latestAdded`/`flat` machinery that exists only to serve it). A recent-but-real
   portfolio then flows through the existing dense daily-grid + addedAt-anchor path, which already produces
   `>=2` valued points from real carry-forward. Rationale: the owner confirmed the flat placeholder is wrong;
   the dense grid is already honest (carry-forward of real `PricingHistory`, null gaps otherwise), so removing
   the branch is the smallest change that yields a real moving line. The `>=2 real points` empty-state
   (`chartData.length >= 2` in the page; honest "Not enough history to chart yet") is preserved untouched.
2. **C — one selector returns the real row.** Add a single helper `pickGradedRow(rows, company, grade, variant?)`
   in `src/lib/utils/raw-price.ts` next to the existing graded selectors, returning
   `{ price, variant, condition } | null` chosen by the SAME variant-priority rule `pickGradedVariant` uses
   (reuse it internally — no parallel rule). `pickGradedFromRows` is re-expressed as `pickGradedRow(...)?.price`
   so there is exactly ONE selection rule. Rationale: the task requires both the chart and the API payload to
   consume the same real identity; returning the row (not just a price or a variant) is what lets each caller
   take the field it needs from one decision.
3. **C — historical fallback source is per-lot, current-first.** The service decides each graded lot's identity
   from the CURRENT `CurrentPrice` snapshot first (existing behaviour, keeps chart↔display parity). Only when
   current has NO matching company+grade row does it fall back to the most-recent real graded `PricingHistory`
   row for that company+grade (via `pickGradedRow` over the lot's history rows), and threads THAT row's actual
   variant + condition into both the chart valuation (`gradedVariant`) and a new API `gradedPrices` fallback
   entry. Rationale: honours RULE 2 (real row only, real variant/condition), and fixes the audit's
   "graded history exists but no current row → all-null gap" case without fabricating.
4. **C — bounded-window parity via per-lot seed.** In the service, after the windowed `pricingHistory.findMany`
   (`recordedAt >= startDate`), run a SECOND bounded read for the last real matching point AT-OR-BEFORE
   `startDate` per (cardId, lot-identity) and prepend it as a seed `PricePoint`. Rationale: the display path is
   unbounded (latest `CurrentPrice`), the chart is windowed; seeding the carry-forward with the last real point
   before the window start makes a lot that display can price also drawable on the chart, without widening the
   whole query or inventing data. Chosen over "make both unbounded" because the chart window is a deliberate
   range feature (1M/3M/…); seeding is the minimal reconciliation.
5. **Commits are per-requirement:** one commit for A (+ its test rewrites), one for B (regression test), one for
   C (selector + fallback + bounded-window + API payload + docs + tests). Keep all load-bearing comments.

---

## Ordered items

- [ ] 1. **(C, foundation) Add `pickGradedRow` to the shared raw-price module and re-express `pickGradedFromRows` on top of it.**
      In `src/lib/utils/raw-price.ts`, add `export interface GradedRowPick { price: number; variant: string; condition: string | null }`
      and `export function pickGradedRow(rows, company, grade, variant?): GradedRowPick | null`. It filters the same
      `type==="graded" && company && grade && priceMarket != null` matches, chooses the variant via the EXISTING
      `pickGradedVariant` (preferred/explicit variant first, else its priority rule), returns the matched row's
      `{ price: rowPrice(row), variant: row.variant ?? "normal", condition: row.condition ?? null }`, or null when no
      match. Rewrite `pickGradedFromRows` to `return pickGradedRow(rows, company, grade, variant)?.price ?? null` so
      there is ONE selection rule. Do not change `pickGradedVariant`'s signature (other callers depend on it).
      Files: `src/lib/utils/raw-price.ts`
      Verify: `npx vitest run tests/unit/raw-price.test.ts src/lib/utils` (or the raw-price unit suite if named differently) — existing selector tests still pass; add a case asserting `pickGradedRow` returns the real row's variant/condition and that `pickGradedFromRows` price is unchanged.

- [ ] 2. **(A) Remove the QA#6b short-window flat branch from the history service.**
      In `src/lib/services/collection-history.service.ts` delete: the `SHORT_WINDOW_DAYS` const + its block comment,
      the `isAllRange` computation, the whole `if (isAllRange && earliestAdded >= nowMs - SHORT_WINDOW_DAYS*DAY_MS) { … }`
      block (including `addedTimes`/`earliestAdded`/`latestAdded`/`flatStart`/`flat` locals used ONLY there). Keep the
      dense daily-grid construction, the addedAt-anchor injection, the dedup, and the final `buildCollectionSeries` call.
      Keep the `DAY_MS` const (still used by the anchor logic). A recent-but-real portfolio now flows through the dense
      grid. Do NOT change the empty-state contract (service still returns null-gapped points; the page's `>=2 real
      points` gate is unchanged).
      Files: `src/lib/services/collection-history.service.ts`
      Verify: `npx vitest run tests/unit/collection-history-service.test.ts` — expect the `QA #6b short-window sparse shaping` block to FAIL (it pins removed behaviour); that is the signal to proceed to step 3. The grep-pin test (`no synthetic/mock chart generator`) must still pass.

- [ ] 3. **(A) Rewrite the short-window tests to assert a real moving dense series.**
      In `tests/unit/collection-history-service.test.ts` replace the `describe("QA #6b short-window sparse shaping (ALL/MAX)")`
      block with a `describe("real moving series for a recent-but-real portfolio (A)")` that, with a hoisted-mock lot added
      ~2 days ago over range `"ALL"` and REAL `PricingHistory` points that MOVE (e.g. 5 → 8 → 11 across the window),
      asserts: (a) the series has many points (`> 3`, not capped at 2), (b) the valued points reflect the movement
      (contains both an early and a late distinct value — proving it is not flat), (c) no fabricated `0`. Keep the
      "multi-month history keeps full dense series" and "bounded 1M still >=2 points" tests (they already assert the
      dense path and must still pass).
      Files: `tests/unit/collection-history-service.test.ts`
      Verify: `npx vitest run tests/unit/collection-history-service.test.ts` — all tests pass. Commit A now (service change + test rewrite together) with a message scoped to requirement A.

- [ ] 4. **(B) Add a sold-lot step-down regression test.**
      In `tests/unit/collection-series.test.ts` add a test under a `describe("sale drops the line (B — active-value only)")`:
      a collection with TWO lots over a daily timeline where lot L1 is held throughout and lot L2 is sold mid-timeline
      (`soldAt` set). With real per-lot prices, assert the series value BEFORE `soldAt` includes L2's contribution and
      AFTER `soldAt` is lower by exactly L2's `price × quantity` (i.e. equals L1 alone), and that soldPrice/realized is
      NEVER added to the line. This pins requirement B against future regressions. (Pure builder test — no Prisma.)
      Files: `tests/unit/collection-series.test.ts`
      Verify: `npx vitest run tests/unit/collection-series.test.ts` — the new test passes against the current builder (B already works via the ownership gate). Commit B now with a message scoped to requirement B.

- [ ] 5. **(C) Add the missing-current-grade historical fallback + bounded-window seed to the service, using `pickGradedRow`.**
      In `src/lib/services/collection-history.service.ts`:
      (a) Replace the inline `currentGradedVariant` memo so that, for a graded lot, it first tries the CURRENT snapshot
      via `pickGradedRow(currentRows, company, grade)`; if that is null, it falls back to the most-recent real graded
      `PricingHistory` row for that company+grade via `pickGradedRow(historyRowsForCard, company, grade)`. Thread the
      CHOSEN row's `variant` into `HoldingInterval.gradedVariant` (current row's variant when current priced it; else the
      historical row's actual variant — never invent `"normal"`). When BOTH are null, keep `gradedVariant = null` so the
      lot stays an honest null gap (RULE 2). Memoize per (cardId, company, grade) as today.
      (b) Bounded-window seed: after the existing windowed `pricingHistory.findMany({ recordedAt: { gte: startDate } })`,
      add a second `findMany` for rows with `recordedAt < startDate` reduced to the LATEST row per
      (cardId, type, company, grade, variant) — or order desc + take a bounded slice and dedup in JS — and prepend those
      as seed `PricePoint`s so per-lot carry-forward has a real anchor at/just-before the window. Keep it Prisma-read-only,
      bounded by `cardId: { in: cardIds }`. Preserve all load-bearing comments and the cross-snapshot-parity comment block.
      Files: `src/lib/services/collection-history.service.ts`
      Verify: `npx vitest run tests/unit/collection-history-service.test.ts` — existing graded parity tests still pass (step 6 adds the new coverage).

- [ ] 6. **(C) Make the collection API payload carry the real historical-fallback identity, and pin all three C cases in tests.**
      In `src/app/api/users/me/collection/route.ts`: when a lot's condition is graded and NO `CurrentPrice` graded row
      matches its company+grade, append ONE `gradedPrices` entry derived from the real most-recent matching graded
      `PricingHistory` row (via `pickGradedRow`), carrying that row's ACTUAL `variant` + `condition` and a provenance
      marker distinguishing it from current rows (e.g. `source: "history"` on the appended entry; current rows keep their
      existing shape / implicit current provenance). This keeps `displayPrice`/`statsFromLots` and the chart valuing the
      SAME real identity. Do NOT fabricate when neither current nor history has a matching row (omit the entry → "—").
      Then add unit tests (hoisted-Prisma-mock service tests in `tests/unit/collection-history-service.test.ts`, and
      pure-builder parity tests in `tests/unit/collection-series.test.ts`) covering:
        - **C-parity, divergent arrays:** feed the chart one `PricePoint[]` array and the display path a DIFFERENT
          `GradedPriceRow[]` array (two distinct arrays, per the Phase-1 review note that reusing one array hides
          divergence) for the same PSA 9 lot where the two snapshots carry different variant sets; assert chart value ===
          display value.
        - **C-missing-current-grade:** current snapshot has no PSA 9 row but history does → the chart values from the real
          historical PSA 9 row preserving its actual variant/condition, and the API appends a `source:"history"`
          `gradedPrices` entry with that same variant/condition.
        - **C-bounded-window:** the last real matching point predates the requested window start → with the seed, the lot
          is drawable (not an all-null gap) and valued at that real carried-forward price; without a matching row anywhere
          it stays a null gap.
      Files: `src/app/api/users/me/collection/route.ts`, `tests/unit/collection-history-service.test.ts`, `tests/unit/collection-series.test.ts`
      Verify: `npx vitest run tests/unit/collection-series.test.ts tests/unit/collection-history-service.test.ts` — all pass.

- [ ] 7. **(C) Document the gradedPrices provenance in the API reference.**
      In `docs/API_REFERENCE.md`, update the `GET /api/users/me/collection` entry so `gradedPrices` documents that
      entries come from current `CurrentPrice` rows, PLUS an optional historical-fallback entry (marked `source:"history"`)
      carrying the real most-recent matching graded `PricingHistory` row's variant/condition when current has no matching
      row — and that a lot with no matching row anywhere contributes no entry (UI renders "—", never fabricated). Keep the
      note that these feed `displayPrice`/`statsFromLots` AND the portfolio-value chart via the one shared selector.
      Files: `docs/API_REFERENCE.md`
      Verify: `npx vitest run tests/unit/collection-history-service.test.ts` (unaffected, sanity) and manually re-read the
      edited doc block for accuracy against step 6's payload shape.

- [ ] 8. **Full static + unit/integration gate for the whole change.**
      Run the project's real checks over everything changed.
      Files: (none)
      Verify: `npm run type-check` (clean), `npm run lint` (clean), `npm run test:unit`, `npm run test:integration` — all
      pass. Fix any failures before proceeding. (chart-accuracy + e2e from `npm run verify` need the remote DB/production
      build and are out of scope to run in this worktree; note that explicitly if asked to run the full `verify`.)

- [ ] 9. **Page-export guard manual check (tsc does not catch it).**
      Confirm no non-default export was added to any page.
      Files: (none)
      Verify: run `grep -rnE "^export (const|function|async function|class|interface|type|enum) " "src/app"` (PowerShell:
      `Select-String -Path (Get-ChildItem -Recurse src/app -Filter page.tsx) -Pattern '^export (const|function|async|class|interface|type|enum) '`)
      and confirm NO `page.tsx` appears (only the required `export default` + route config). If any helper leaked into a
      `page.tsx`, move it to `src/lib` and re-run step 8.

- [ ] 10. **Commit C and leave the tree clean.**
      Stage only the files changed for C (`src/lib/utils/raw-price.ts` if not already committed under its own step,
      `src/lib/services/collection-history.service.ts`, `src/app/api/users/me/collection/route.ts`,
      `docs/API_REFERENCE.md`, the two test files) and commit with a message scoped to requirement C. Confirm
      `git -C "<worktree>" status --short` is clean afterward. Do NOT push.
      Files: (git only)
      Verify: `git -C "d:\Pokemon\Pokemon\.worktrees\portfolio-value-series" log --oneline -3` shows the three
      per-requirement commits (A, B, C); `git status --short` is clean.

## Notes / gaps / assumptions

- **A vs the existing anchor logic:** removing the flat branch leaves the dense-grid + addedAt-anchor code intact; that
  code already guarantees `>=2` valued points for recent lots, so the empty-state only triggers on genuinely <2 real
  valued points. If a recent portfolio still looks near-flat, that is the HONEST truth (prices genuinely did not move in
  stored history) — not to be "fixed" by fabrication (RULE 2).
- **Bounded-window seed scope:** the seed read is deliberately a thin `recordedAt < startDate` latest-per-identity query,
  not a widening of the main windowed query, so range semantics (1M/3M/…) are preserved. If per-identity dedup in SQL is
  awkward under the current Prisma version, dedup in JS after an ordered-desc bounded read — equally correct, still one
  extra bounded read. `ponytail:` if lot/card counts ever grow large, bound the seed read with a per-card `take`.
- **Provenance marker:** `source:"history"` on the appended `gradedPrices` entry is the minimal honest signal; it does not
  change `displayPrice`/`statsFromLots` selection (they match on company+grade+variant+price), it only documents origin.
- Could not run `next build` / chart-accuracy / e2e here (remote DB busy, per the task) — step 9's manual grep is the
  stand-in for the page-export guard; call that out in the completion report.
