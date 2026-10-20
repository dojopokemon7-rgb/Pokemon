# Verification — Five confirmed chart/price-data bugs (fix-chart-data-bugs)

Worktree `d:\Pokemon\Pokemon\.worktrees\fix-chart-data-bugs`, branch
`fix-chart-data-bugs` (based on local `master` @ 459605b). Windows / PowerShell;
the repo path contains a space — every path quoted.

## Iteration 5 — four blocking review findings resolved

`review.json` (verdict `CHANGES_REQUESTED`, reviewDoc review-a.md [APPROVED] +
review-b.md [NEEDS_CHANGES]) carried FOUR blocking findings + one non-blocking.
Each resolved below.

### Finding 1 [confirmed, blocking] — split price sources (chart↔display variant divergence)
- **Reasoning (from review-b)**: the chart is fed WINDOWED `PricingHistory` while
  display/accounting is fed the LATEST `CurrentPrice`. The shared selector picked
  the graded variant via `pickDefaultVariant(rows)`, which reads the RAW rows to
  decide the default. `PricingHistory` accumulates historical raw rows while the
  Scrydex writer REPLACES the CurrentPrice set, so the two snapshots carry
  DIFFERENT raw rows → the same PSA 9 lot could resolve to `holofoil` on the chart
  and `normal` on the tiles. The old parity tests reused ONE fixture across both
  helpers, so they could not expose this topology.
- **Fix**: made the graded-variant selection INDEPENDENT of the surrounding raw
  rows. `src/lib/utils/raw-price.ts` `pickGradedVariant` now chooses the variant
  from the GRADED MATCHES THEMSELVES by the module's `VARIANT_PRIORITY`
  (`cmpVariant`), never via `pickDefaultVariant(rows)`. So any company+grade
  resolves to the same variant regardless of which raw rows accompany it, and the
  chart and tiles/summary agree even across divergent snapshots. `pickGradedFromRows`'
  tie-break fallback now also uses `cmpVariant` (was a bare `localeCompare`) for
  consistency. Comments in `collection-series.ts`, `graded-price.ts`, and the
  collection route updated to state the new rule (the full-set select is kept —
  it is harmless and the raw rows simply no longer drive the graded default).
  RULE 2 preserved: an empty company+grade match still returns null → honest gap.
- **Regression added** (`tests/unit/collection-series.test.ts`, rewrote the
  multi-variant parity describe): the key new case feeds the chart `historyRows`
  with a raw HOLOFOIL (no raw normal) and feeds display `currentRows` with a raw
  NORMAL — the exact divergent topology the review named — and asserts BOTH price
  the PSA 9 at 500 (`normal`, the graded default) and that `chart === display`.
  Plus order-independence and a `statsFromLots === chart` case. The old
  "a graded lot follows the card default variant set by a RAW row (→777)" case
  (which encoded the raw-driven behavior that caused the divergence) was replaced
  by "the graded variant ignores the raw rows (picks graded default 500)".

### Finding 2 [likely, blocking] — a previously cached WRONG 200 survives the fix
- **Reasoning**: the composite/case-insensitive resolver only helps requests that
  reach the server; a wrong `200` already cached under the unchanged proxy URL
  stays fresh 86,400s / stale-eligible 604,800s. The new no-cache assertion covers
  only `404`.
- **Fix**: `src/lib/utils/card-image.ts` — `cardImgById` now appends a
  cache-busting `?v=<CARD_IMG_CACHE_VERSION>` (exported, set to `"2"`). The version
  changes the request URL / edge-cache key so every client fetch after rollout
  misses any poisoned entry and re-resolves against the corrected DB lookup. The
  server ignores `v`. The route file-header documents the mechanism.
- **Regression**: `tests/unit/card-image.test.ts` asserts `cardImgById(...)`
  carries `v=CARD_IMG_CACHE_VERSION` (with and without `hi=1`) and still never
  leaks the CDN host; the exact-URL assertions were relaxed to `startsWith`/`toContain`.

### Finding 3 [likely, blocking] — case-folded image lookup is ambiguous
- **Reasoning**: `Card.externalId` is case-SENSITIVE `@unique`, so case-only
  duplicate rows are possible; an insensitive `findFirst` with no exact-first path
  could return either row.
