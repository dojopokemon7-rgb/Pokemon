# QA D5 — verification note

**Finding:** On Explore/search, the 'Graded' filter's "Graded only" option returned
0 results against the real catalog. Root cause: grading was derived from
`Card.rarity startsWith <grader>` (PSA/BGS/CGC/SGC/Beckett), which matched the old
seed-test "PSA 10" rarities but NOTHING in the real Scrydex catalog (real rarities
are "Rare Holo", "Common", "Illustration Rare", …).

**Owner decision — Option C (redefine + relabel, truthfully):** the filter now means
"show cards that HAVE GRADED PRICING DATA available" — the card has at least one
`CurrentPrice` row with `type:"graded"` and a non-null `priceMarket`. The UI option
text is relabeled to be truthful. URL param + API contract (`?graded=graded|ungraded`,
values `'' / 'graded' / 'ungraded'`) are unchanged.

## Files changed
- `src/app/api/cards/search/route.ts`
  - Removed the dead `GRADERS` constant + the `gradedMatch` rarity-startsWith OR
    (grepped — no other consumer in src/).
  - New graded-pricing relation query (mirrors the enrich route + the hasPrice
    filter shape):
    ```ts
    const GRADED_PRICING = {
      currentPrices: { some: { type: "graded", priceMarket: { not: null } } },
    };
    // baseWhere:
    ...(graded === "graded"   ? GRADED_PRICING          : {}),
    ...(graded === "ungraded" ? { NOT: GRADED_PRICING } : {}),
    ```
  - `graded` sits at the TOP LEVEL of baseWhere (single `currentPrices` key, or a
    single top-level `NOT`). No collision: the only other top-level `NOT` user
    (language `en`) nests under `AND`; the hasPrice `currentPrices` clause also
    nests under `AND`. Composition discipline preserved.
  - Updated the route doc comment, the Zod `graded` comment, and the load-bearing
    composition comments to the new graded-pricing meaning. All other comments kept.
- `src/app/(dashboard)/search/page.tsx`
  - Relabeled the `graded-filter` select: label `Graded` → `Graded pricing`;
    options `Both` → `All cards`, `Graded only` → `Has graded pricing`,
    `Ungraded only` → `No graded pricing`. `aria-label` updated to
    "Filter by graded pricing availability". `data-testid="graded-filter"`,
    underlying values, and `applyFilters` wiring unchanged.

## Tests updated to the new meaning
- `tests/integration/search-route.test.ts`
  - NEW `describe("graded-pricing filter (QA D5)")`: asserts `graded=graded` emits
    the top-level `currentPrices.some{type:"graded",priceMarket:{not:null}}` relation
    query (and NO rarity `startsWith:"PSA"`); `graded=ungraded` emits `NOT:` of that
    relation; a graded-priced card maps through.
  - Updated the language block's "graded=ungraded & language=en keep BOTH filters"
    and the image-presence block's "keeps ALL THREE filters" tests: they asserted the
    OLD `w.NOT.OR` (rarity-OR) shape; now assert `w.NOT === { currentPrices: {...} }`.
    Deliberate behavior change per Option C.

## Commands run (worktree root) — all pass
- `npm run type-check` → exit 0 (tsc --noEmit, no errors)
- `npm run lint`       → exit 0 (eslint, no errors)
- `npm run test:unit`  → **514 passed (70 files)**, exit 0
- `npm run test:integration` → **420 passed (60 files)**, exit 0

Known pre-existing flake `tests/unit/add-invalidates-chart.test.tsx` PASSED within the
full unit run this time — no isolated re-run needed, not a regression.

Not run (per instructions — remote DB saturated): `build:standalone`, `test:e2e`.
Nothing pushed, merged, or deployed.
