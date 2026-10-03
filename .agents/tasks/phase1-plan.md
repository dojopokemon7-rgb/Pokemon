# Phase 1 — UI Fixes Implementation Plan (front-end ONLY)

> **Scope:** 5 purely front-end UI fixes. **NO** Prisma schema change, **NO** migration,
> **NO** new dependency, **ZERO** Scrydex / external API calls. The Scrydex credit gate
> (`src/lib/services/scrydex-credit-gate.ts`) stays at its default DENY state — do **NOT**
> set `SCRYDEX_LIVE_CREDITS_APPROVED` and do **NOT** touch the `scrydex:credit-approval`
> Redis flag. Zero credits may be spent.
>
> **All paths are inside the worktree** `d:\Pokemon\.worktrees\phase1-ui-fixes`. Use the
> absolute form `d:\Pokemon\.worktrees\phase1-ui-fixes\<path>` for every read/write.

## Environment precondition (do this ONCE before any type-check/build)

The generated Prisma client is STALE, so bare `npm run type-check` (`tsc --noEmit`) reports
~80 **phantom** errors (missing `UserCollection.isSold`, `Card.currentPrices`, etc.) that are
NOT in these files and NOT caused by these edits. Before type-checking/building:

```
npx prisma generate
```

(or run `npm run build`, which runs `prisma generate && next build`). Do **NOT** "fix" the
phantom errors in source — they vanish once the client is regenerated. When a step below says
"type-check clean", it means: after `npx prisma generate`, `npm run type-check` shows **no NEW
errors in the three edited files** (`search/[id]/page.tsx`, `search/page.tsx`,
`DashboardClient.tsx`). The pre-existing phantom-count baseline is informational only.

## Design source of truth

