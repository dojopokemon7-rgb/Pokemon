# Verification — Five confirmed chart/price-data bugs (fix-chart-data-bugs)

Worktree `d:\Pokemon\Pokemon\.worktrees\fix-chart-data-bugs`, branch
`fix-chart-data-bugs` (based on local `master` @ 459605b). Windows / PowerShell;
the repo path contains a space — every path quoted.

## Iteration note

This was the **FIRST implementation iteration** of the five bugs. The on-disk
`.agents/tasks/review.json` + `verification.md` at the start of the run were
STALE copies from unrelated tasks (the review.json's only finding + `reviewDoc`
point at a `perf-optimize` worktree and an e2e portfolio-chart spec; the
verification.md was the earlier `op-altart` One-Piece variant-image task). Neither
referenced this worktree's bugs, and the branch HEAD (`459605b security: …`)
contained none of the five fixes. Per the step instructions, absence of a
matching review → implement all five from scratch per `plan.md`.

## Pre-existing branch breakage repaired (NOT one of the five bugs)

`npm run type-check` failed on the UNTOUCHED `src/middleware.ts`:
`Cannot find module '@/lib/utils/redirect'`. Commit `459605b` ("open-redirect fix
M-3") added the `isValidCallbackUrl` import to `middleware.ts` but the companion
`src/lib/utils/redirect.ts` was never committed (it existed only as an untracked
file in the parent working tree). This is a pre-existing, unrelated breakage that
blocked the required type-check/lint/test gate. I restored the genuine M-3
companion file (verified it is exactly the open-redirect validator the committed
middleware imports — same-origin, path-relative callbackUrl gate) so the branch
compiles. It is committed SEPARATELY (`fix: restore missing M-3 redirect util`) so
reviewers can see it is not part of the five-bug work. No product behavior for the
five bugs is affected.

## Commands run and results (from the worktree root)

| Command | Result |
|---|---|
| `npm run type-check` (`tsc --noEmit`) | **PASS** — exit 0, 0 errors (after the M-3 util restore above). |
| `npm run lint` (`eslint .`) | **PASS** — exit 0, 0 errors/warnings. |
| `npm run test:unit` | **PASS** — **72 files, 545 tests, 0 failures**. |
| `npm run test:integration` | **PASS** — **60 files, 425 tests, 0 failures**. |

`build:standalone` and `test:e2e` were NOT run (remote DB busy — they stall, per
the step instructions). The known flake `tests/unit/add-invalidates-chart.test.tsx`
did NOT fail — the full unit suite is green, so no isolation re-run was needed.

Redis-down `[cache] … falling through` / `[rate-limit] … falling open` lines in
the integration stderr are EXPECTED (AGENTS.md RULE 1, Redis optional) — not
failures.

## Per-bug summary

### BUG 1 & 8 (HIGH) — portfolio value chart ignored each lot's grade/variant
- **Root cause**: `collection-history.service.ts` selected only
  `{cardId, recordedAt, priceMarket}` and `buildCollectionSeries`'
  `priceAtOrBefore` carried forward whichever `priceMarket` sorted last, so raw /
  PSA 9 / PSA 10 / CGC 10 rows sharing one `cardId` mis-valued a lot.
- **Files changed**:
  - `src/lib/utils/collection-series.ts` — `HoldingInterval` gains `condition?`;
    `PricePoint` gains `type/company/grade/variant/condition?`; each lot now
    builds a carry-forward series FILTERED to its own grade: a GRADED lot
    (`parseGradedCondition` matches company+grade) keeps only that graded series;
    a RAW lot keeps the best raw condition's points (via `pickBestRaw` /
    `pickDefaultVariant` — the SAME selection `statsFromLots`/`displayPrice` use).
    Empty match → honest null gap (RULE 2). Legacy points without `type` still
    resolve as raw → existing fixtures unchanged.
  - `src/lib/services/collection-history.service.ts` — adds `condition` to the
    `userCollection` select + onto each `HoldingInterval`; adds
    `type/company/grade/variant/condition` to the `pricingHistory` select + onto
    each `PricePoint`. QA #6b short-window flat path and the ownership/anchor
    logic are UNTOUCHED (verified: 10 QA #6b markers + ownership gate intact).
- **Tests that pin it**:
  - `tests/unit/collection-series.test.ts` → new describe "BUG 1 & 8": one cardId
    with raw+PSA 9+PSA 10+CGC 10 at the same instant — PSA 9 lot→500, PSA 10→1000,
    CGC 10→900, raw→50; three lots sum to their OWN grades (1550); a BGS 10 lot
    with no row stays null; legacy no-type points still raw.
  - `tests/unit/collection-history-service.test.ts` → new describe "BUG 1 & 8":
    through the Prisma mock (dense ALL path, not the short-window path), a PSA 9
    lot values at 500 across the series (never 1000/900/50); a raw lot values at 50.

### BUG 3 (HIGH) — wrong image on composite Pokémon card-detail pages
- **Root cause**: `src/app/api/card-img/[id]/route.ts` resolved via
  case-SENSITIVE `findUnique({ where:{ externalId: id } })`; an upper-cased
  composite id (`GYM1-1::unlimitedHolofoil`, URL `%3A%3A`) missed → 404 → wrong
  cached image.
- **File changed**: `src/app/api/card-img/[id]/route.ts` — `decodeURIComponent`
  the param; externalId now resolved with
  `findFirst({ where:{ externalId:{ equals: decoded, mode:"insensitive" } } })`,
  keeping the cuid `findUnique` fallback. The `::printing` suffix is NOT stripped
  (the whole composite externalId is its own row with its own image). SSRF
  allowlist + `redirect:"manual"` + image/* guard intact; 404 still carries NO
  `Cache-Control` (negative never cached for a later correct lookup).
  Href-build grep: all app-internal detail links build from the stored
  (lower-case) `externalId` via `encodeURIComponent` (portfolio `detailHref`,
  search `goToCard`/tile hrefs, `DashboardClient.cardDetailHref`); none uppercase
  the id, so the route fix is the robust backstop — no link change needed.
- **Test that pins it**: `tests/integration/card-img-by-id.test.ts` — mock now
  exposes `findFirst` + `findUnique`; added (a) `GYM1-1::unlimitedHolofoil`
  resolves the stored row and asserts `mode:"insensitive"` + decoded id; (b) a
  `%3A%3A` composite id looks up its OWN decoded `OP01-120::alt-art` row (suffix
  intact, NOT the base `OP01-120`); (c) a 404 carries no `Cache-Control`. All
  existing happy/SSRF/non-image/throw cases retargeted to the new resolver.

### BUG 2 (MEDIUM) — list controls reset after opening a card and returning
- **Root cause**: portfolio `cardType`/`selectedColl`/`view` and search `sort`
  were component-only `useState`, lost on the Back remount (search FILTERS were
  already URL-persisted; the search page is grid-only so it has no `view` toggle
  — only `sort` is in-memory).
- **Files changed**:
  - `src/lib/utils/list-controls.ts` (new) — pure `paramOrDefault(value, allowed,
    fallback)` validator (page-export-guard-safe, unit-testable).
  - `src/app/(dashboard)/portfolio/page.tsx` — body renamed to
    `PortfolioPageInner`, new default `PortfolioPage` wraps it in `<Suspense>`
    (Next 15 requires it for `useSearchParams`). `cardType`/`selectedColl` init
    from `?type=`/`?coll=` (validated); `view` restored from `?view=` post-mount
    (responsive default only when absent). Each control's onClick mirrors to the
    URL via a `setParam` helper using `router.replace` (drops key at default).
  - `src/app/(dashboard)/search/page.tsx` — `sort` inits from `?sort=`
    (validated); `applyFilters` now preserves `sort`; a `changeSort` helper
    mirrors it to the URL via `router.replace`; both `setSort` call sites use it.
  - Scroll restoration deferred with a `ponytail:` note (sessionStorage-by-path
    proved fragile vs the skeleton/virtualized remount); control persistence —
    the actual complaint — is met.
- **Test that pins it**: `tests/unit/list-controls.test.ts` — `?type=sold`→`sold`,
  unknown/absent→`active`; `?sort=market_desc`→`market_desc`, unknown→`trending`;
  `?view=grid`→`grid`, absent→`list`.

### BUG 5 (MEDIUM) + BUG 6 (LOW) — card-detail timeline tabs locked to 1M / default 1M
- **Root cause**: `search/[id]/page.tsx` computed `spanDays` from ONLY the
  selected chips, so a sparse selected graded chip → span 0 → only 1M enabled;
  and `range` defaulted to a hard `"1M"`.
- **Files changed**:
  - `src/app/(dashboard)/search/[id]/price-history-chart.ts` (sibling pure module,
    NOT a page export) — new `maxAvailableSpanDays(history)` (max real span across
    raw + every graded key the card HAS) and `largestEnabledRange(avail)`.
  - `src/app/(dashboard)/search/[id]/page.tsx` — `spanDays` now from
    `maxAvailableSpanDays(historyData)` (selection-independent); a `rangeTouched`
    flag + a history-keyed effect open the chart on `largestEnabledRange` until the
    user picks a tab (then their pick sticks). Disabled tabs keep the existing
    "Not enough history yet" title. No fabrication — availability still derives
    from real stored spans.
- **Test that pins it**: `tests/unit/card-detail-chips-matrix.test.ts` → new
  describe "BUG 5 & 6": a 100-day raw series + a sparse graded series →
  `maxAvailableSpanDays` 100 and 1M+3M+6M enabled regardless of selection; default
  opens on 6M; a <31-day card enables only 1M (default 1M); the longest span may
  come from a graded series the raw lacks (200→default 1Y).

## Page-export guard (manual — tsc does NOT catch this)

Checked every `page.tsx` I touched for new non-default exports:
- `src/app/(dashboard)/portfolio/page.tsx` — exports: `interface CollectionItem`
  (PRE-EXISTING, a type, not a runtime value — unchanged) + `default PortfolioPage`.
  My change renamed the old default to a NON-exported `PortfolioPageInner` and
  added the default wrapper. No new named export. ✓
- `src/app/(dashboard)/search/page.tsx` — only `default SearchPage`. ✓
- `src/app/(dashboard)/search/[id]/page.tsx` — only `default CardDetailPage`. New
  helpers (`maxAvailableSpanDays`, `largestEnabledRange`) live in the sibling
  `price-history-chart.ts`. ✓

## Out-of-scope confirmation (left exactly as-is)

- **Symptom 4** (short-window flat-line / QA #6b path): `collection-history.service.ts`
  only gained the extra SELECT columns + the `condition` thread; `SHORT_WINDOW_DAYS`,
  `isAllRange`, and the flat-anchor logic are byte-intact (10 QA #6b markers present).
- **Symptom 7** (active-value-only series / sale doesn't move chart):
  `collection-series.ts` ownership gate `[addedAt, soldAt)` untouched (2 markers
  present) — only per-lot grade filtering was added.
- **Scrydex enrich flag / credit gate / data coverage**: no such files touched
  (`git status` shows only the chart/image/controls files + the M-3 util + tests).

## Changed files (git status)

```
 M src/app/(dashboard)/portfolio/page.tsx
 M src/app/(dashboard)/search/[id]/page.tsx
 M src/app/(dashboard)/search/[id]/price-history-chart.ts
 M src/app/(dashboard)/search/page.tsx
 M src/app/api/card-img/[id]/route.ts
 M src/lib/services/collection-history.service.ts
 M src/lib/utils/collection-series.ts
 M tests/integration/card-img-by-id.test.ts
 M tests/unit/card-detail-chips-matrix.test.ts
 M tests/unit/collection-history-service.test.ts
 M tests/unit/collection-series.test.ts
?? src/lib/utils/list-controls.ts
?? src/lib/utils/redirect.ts   (pre-existing M-3 companion, restored)
?? tests/unit/list-controls.test.ts
```
(`.agents/tasks/plan.md` shows as modified — pre-existing working-tree state, not
committed by this work.)