- **Fix**: `src/app/api/card-img/[id]/route.ts` now tries an EXACT
  `findUnique({ where: { externalId: decoded } })` FIRST, then the case-insensitive
  `findFirst`, then the cuid `findUnique`. A correctly-cased request always hits
  its own row and never consults the ambiguous insensitive match; the insensitive
  fallback only rescues a genuinely mis-cased id.
- **Regression** (`tests/integration/card-img-by-id.test.ts`): the Prisma mock now
  routes `findUnique` by `where` key (externalId-exact vs cuid). Added a
  collision-safe case: when the exact row exists, the insensitive fallback (stubbed
  to a WRONG sibling) is NEVER consulted and the exact row's image streams. The
  mis-cased case now asserts exact-miss → insensitive-hit ordering; the composite
  `::` case asserts the exact lookup key keeps the suffix.

### Finding 4 [confirmed, blocking] — stale behavior docs
- **Fix**: updated `docs/CODE_MAP.md` — search `sort` is now URL-backed (BUG 2),
  range tabs derive from `maxAvailableSpanDays` + `largestEnabledRange` (BUG 5/6),
  portfolio `type`/`coll`/`view` are URL-backed (BUG 2), `collection-series.ts`
  values each lot by its grade via the raw-independent shared selector (BUG 1/8),
  the `card-img-by-id` test line notes exact-then-insensitive + composite, and
  `card-detail-chips-matrix`/`list-controls` added to the unit-test index. Updated
  `docs/API_REFERENCE.md` — `GET /api/users/me/collection` now documents
  `card.gradedPrices` (full priced raw+graded set with `type`/`variant`/`condition`)
  and the shared variant selector.

### Finding 5 [confirmed, non-blocking] — no production-browser Back-flow evidence
- Unchanged and acknowledged: `build:standalone` + Playwright e2e + chart-accuracy
  are NOT runnable here (remote DB busy — they stall, per the step instructions).
  Left for a DB-available production gate.

### Iteration-5 commands run (from the worktree root, paths quoted)

| Command | Result |
|---|---|
| `npm run type-check` (`tsc --noEmit`) | **PASS** — exit 0. |
| `npm run lint` (`eslint .`) | **PASS** — exit 0. |
| `npm run test:unit` | **PASS** — **72 files, 551 tests, 0 failures**. |
| `npm run test:integration` | **PASS** — **60 files, 426 tests, 0 failures**. |
| `npx vitest run tests/unit/collection-series.test.ts tests/unit/card-image.test.ts tests/integration/card-img-by-id.test.ts tests/integration/card-img-proxy.test.ts` | **PASS** — 64 tests (19 + 19 + 16 + 10), 0 failures. |

Known flake `tests/unit/add-invalidates-chart.test.tsx` did NOT fail (full unit
suite green). `build:standalone`/e2e/chart-accuracy NOT run (remote DB busy).