`d:\Pokemon\dojo-design\dojo-design-system\components\feedback\AreaChart.jsx` (the task's
`.reference\...` path does NOT exist in the worktree; the live copy is under `dojo-design\`).
Token mapping from the design's CSS vars → this app's `--color-dojo-*` (all confirmed present
in `src/app/globals.css`): `--stroke-strong` → `--color-dojo-stroke-strong`; `--surface-raised`
→ `--color-dojo-raised`; `--stroke-card` → `--color-dojo-stroke`; `--surface-card` →
`--color-dojo-card`; `--text-faint` → `--color-dojo-faint`; `--jade-500` → `--color-dojo-jade`;
`--verm-500` → `--color-dojo-vermilion`; `--accent`/`--amber-500` → `--color-dojo-gold`.

## Invariants to preserve (AGENTS.md)

Rule 2 (never fabricate; missing value = `null` = render "—"), rule 3 (`Card.id` cuid vs
`Card.externalId`), rule 10 (design tokens only; SQUARE corners / radius 0; `ArrowRight.tsx`
canonical arrow), offset pagination untouched, Redis optional, Zod boundaries, ownership
scoping. Preserve all load-bearing comments/doc-chains — edit values, keep the WHY comments.

---

## Suggested order

1 → 2 → 3 → 4 → 5. Items 1–4 are independent one-spot edits; do them first (fast, low risk,
each independently verifiable). Item 5 (charts) is the largest and touches two of the files
items 1 and 3 also touch, so land it last to avoid re-reading shifting line numbers.

---

- [ ] 1. **ITEM #6 — kill the fabricated `246` price fallback; render null as "—" in every `price` consumer.**
      In `src/app/(dashboard)/search/[id]/page.tsx` (`CardDetailInner`):
      - **(a) Definition (~L505):** change
        `const price = fetchedPrice ?? (priceParam > 0 ? priceParam : 246);`
        to
        `const price = fetchedPrice ?? (priceParam > 0 ? priceParam : null);`
        `price` is now `number | null`. (`chipPrice.raw` at ~L708 already uses the identical
        `?? null` expression — leave it; the two now agree.)
      - **(b) `ADD_ROWS` useMemo (~L587-609):** the current `const rawPrice = price || 0;` turns
        `null` into `0`, which would render a misleading `$0.00` and still compute a fabricated
        PSA price off 0. Change to keep null honest:
        ```ts
        const rawPrice = price;                       // number | null
        const psa10Multiplier = 2 + 50 / ((rawPrice ?? 0) + 10);
        const psa10Price =
          gradedData?.price ?? (rawPrice != null ? rawPrice * psa10Multiplier : null);
        return [
          { id: "raw",   section: "raw" as const,    label: "Foil", price: rawPrice },
          { id: "psa10", section: "graded" as const, label: "PSA 10 (GEM - MT)",
            variant: "Foil", pop: "Pop: 3583", price: psa10Price,
            isFallback: gradedData?.price == null ? true : gradedData.isFallback },
        ];
        ```
        Row `price` is now `number | null`. Keep the load-bearing heuristic comment above it.
      - **(c) `addTotal` (~L703):** guard the multiply so null rows contribute 0 to the total:
        `const addTotal = ADD_ROWS.reduce((a, d) => a + (addQty[d.id] || 0) * (d.price ?? 0), 0);`
      - **(d) Price header (~L846):** change `{fmtUSD(price)}` to
        `{price != null ? fmtUSD(price) : "—"}` and (optional, matches list behavior) set the
        wrapping `<div>`'s `color` to `price != null ? "var(--color-dojo-ink)" : "var(--color-dojo-faint)"`.
      - **(e) `AddQtyRow` (~L1061):** widen the prop type `price: number` → `price: number | null`
        and change its render `{fmtUSD(price)}` (~L1067) to `{price != null ? fmtUSD(price) : "—"}`.
        (`AddQtyRow` is called at ~L969 and ~L974 with `price={d.price}` — no call-site change
        needed once the prop type is nullable.)
      - **(f) Add payload (~L1020):** already `marketPrice: price || null` — leave as-is (null-safe).
      Do **NOT** add a `NoPriceText` import here (that component lives in `search/page.tsx`'s
      import only); this file's convention is the literal `—`, matching the existing `RecentSales`
      row (`priceStr … : "—"`) and `chipPrice` ("—") usage.
      Files: `src/app/(dashboard)/search/[id]/page.tsx`
      Verify: `npx prisma generate` then `npm run type-check` — no NEW errors in this file
      (confirms every `price`/`d.price`/`AddQtyRow` consumer handles `number | null`). Then
      `npm run build` succeeds. Manual DOM check in a dev build (`npm run dev`): open a card
      with no `?price=` param and no `CurrentPrice`/`marketPrice` → the price header, the
      Ungraded raw row, and the PSA 10 row all read `—` (never `$246.00`, never `$0.00`); open a
      genuinely priced card (tile passed `?price=`) → the real price still shows and PSA 10
      still computes. `npm run test:unit` passes (no unit test asserts the 246 literal; confirm).

- [ ] 2. **ITEM #9 — remove the Explore CONTINUE / Skip footer; keep SHOW MORE.**
      In `src/app/(dashboard)/search/page.tsx`, inside the `!hasQuery` trending/empty-state
      block, delete the footer `<div>` that holds the `CONTINUE` button and the `Skip` `<Link>`
      (currently ~L1355-1379: the comment block `{/* CONTINUE / Skip footer … */}` plus the
      `<div style={{ display: "flex", flexDirection: "column", gap: "14px", padding: "18px 0 4px" }}>…</div>`).
      **PRESERVE** the `SHOW MORE` pagination block directly above it
      (`{!trendingLoading && !trendingError && hasMoreTrending && ( … SHOW MORE … )}`, ~L1343-1353)
      — that is real offset pagination, unrelated. Do not touch `fetchMoreTrending`/`hasMoreTrending`.
      After removal, check whether `router` and/or `Link` become unused **in this file**: both
      are used elsewhere (router.push and other `<Link>`s / `href`s exist throughout), so most
      likely leave the imports — but run lint to confirm no `no-unused-vars` fires; only remove
      an import if lint flags it.
      Files: `src/app/(dashboard)/search/page.tsx`
      Verify: `npm run lint` passes (no unused-import error). `npx prisma generate` then
      `npm run build` succeeds. Manual DOM check: visit `/search` with no `?q` → the trending
      grid and the `SHOW MORE` button render; the `CONTINUE` button and `Skip` link are GONE.
      Visit `/search?q=charizard` → results render unchanged (footer was never in the `hasQuery`
      branch). `npm run test:e2e` (the `authed`/`chromium` specs that visit `/search`) still pass.

- [ ] 3. **ITEM #7 — stop injecting the synthetic "Want to buy" collection on the dashboard.**
      In `src/app/(dashboard)/dashboard/_components/DashboardClient.tsx`, inside the `collOptions`
      useMemo, delete the entire want-buy injection (currently ~L614-631): the comment
      `{/* "Want to buy" tracking collection … */}`, the `const hasNamedWant = …` line, and the
      whole `if (!hasNamedWant) { … opts.push({ id: "__want_buy__", … paid: Math.round(wantBuyTotal * 0.74) … }) }`
      block. This also removes the fabricated `paid = ×0.74` (a rule-2 smell).
      After deletion, `wantItems` is no longer referenced **inside this memo** (it is still used
      by the separate `wantRows` memo, so the `useQuery` for `["want-list","all"]` stays). Remove
      `wantItems` from THIS memo's dependency array (currently `}, [collectionList, collectionData, wantItems]);`
      → `}, [collectionList, collectionData]);`) so `react-hooks/exhaustive-deps` stays clean.
      Do **NOT** touch the `__uncat__` ("Main") push above it or the named-collections `forEach`
      below it. Do **NOT** touch the wantlist page or `useWantToBuy` — they read the
      `["want-list"]` query family directly and are independent of `collOptions`.
      Files: `src/app/(dashboard)/dashboard/_components/DashboardClient.tsx`
      Verify: `npm run lint` passes (confirms exhaustive-deps clean after the dep-array trim).
      `npx prisma generate` then `npm run build` succeeds. Manual DOM check: load `/dashboard` →
      the collection selector pills and the comparison-chart series list show **Main +** named
      collections only, with **no "Want to buy"** entry. Load `/wantlist` → Want to Buy items
      still list; on `/search`, tapping the star still toggles instantly (the `useWantToBuy`
      optimistic path is untouched). `npm run test:unit` + `npm run test:integration` pass.

- [ ] 4. **ITEM #11 — Explore trending tile art fills the tile width (62% → 100%).**
      In `src/app/(dashboard)/search/page.tsx`, in `TrendCardTile`, change the art wrapper
      (currently ~L228) from
      `<div style={{ width: "62%", alignSelf: "center" }}>`
      to
      `<div style={{ width: "100%" }}>`
      (set width to 100% and DROP `alignSelf: "center"`). Do **NOT** add any fixed pixel height
      and do **NOT** edit `src/components/CardImage.tsx` — it already applies
      `aspectRatio: "660 / 921"` and `width/height: 100%`, so height scales proportionally with
      no layout shift once the wrapper is full width. Leave the results-grid `CardTile` (which
      already fills tile width) alone.
      Files: `src/app/(dashboard)/search/page.tsx`
      Verify: `npm run lint` + (`npx prisma generate` then) `npm run build` succeed. Manual DOM
      check: on `/search` (no `?q`), inspect a trending tile's image wrapper → computed `width`
      equals the tile content width (no 62% box, not centered); the image keeps the 660/921
      aspect ratio (height grows with width); no horizontal gap/centering gutter. No console
      layout-shift warnings. `npm run test:e2e` trending/visual specs still pass (run with
      `VISUAL=1` only if a baseline exists; otherwise skip visual gating).

- [ ] 5. **ITEM #13 — align BOTH hand-rolled charts to the design-system `AreaChart` (appearance only; NeoPOP no-blur).**
      Appearance/markup only — do **NOT** change chart DATA, the series math, offset pagination,
      or motion durations (keep 120/150/200ms). Keep SQUARE corners (radius 0). Reference every
      value against `dojo-design/.../AreaChart.jsx` and the token mapping above. Two files:

      **5A — Dashboard `MultiLineComparisonChart` in `DashboardClient.tsx` (~L160-390):**
      - **Gradient (defs, ~L269-277):** bump stops from `stopOpacity={0.25}` / `stopOpacity={0.02}`
        to `stopOpacity={0.3}` (0%) and `stopOpacity={0}` (100%), matching the multi-series spec.
      - **Area fill for EVERY series (~L279-288):** the fill is currently gated behind `isSingle`.
        Replace that single-series `<path>` with one area `<path>` per series (map over
        `seriesList`), each `fill={`url(#dojoGrad-${s.id})`}`, drawn BEFORE the polylines so lines
        sit on top. Area path per series:
        `M0,${H} L${s.data.map((d,i)=>`${i*step},${y(d.value)}`).join(" L")} L${W},${H} Z`.
        You can then drop the now-unused `isSingle` constant (remove its declaration ~L240 too;
        lint will flag it if left).
      - **Hover guide (~L308-317):** change `stroke="rgba(255,255,255,0.25)"` to
        `stroke="var(--color-dojo-stroke-strong)"` and add `strokeDasharray="3 3"` (dashed).
      - **Marker dots (~L320-342):** replace the HTML `<span>` dots carrying
        `boxShadow: `0 0 0 2px rgba(0,0,0,0.8), 0 0 8px ${s.color}`` (a GLOW — forbidden) with
        the design SVG marker: inside the `<svg>`, when `activeIdx != null`, render per series a
        `<circle cx={activeIdx*step} cy={y(val)} r={4} fill={s.color} stroke="var(--color-dojo-raised)" strokeWidth={2} />`
        (ring = raised surface, no blur, no glow). Focused series may use `r={5}`. Remove the
        absolute-positioned `<span>` dot block entirely.
      - **Tooltip (~L344-382):** remove `backdropFilter: "blur(6px)"` and
        `boxShadow: "0 6px 18px rgba(0,0,0,0.6)"`; change `background: "rgba(18, 18, 18, 0.95)"`
        to `background: "var(--color-dojo-raised)"`; keep `border: "1px solid var(--color-dojo-stroke)"`
        and square corners. If any elevation is wanted, use the house hard-offset shadow
        `boxShadow: "5px 5px 0 0 #000"` — NEVER blur. Keep the per-series swatch rows.
      - **X-axis label row / legend:** the dashboard already renders a focus-chip legend row
        ABOVE the chart (the color-swatch collection buttons) and a range-tab row below, so the
        design's legend requirement is already satisfied — do NOT add a duplicate legend. The
        dashboard series data is `{ value }[]` with **no per-point label field**, so an x-axis
        date-label row cannot be added without fabricating labels (rule 2) — SKIP the x-axis row
        on the dashboard and note this in the commit. (The detail chart below DOES have dates and
        gets the x-axis row.)

      **5B — Card-detail `DojoChart` in `search/[id]/page.tsx` (~L120-310):**
      - **Area gradient fill (~L261-269):** replace the flat
        `<polygon points={areaStr} fill={s.color} opacity={series.length>1 ? 0.1 : 0.14} />`
        with a vertical `linearGradient` fill. Add a `<defs>` block inside the `<svg>` with one
        `<linearGradient id={`dojoDetailGrad-${si}`} x1="0" y1="0" x2="0" y2="1">` per series
        (`<stop offset="0%" stopColor={s.color} stopOpacity="0.3" />`,
        `<stop offset="100%" stopColor={s.color} stopOpacity="0" />`), then
        `<polygon points={areaStr} fill={`url(#dojoDetailGrad-${si})`} />`. Keep the `<polyline>`
        stroke line as-is. (Multi-series uses 0.3; single could use 0.35 per design — 0.3 is fine
        for both and simplest.)
      - **Hover guide (~L278):** change
        `<line … stroke="rgba(255,255,255,0.3)" strokeWidth={1} />` to
        `stroke="var(--color-dojo-stroke-strong)"` + `strokeDasharray="3 3"`.
      - **Marker dots (~L280-290):** already close to design (`r={3.5}`,
        `stroke="var(--color-dojo-app)"`). Align to design: `stroke="var(--color-dojo-raised)"`
        (surface-card ring) — optional bump `r` to 4; leave `strokeWidth` ~1.5-2. No glow present
        (good).
      - **Tooltip (~L300-308):** change `background: "var(--color-dojo-overlay)"` to
        `background: "var(--color-dojo-raised)"` (design = surface-raised); keep the existing
        `1px solid var(--color-dojo-stroke)`, no shadow, square corners.
      - **X-axis label row:** AFTER the `<svg>` wrapper (inside the `DojoChart` return, below the
        tooltip), when `points` is provided, add a label row mirroring `AreaChart.jsx`:
        `<div style={{ display:"flex", justifyContent:"space-between", marginTop:8 }}>` mapping a
        few `points` dates through the existing `fmtChartDate` helper, each
        `<span style={{ fontSize:11, color:"var(--color-dojo-faint)" }}>`. To avoid crowding on
        the narrow mobile chart, render only ~4-6 evenly-sampled labels (first, last, and a couple
        between) rather than every point. Guard on `points?.length` so the mock/flat-baseline case
        (no `points`) renders no row. Grid lines in this chart use `rgba(255,255,255,.07)` — leave
        as-is (no exact token; not called out).
      - Raw hex swaps: in the `SERIES` const (~L72) the PSA 9 color `"#0AC27E"` → `"var(--color-dojo-jade)"`
        (token exists, same value). Leave Raw `"#9AA0A6"` (neutral grey, no matching token — design
        doesn't tokenize it). PSA 10 is already `var(--color-dojo-gold)`.

      Files: `src/app/(dashboard)/dashboard/_components/DashboardClient.tsx`,
      `src/app/(dashboard)/search/[id]/page.tsx`
      Verify: `npm run lint` (confirms removed `isSingle`/dead vars don't linger) +
      (`npx prisma generate` then) `npm run build` succeed. Manual SVG/DOM inspection in
      `npm run dev`:
      - Dashboard chart (`/dashboard`, hover/tap a point): the vertical guide is a DASHED line
        (`stroke-dasharray="3 3"`, strong-stroke color); marker is an SVG `<circle>` with a raised
        ring and **no** CSS `box-shadow` blur/glow (inspect: the `<span>` glow dots are gone);
        the tooltip element has **no** `backdrop-filter` and no soft `box-shadow` (computed style),
        background = `--color-dojo-raised`, 1px stroke, square corners; EVERY selected series shows
        a gradient area fill (not just when one is selected).
      - Detail chart (open any card with ≥2 history points): the area is a vertical gradient
        (inspect `fill="url(#dojoDetailGrad-…)"`, not a flat `opacity` polygon); guide is dashed;
        tooltip background = `--color-dojo-raised`; an x-axis date-label row appears below the
        chart (sampled labels, formatted like "Jun 2026"); a card with <2 points shows the flat
        baseline and **no** label row (no fabricated dates).
      - `npm run test:unit`, `npm run test:integration`, and `npm run test:chart-accuracy`
        (±10% gate — appearance-only edits must NOT move the data, so this must still pass) all
        pass. `npm run test:e2e` chart specs (F-09 hover/tooltip) still pass; run visual specs
        only if `VISUAL=1` baselines exist.

---

## Final gate (after all 5 items)

Run, in order (from the worktree root):
```
npx prisma generate
npm run lint
npm run type-check      # no NEW errors in the 3 edited files
npm run build           # prisma generate && next build — succeeds
npm run test:unit
npm run test:integration
npm run test:chart-accuracy
npm run test:e2e        # needs a reachable DATABASE_URL; runs the standalone build on :3001
```
(`npm run verify` chains lint → unit → integration → chart-accuracy → e2e — the project gate.)

**Must hold at the end:** zero Scrydex credits spent; `scrydex-credit-gate.ts` still DENY;
no schema/migration/dependency change (`git diff --stat` shows only the 3 `.tsx` files, plus
this plan/artifacts under `.agents/`); the `246` literal is gone; no `backdropFilter`/blur/glow
remains in either chart; load-bearing comments preserved.

## Notes / assumptions

- The task prompt's design path (`.reference\dojo-design\…`) is absent in the worktree; the
  actual reference is `dojo-design\dojo-design-system\components\feedback\AreaChart.jsx`
  (identical file, confirmed read). Content was rephrased for compliance.
- `multi/page.tsx` has its OWN local `price` variable and its own chart-less list — item #6/#13
  do **not** touch it (the task names only `search/[id]/page.tsx` and `DashboardClient.tsx`).
- Dashboard x-axis date labels are intentionally skipped (no per-point label data → would
  violate rule 2). This is the one place the plan deviates from a literal reading of #13(f),
  and it is the honest choice; the detail chart gets the label row because it has real dates.

---

## Verification note (iteration 1 — implementer)

**Design reference:** the worktree has NO `dojo-design/` tree; the identical `AreaChart.jsx`
lives in the MAIN repo at `d:\Pokemon\dojo-design\dojo-design-system\components\feedback\AreaChart.jsx`
and was read from there. All chart values were aligned against it. (A workspace-scoped
grep/Select-String for `backdropFilter`/`blur`/glow may surface matches in the MAIN repo's OLD
`d:\Pokemon\src\...` copies — those are NOT the worktree files; the worktree files are clean.)

**Commands run (from the worktree root), in order, all PASS:**

| Command | Result |
|---|---|
| `npx prisma generate` | Generated Prisma Client v6.19.3 (clears ~80 stale phantom errors) |
| `npm run lint` | exit 0 — no unused-import / no exhaustive-deps / no dead-var errors |
| `npm run type-check` (`tsc --noEmit`) | exit 0 — clean (every `price`/`d.price`/`AddQtyRow` consumer handles `number \| null`) |
| `npm run build` (`prisma generate && next build`) | exit 0 — all routes compiled, incl. `/dashboard`, `/search`, `/search/[id]` |
| `npm run test:unit` | 17 files / **101 tests passed** (incl. `use-want-to-buy`, `card-price`, `scrydex-credit-gate`) |

NOT run (per task instruction): `test:integration`, `test:chart-accuracy`, `test:e2e`, dev server.

**Scope confirmed (`git status --porcelain`):** only the 3 target `.tsx` files modified
(`DashboardClient.tsx`, `search/[id]/page.tsx`, `search/page.tsx`) + this untracked plan under
`.agents/`. NO schema / migration / dependency change. Scrydex credit gate untouched (still
DENY by default; `SCRYDEX_LIVE_CREDITS_APPROVED` unset; `scrydex:credit-approval` untouched) —
zero credits spent (no external calls in any edit).

**Per-item visual/DOM confirmations:**
- #6: the `246` literal is GONE (`price: number | null = fetchedPrice ?? (priceParam > 0 ? priceParam : null)`);
  price header, raw `ADD_ROWS` price, PSA-10 base, `addTotal`, and `AddQtyRow` all null-guarded → render `—`,
  never `$246.00`/`$0.00`. Load-bearing PSA-multiplier heuristic comment preserved.
- #9: CONTINUE button + Skip `<Link>` footer removed from the `!hasQuery` block; SHOW MORE pagination
  block preserved; `router`/`Link` still used elsewhere (lint clean, imports kept).
- #7: `__want_buy__` synthetic injection + fabricated `paid = ×0.74` removed from `collOptions`;
  `wantItems` dropped from THIS memo's dep array (still used by `wantRows`); wantlist page / `useWantToBuy`
  untouched (read `["want-list"]` directly).
- #11: `TrendCardTile` art wrapper `width:"62%", alignSelf:"center"` → `width:"100%"`; no fixed px height
  added; `CardImage.tsx` untouched (keeps 660/921 aspect-ratio).
- #13: BOTH charts verified via `Select-String` to contain NO `backdropFilter` / `blur(` / `0 0 8px` glow /
  raw `rgba(255,255,255,0.25|0.3)` guide strokes. Dashboard: gradient stops 0.3→0, per-series area fill,
  dashed `strokeDasharray="3 3"` strong-stroke guide, SVG `<circle>` markers with raised ring, tooltip
  `background:var(--color-dojo-raised)` + hard-offset `5px 5px 0 0 #000` (no blur), `isSingle` removed.
  Detail: vertical `linearGradient` area fill (`url(#dojoDetailGrad-N)`), dashed strong-stroke guide, marker
  ring `var(--color-dojo-raised)`, tooltip `--color-dojo-raised`, sampled x-axis date-label row guarded on
  `points?.length > 1`, PSA 9 color `#0AC27E` → `var(--color-dojo-jade)`. Dashboard x-axis labels skipped
  (no per-point dates — rule 2). Square corners (radius 0) throughout; motion durations unchanged.
