# Implementation Plan — three chart/UI bugs (users #4, #5, #6)

Worktree (ALL work here): `d:\Pokemon\Pokemon\.worktrees\fix-chart-ui`.
Do NOT touch the main worktree, `prisma/schema.prisma`, or `src/lib/auth.ts`.

Load-bearing rules honored throughout: RULE 2 (never fabricate — `null` → "—", no
synthetic series), RULE 3 (two card ids + per-printing composite `${baseId}::${variant}`,
each printing row carries its own `imageUrl`), RULE 10 (design tokens only), RULE 14
(preserve load-bearing comments), and the PAGE-EXPORT GUARD (a `page.tsx` may export ONLY
a default — extracted pure helpers go to `src/lib`, never a named export in `page.tsx`;
a named export passes `tsc` but FAILS `next build`'s Page-type phase).

Each bug is its OWN commit tagged with its user-bug id (#4 / #5 / #6) plus verification
counts in the trailer. Known flake: `add-invalidates-chart.test.tsx` passes when run alone.
Pre-existing `src/lib/auth.ts` (H-2) type errors are NOT ours.

Investigation findings (grounding):
- Bug #4 (range tabs): `src/app/(dashboard)/search/[id]/page.tsx` maps `RANGE_TABS`
  (`[["1M","1M"],…,["MAX","ALL"]]`) and renders every tab, DISABLING (opacity 0.4,
  `disabled`) the ones where `rangeAvailability(spanDays)[key]` is false. The pure
  availability/default helpers already exist in `price-history-chart.ts`
  (`rangeAvailability`, `maxAvailableSpanDays`, `largestEnabledRange`, `seriesSpanDays`,
  `RangeKey`). `effRange` already falls back to `largestEnabledRange` when the picked
  range is disabled. The honest span label (`history-span` testid) is separate and stays.
- Bug #5 (dashboard chart vs collection switch): the selector dropdown IS wired correctly
  end-to-end (`toggleId` → `setSelectedIds` → `activeSelectedIds` → `collectionIdsQuery`
  via `toHistoryToken` → query key `["portfolio-history", collectionIdsQuery, activeRange]`
  → fetch `?collectionIds=…` → `buildCollectionHistories` which DOES scope
  `where.collectionId = collId` per bucket). The genuine code bug is the FOCUS PILLS:
  when >1 collection is selected, clicking a focus pill calls `setFocusedId(id)`, which
  re-scopes `headlineChange` (`chartSeriesList.filter(s => s.id === focusedId)`) and the
  stat card, but `MultiLineComparisonChart seriesList={chartSeriesList}` is NEVER scoped
  by `focusedId` — so focusing a single collection changes the numbers but not the drawn
  lines. That is the "chart does not change when I switch collection" report. Fix =
  scope the chart's series by focus with the SAME rule `headlineChange` already uses.
- Bug #6 (hero image vs variant): `heroSrc` in `page.tsx` resolves from the ROUTE `id`
  only (`game === "onepiece" ? onePieceImageUrl(id) ?? PLACEHOLDER : cardImgById(id)`),
  so switching variant updates prices/chips but not the hero. Per-printing rows each
  carry their own `imageUrl`, resolvable by composite externalId `${baseId}::${variant}`
  through `/api/card-img/[id]` (the route resolves ITS OWN printing row, suffix intact —
  verified in `tests/integration/card-img-by-id.test.ts`). `cardImgById(id)` already
  builds that id-proxy URL and works for ANY game's row (the route is game-agnostic;
  it looks up `Card.imageUrl` by externalId). The `onError` → PLACEHOLDER fallback and
  the `useEffect(... [heroSrc])` reset already exist and must keep firing on the new src.

Build/test commands (from `package.json`): `npm run type-check` (tsc --noEmit),
`npm run lint` (eslint), `npm run test:unit` (vitest run tests/unit src),
`npm run build` (prisma generate && next build — the Page-type guard runs here).
Vitest alias `@/…` → `src/…` (vite-tsconfig-paths). Run a single file with
`npx vitest run <path>`.

---

- [ ] 1. (Bug #4) Add a pure `visibleRanges` helper and render ONLY enabled range tabs.
      In `src/app/(dashboard)/search/[id]/price-history-chart.ts` add
      `export function visibleRanges(spanDays: number): RangeKey[]` returning
      `RANGE_ORDER.filter(k => rangeAvailability(spanDays)[k])` (so a ~6-month/100-day
      card yields `["1M","3M","6M"]` — no `1Y`/`ALL`). Keep it pure, keep the existing
      doc-comments. In `page.tsx`, replace the `RANGE_TABS.map(...)` block that renders
      every tab + `disabled`/`opacity` with a render over the ENABLED ranges only:
      derive the visible set from `visibleRanges(spanDays)` and map each enabled
      `RangeKey` to its display label (1M/3M/6M/1Y and `ALL`→"MAX") — drop the
      `enabled`/`disabled`/`aria-disabled`/`title`/`opacity` branching entirely since
      only enabled tabs render now. `effRange` + the `largestEnabledRange` default-range
      effect + the honest `history-span` label stay unchanged, so the largest ENABLED
      range still shows the full available span. Keep the `RANGE_TABS`/`RANGE_DAYS`
      consts (RANGE_DAYS is still used by `buildChartMatrix` via `RANGE_DAYS[effRange]`;
      the MAX→ALL label mapping can reuse `RANGE_TABS` or an inline label map — do NOT
      add a named export to `page.tsx`).
      Files: `src/app/(dashboard)/search/[id]/price-history-chart.ts`,
      `src/app/(dashboard)/search/[id]/page.tsx`
      Verify: `npx vitest run tests/unit/card-detail-chips-matrix.test.ts` passes
      (incl. the new `visibleRanges` cases from item 2); `npm run type-check` clean
      (modulo the known `src/lib/auth.ts` H-2 errors).

- [ ] 2. (Bug #4) Unit-test `visibleRanges`.
      In `tests/unit/card-detail-chips-matrix.test.ts` add a `describe("visibleRanges …")`
      block asserting: span 0/10 → `["1M"]`; span 40 → `["1M","3M"]`; span 100 →
      `["1M","3M","6M"]` (the ~6-month case — NO `1Y`/`ALL`); span 200 →
      `["1M","3M","6M","1Y"]`; span 400 → all five; and that `visibleRanges(d).pop()`
      equals `largestEnabledRange(rangeAvailability(d))` for those spans (the largest
      visible tab is the default/largest-enabled range). Import `visibleRanges` from
      `@/app/(dashboard)/search/[id]/price-history-chart`.
      Files: `tests/unit/card-detail-chips-matrix.test.ts`
      Verify: `npx vitest run tests/unit/card-detail-chips-matrix.test.ts` — all pass.
      Commit items 1–2 as ONE commit: `fix(card-detail): user#4 hide 1Y/MAX range tabs
      beyond stored span` with a verification-count trailer.

- [ ] 3. (Bug #5) Add a pure focus-scoping helper for the dashboard chart.
      In `src/lib/utils/dashboard-chart.ts` add
      `export function scopeSeriesToFocus(seriesList: readonly DashboardSeries[],
      focusedId: string | null, isActive: (id: string) => boolean): DashboardSeries[]`
      returning `focusedId && isActive(focusedId) ? seriesList.filter(s => s.id ===
      focusedId) : [...seriesList]`. This is the EXACT rule `headlineChange` already
      inlines (`focusedId && activeSelectedIds.has(focusedId) ? filter : all`), extracted
      so the chart and the headline provably use one rule. Keep RULE 2 honesty (it only
      filters existing real series — fabricates nothing).
      Files: `src/lib/utils/dashboard-chart.ts`
      Verify: `npx vitest run tests/unit/dashboard-chart.test.ts` still passes.

- [ ] 4. (Bug #5) Scope the dashboard chart (and headline) to the focused collection.
      In `src/app/(dashboard)/dashboard/_components/DashboardClient.tsx` import
      `scopeSeriesToFocus` and derive
      `const scopedChartSeries = useMemo(() => scopeSeriesToFocus(chartSeriesList,
      focusedId, (id) => activeSelectedIds.has(id)), [chartSeriesList, focusedId,
      activeSelectedIds])`. Pass `scopedChartSeries` to `<MultiLineComparisonChart
      seriesList={…}>` (replacing `chartSeriesList`), and refactor `headlineChange` and
      `hasChartableHistory_` to consume `scopedChartSeries` (so chart, headline, and the
      range-tab gate can never disagree — the comment already promises they share one
      rule). Leave the selector-dropdown path untouched (it already works via the query
      key). Preserve the load-bearing comments on `headlineChange`/`hasChartableHistory_`.
      Files: `src/app/(dashboard)/dashboard/_components/DashboardClient.tsx`
      Verify: `npm run type-check` clean (modulo H-2); `npx vitest run tests/unit` for
      the dashboard-touching suites stays green.

- [ ] 5. (Bug #5) Unit-test the focus-scoping behavior.
      In `tests/unit/dashboard-chart.test.ts` add a `describe("scopeSeriesToFocus …")`
      block: with a 3-series list, `focusedId=null` → all 3 returned; `focusedId="B"`
      with `isActive("B")=true` → only series B; `focusedId="B"` with `isActive=()=>false`
      → all 3 (an inactive focus is ignored, matching `activeSelectedIds.has`); and that
      feeding the scoped result to `buildDashboardMatrix`/`dashboardOverallChange` yields
      the focused series' own curve, not the combined one. No fabricated data.
      Files: `tests/unit/dashboard-chart.test.ts`
      Verify: `npx vitest run tests/unit/dashboard-chart.test.ts` — all pass.
      Commit items 3–5 as ONE commit: `fix(dashboard): user#5 chart follows the focused
      collection` with a verification-count trailer.

- [ ] 6. (Bug #6) Add a pure hero-image-src helper keyed on the selected variant.
      In `src/lib/utils/card-image.ts` (client-safe — no Prisma/secrets) add
      `export function variantHeroSrc({ game, routeId, variant, defaultVariant }:
      { game: "pokemon" | "onepiece"; routeId: string; variant: string | null;
      defaultVariant: string | null }): string`. Logic: `const baseId =
      routeId.split("::")[0];` — when `variant` is set AND `variant !== defaultVariant`
      AND `variant` is non-empty, resolve the hero through the composite printing id
      `cardImgById(`${baseId}::${variant}`)` (the id-proxy serves THAT printing row's
      `imageUrl` for BOTH games — the route is game-agnostic). Otherwise keep the current
      base behavior: `game === "onepiece" ? (onePieceImageUrl(routeId) ?? PLACEHOLDER)
      : cardImgById(routeId)`. Export a `HERO_PLACEHOLDER = "/cards/card-front.webp"`
      const (or accept a placeholder param) so the helper and the page agree on the
      fallback. RULE 2: a printing with no distinct stored image just 404s the proxy →
      the page's existing `onError` swaps in the placeholder (never a broken image). Keep
      the load-bearing comments explaining the `::` suffix + proxy.
      Files: `src/lib/utils/card-image.ts`
      Verify: `npx vitest run tests/unit/card-image.test.ts` still passes.

- [ ] 7. (Bug #6) Wire the hero image to the selected variant in the detail page.
      In `src/app/(dashboard)/search/[id]/page.tsx` replace the inline `heroSrc`
      computation with `const heroSrc = variantHeroSrc({ game, routeId: id, variant,
      defaultVariant });` (import from `@/lib/utils/card-image`). `variant`,
      `defaultVariant`, `game`, and `id` are already in scope. Keep `PLACEHOLDER`
      (align it to the helper's constant or reuse the exported one). The existing
      `useEffect(() => setHeroError(false), [heroSrc])` already resets the onError flag
      on src change — confirm it still fires because `heroSrc` now changes on variant
      switch. Do NOT add a named export to `page.tsx`. Preserve the load-bearing
      hero/`img=`-removal + One-Piece-proxy comments.
      Files: `src/app/(dashboard)/search/[id]/page.tsx`
      Verify: `npm run type-check` clean (modulo H-2); the composite-id regression test
      `npx vitest run tests/unit/composite-id-detail.test.ts` still passes.

- [ ] 8. (Bug #6) Unit-test the variant→hero-src derivation.
      In a new `tests/unit/variant-hero-src.test.ts` (or extend `card-image.test.ts`)
      import `variantHeroSrc`, `cardImgById`, `onePieceImageUrl`, `HERO_PLACEHOLDER` and
      assert: Pokémon base variant (`variant === defaultVariant`) → `cardImgById(routeId)`;
      Pokémon non-default variant → `cardImgById("base1-4::reverse holofoil")` (composite,
      suffix intact, url-encoded as `cardImgById` does); One Piece base variant →
      `onePieceImageUrl(routeId)` (or PLACEHOLDER when the code isn't Bandai); One Piece
      non-default variant → `cardImgById("OP01-120::alt-art")` (per-printing proxy, NOT
      the base Bandai proxy); a composite ROUTE id (`base1-15::unlimitedShadowlessHolofoil`)
      with the default variant equal to its suffix → base behavior, and selecting a
      DIFFERENT variant → `${baseId}::${newVariant}`; `variant === null` → base behavior.
      Files: `tests/unit/variant-hero-src.test.ts` (new)
      Verify: `npx vitest run tests/unit/variant-hero-src.test.ts` — all pass.
      Commit items 6–8 as ONE commit: `fix(card-detail): user#6 hero image follows the
      selected variant` with a verification-count trailer.

- [ ] 9. Integration verification across all three bugs.
      Run `npm run lint`, `npm run type-check` (expect ONLY the known `src/lib/auth.ts`
      H-2 errors — no new ones), and `npm run test:unit`. Then run `npm run build` to
      confirm the Page-type guard passes (no named exports leaked into `page.tsx`).
      Re-run `add-invalidates-chart.test.tsx` ALONE if it flaked in the full run.
      Files: none (verification only)
      Verify: lint clean; type-check shows no NEW errors; `npm run test:unit` green;
      `npm run build` completes the Page phase without error.

## Notes / assumptions
- The `variant` token stored in `CurrentPrice.variant` (what `listVariants` returns) is
  the SAME verbatim Scrydex `variants[].name` used as the composite-id suffix
  (`card-number.ts` `printingExternalId`/`printingVariantFromId`), so
  `${baseId}::${variant}` is the correct per-printing externalId to resolve art.
  If a selected variant has no distinct printing row/image, the proxy 404s and the
  page's existing `onError` placeholder covers it (RULE 2 — never a broken image).
- Bug #5 fix is deliberately client-side: the server history route already scopes by
  `collectionId`, so no server change is needed and none is made (smallest correct diff).
  The dropdown-selector path was verified already-correct; only the focus-pill path was
  broken.