**Page-export guard (iteration 5):** no `page.tsx` was touched this iteration.
Changed source files: `src/lib/utils/raw-price.ts`, `src/lib/utils/card-image.ts`,
`src/lib/utils/collection-series.ts`, `src/lib/utils/graded-price.ts` (all `src/lib`
utils), `src/app/api/card-img/[id]/route.ts` + `src/app/api/users/me/collection/route.ts`
(API routes), and `docs/*`. `git grep "^export "` on the three previously-touched
pages still shows ONLY `export default` + the pre-existing erased
`interface CollectionItem` in portfolio (confirmed identical to `master`). New
runtime helpers (`CARD_IMG_CACHE_VERSION`) live in `src/lib`. **Symptoms 4/7 and
the Scrydex config remain untouched** — no `collection-history.service.ts` change
this iteration (QA #6b flat path + `[addedAt, soldAt)` ownership gate intact), no
active-value-series change, no Scrydex/enrich/credit-gate file in the diff.

---

## Iteration 4 — review blocking finding resolved (chart↔display graded-variant parity, BOTH sides)

`review.json` (verdict `CHANGES_REQUESTED`) carried ONE **blocking** finding
(Review B; Review A was APPROVED):

> **Graded variant parity (blocking)** — the chart (`collection-series.ts:139`)
> derived a deterministic variant from the full historical rows, but the
> collection API selected only `{ company, grade, priceMarket }` for
> `gradedPrices` (no variant, no ordering), and `statsFromLots`/`displayPrice`
> routed through `pickRealGradedPrice`, whose `.find(...)` took the FIRST matching
> company/grade. With e.g. PSA 9 normal + holofoil rows, the chart could pick
> holofoil while the tile/summary picked whichever row Prisma returned first — the
> per-lot chart↔display parity requirement was NOT met. Fix: route BOTH the chart
> and the display/accounting paths through ONE shared company/grade/variant
> selector, and add a cross-helper multi-variant regression that drives
> `buildCollectionSeries` AND `displayPrice`/`statsFromLots` together (keep the
> single-variant PSA 9 service regression). The existing "chart↔display parity"
> test called only `buildCollectionSeries`.

**Root cause**: iteration-3 aligned only the CHART's variant derivation. The
DISPLAY side still (a) never received the variant column (collection API selected
graded-only `{company,grade,priceMarket}`), and (b) `pickRealGradedPrice` took the
first company+grade `.find()`. So for a multi-variant company+grade the two sides
could price different variants.

**Fix applied (ONE shared selector, both sides fed the SAME full row set):**
- `src/lib/utils/raw-price.ts` — extracted `pickGradedVariant(rows, company, grade)`:
  the single rule that returns the graded variant to price at — the card DEFAULT
  variant (`pickDefaultVariant` over the FULL raw+graded rows, so a raw holofoil
  can make `holofoil` the graded default) when it has a matching graded row, else
  the alphabetically-first graded variant, else null. `pickGradedFromRows` now
  delegates to it.
- `src/lib/utils/collection-series.ts` — the chart's graded branch now calls that
  SAME `pickGradedVariant` (over `all`, uppercased company) instead of its inline
  duplicate — identical rule, one source of truth.
- `src/lib/utils/graded-price.ts` — `GradedPriceRow` now `extends PriceRowLike`
  (optional `type`/`variant`/`condition`/`priceLow`); `pickRealGradedPrice` routes
  through `pickGradedFromRows` (normalizing company to upper-case and defaulting a
  missing `type` to `"graded"` so a legacy graded-only array still matches). So
  `displayPrice`/`statsFromLots` pick the SAME variant the chart does.
- `src/app/api/users/me/collection/route.ts` — the `currentPrices` select now
  ships the card's FULL priced set (dropped `type:"graded"` filter; kept
  `priceMarket not-null`) WITH `type`/`variant`/`condition`, so the display path
  can see raw-driven defaults exactly as the chart does.

RULE 2 preserved — an empty company+grade match still yields null (honest gap /
fallback); no fabricated points. No `page.tsx` touched this iteration.

**Regressions added** (`tests/unit/collection-series.test.ts`, new describe
"chart↔display parity through ONE shared variant selector (multi-variant)"):
drives `buildCollectionSeries` AND `displayPrice`/`statsFromLots` from the SAME
full row set — raw holofoil + PSA 9 normal(500) + PSA 9 holofoil(777):
- chart == displayPrice == **777** (the holofoil variant the raw row made default),
  order-independent (forward + reversed rows);
- `statsFromLots` marketValue == chart == 777;
- with NO raw signal, both pick `normal` (500) deterministically.
The iteration-2/3 single-variant + raw-default regressions are kept.

### Iteration-4 commands run (from the worktree root, paths quoted)

| Command | Result |
|---|---|
| `npm run type-check` (`tsc --noEmit`) | **PASS** — exit 0. |
| `npm run lint` (`eslint .`) | **PASS** — exit 0. |
| `npm run test:unit` | **PASS** — **72 files, 550 tests, 0 failures** (547 + 3 new parity regressions). |
| `npm run test:integration` | **PASS** — **60 files, 425 tests, 0 failures** (1 updated: the collection-select-shape assertion now expects the full-set select). |
| `npx vitest run tests/unit/collection-series.test.ts` | **PASS** — 19 tests. |
| `npx vitest run tests/integration/collection-add-dashboard.test.ts` | **PASS** — 6 tests. |

Known flake `tests/unit/add-invalidates-chart.test.tsx` did NOT fail — the full
unit suite is green, so no isolation re-run was needed. `build:standalone` +
Playwright e2e + chart-accuracy NOT run (remote DB busy — they stall, per the step
instructions); the non-blocking browser Back-flow coverage gap is unchanged and
left for a DB-available production gate.

**Page-export guard (iteration 4):** no `page.tsx` was touched — changed source
files are `src/lib/utils/raw-price.ts`, `src/lib/utils/collection-series.ts`,
`src/lib/utils/graded-price.ts` (all `src/lib` utils) and
`src/app/api/users/me/collection/route.ts` (an API route, not a page). The three
previously-touched pages are unchanged this iteration and still export only
`default` (+ the pre-existing erased `interface CollectionItem` in portfolio,
confirmed identical to `master`). **Symptoms 4/7 and the Scrydex config remain
untouched** — the iteration-4 diff contains no `collection-history.service.ts`
change (QA #6b flat path intact), no active-value series change, and no
Scrydex/enrich/credit-gate file.

---

## Iteration 3 — review blocking finding resolved (graded default-variant parity)

`review.json` (verdict `CHANGES_REQUESTED`) carried ONE blocking finding (Review B;
Review A was APPROVED with no blocking findings):

> **Graded default-variant parity (blocking)** — `collection-series.ts` derived
> the graded variant from `gradeRows` ONLY, while `statsFromLots`/`displayPrice`
> (via `pickGradedFromRows` in `raw-price.ts`) derive the card default from the
> card's FULL row set. They disagree whenever a RAW row establishes a non-normal
> card default (e.g. holofoil) AND the graded grade has both normal and holofoil
> rows: display/accounting prices the PSA 9 holofoil while the chart picks normal
> by variant priority. Align the chart's variant derivation + fallback with the
> full-row `pickGradedFromRows` rule, then pin the divergent row shape.

**Root cause**: `pickGradedFromRows` computes `wantVariant = variant ?? pickDefaultVariant(rows)`
over the card's FULL rows, so a raw holofoil row makes `holofoil` the card default
and the PSA 9 holofoil row is priced. The chart's graded branch instead ran
`pickDefaultVariant(gradeRows)` over graded-only rows — those carry no raw
condition, so `pickBestRaw` returned null and `pickDefaultVariant` fell to
`listVariants(gradeRows)[0]` = `normal` by variant priority, ignoring the raw
signal. Deterministic, but divergent from display for that row shape.

**Fix applied** (`src/lib/utils/collection-series.ts`, graded branch): derive
`wantVariant` from the card's FULL row set (`all`), exactly as `pickGradedFromRows`
does, then take that variant's graded point(s). Fallback mirrors
`pickGradedFromRows` too — when `wantVariant` has no graded point for this
company+grade, fall to the alphabetically-first graded variant
(`[...gradeRows].map(variant).sort(localeCompare)[0]`), and if that somehow
matches nothing keep `gradeRows` non-empty. No fabrication: an empty company+grade
match still yields an honest null gap (RULE 2). The raw branch and every other
path are unchanged; the existing order-independence regression still passes
(no raw row → default stays `normal`).

**Regression added** (`tests/unit/collection-series.test.ts`, new case "a graded
lot follows the card default variant set by a RAW row (chart↔display parity)"):
one cardId with a RAW `holofoil` row (no raw normal → holofoil is the card
default) plus PSA 9 `normal`=500 and PSA 9 `holofoil`=777. The PSA 9 lot must
value at **777** (the holofoil variant the raw row made the card default) — the
SAME price `pickGradedFromRows`/`displayPrice` returns — NOT 500 that a
graded-only derivation would pick. This is the first test with a raw row that
sets a non-normal card default, so it detects the divergence the prior
order-independence case (graded-only, no raw) could not.

Non-blocking finding (Review A+B agree): the control click → URL → card detail →
Back flow has no browser-level verification because `build:standalone` + Playwright
E2E stall on the busy remote DB in this environment. The URL round-trip logic is
directly traceable in the diff and the pure parser is unit-tested; the browser
Back-flow check is left for a DB-available production-verification run, as the
reviewers noted. This is acknowledged, not resolvable in this environment.

### Iteration-3 commands run (from the worktree root, paths quoted)

| Command | Result |
|---|---|
| `npx vitest run tests/unit/collection-series.test.ts` | **PASS** — 16 tests, 0 failures (new parity case green). |
| `npm run type-check` (`tsc --noEmit`) | **PASS** — exit 0. |
| `npm run lint` (`eslint .`) | **PASS** — exit 0. |
| `npm run test:unit` | **PASS** — **72 files, 547 tests, 0 failures** (546 + 1 new parity regression). |
| `npm run test:integration` | **PASS** — **60 files, 425 tests, 0 failures**. |

Known flake `tests/unit/add-invalidates-chart.test.tsx` did NOT fail — the full
unit suite is green, so no isolation re-run was needed.

Page-export guard re-checked: no `page.tsx` was touched this iteration (the only
changed source file is `src/lib/utils/collection-series.ts`, a `src/lib` util).
`git grep "^export "` on the three previously-touched pages still shows ONLY
`export default` + the pre-existing erased `interface CollectionItem` type in
portfolio (confirmed unchanged from `master`). Symptoms 4/7 and the Scrydex config
remain untouched — the iteration-3 diff is `collection-series.ts` + its test only.

---

## Iteration 2 — review blocking finding resolved

`review.json` (verdict `CHANGES_REQUESTED`) carried ONE blocking finding:

> **Same-grade variant ambiguity in the graded chart branch**
> (`collection-series.ts`). After filtering carry-forward history to the lot's
> company+grade, the graded branch kept ALL matching variants and let the last
> equal-timestamp row win, so the chosen price depended on Prisma/DB tie order.
> The raw branch already picked a deterministic condition+variant; the graded
> branch had no equivalent. Fix: select ONE deterministic graded variant (the
> same default-variant rule display/stats use) before carry-forward, and add a
> regression pinning two same-grade variants returned in opposite orders.

**Fix applied** (`src/lib/utils/collection-series.ts`, graded branch): after
filtering to the lot's company+grade, derive a single deterministic variant via
`pickDefaultVariant` (the SAME rule `pickGradedFromRows` — i.e. the `/graded`
route + `statsFromLots`/`displayPrice` accounting — uses) and keep only that
variant's points before carry-forward. For graded-only rows `pickDefaultVariant`
falls through `pickBestRaw` (no raw rows) to `listVariants(rows)[0]`, which is
variant-priority ordered (`normal` before `holofoil`, …) — order-independent. A
defensive guard keeps the series non-empty if the derived variant somehow matches
nothing. No fabrication: an empty company+grade match still yields an honest null
gap (RULE 2 preserved). The raw branch and every other path are unchanged.

**Regression added** (`tests/unit/collection-series.test.ts`, new case "a PSA 9
lot picks the default variant deterministically regardless of row order"): one
cardId, one PSA 9 company+grade, TWO priced variants at the SAME `recordedAt`
(`normal`=500, `holofoil`=777). Fed in BOTH orders (`[normal,holo]` and
`[holo,normal]`); both assert the lot values at **500** (the `normal` default
variant), proving the result no longer depends on array/DB tie order. The prior
regressions used only `variant:"normal"`, so this is the first test that detects
the ambiguity.

Non-blocking finding (standalone build + E2E Back flow not run because the remote
DB was busy) is acknowledged and unchanged from iteration 1 — those layers stall
in this environment per the step instructions and are left for a DB-available run.

### Iteration-2 commands run (from the worktree root)

| Command | Result |
|---|---|
| `npx vitest run tests/unit/collection-series.test.ts` | **PASS** — 15 tests, 0 failures (new deterministic-variant case green). |
| `npm run type-check` (`tsc --noEmit`) | **PASS** — exit 0. |
| `npm run lint` (`eslint .`) | **PASS** — exit 0. |
| `npm run test:unit` | **PASS** — **72 files, 546 tests, 0 failures** (545 + 1 new regression). |
| `npm run test:integration` | **PASS** — **60 files, 425 tests, 0 failures**. |

Page-export guard re-checked after the edit: no `page.tsx` was touched this
iteration; the only changed source file is `src/lib/utils/collection-series.ts`
(a `src/lib` util, not a page). The three previously-touched pages still export
only `default` (+ the pre-existing erased `interface CollectionItem` type in
portfolio). Symptoms 4/7 and the Scrydex config remain untouched (no such files
in the iteration-2 diff).

---


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
