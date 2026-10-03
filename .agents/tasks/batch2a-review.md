# Batch 2A — Shared AreaChart port, real weekly deltas, comment corrections

Batch 2A replaces two hand-rolled SVG charts with a single faithful TypeScript port of the design-system `AreaChart.jsx`, swaps every fabricated dashboard delta (`mockDelta`/`seededFrac`/hardcoded `+4.1%`) for the real stored `Card.weeklyChangePct` (em-dash when null), and corrects two stale load-bearing comments. The change is UI/wiring + comments only: no schema, migration, dependency, or credit-gate changes, and no Scrydex/external calls. The port maps the design file's abstract tokens to the app's `--color-dojo-*` set, keeps NeoPOP discipline (no blur/glow/soft-shadow, square tooltip), and both chart sites keep their existing data sources and honest empty/flat-baseline states.

Watch for: (confirmed) the detail page keeps a now-vestigial `realPts` normalization array that AreaChart no longer consumes for scaling — harmless, not blocking. (confirmed) a pre-existing `OVERALL_PCT_BY_RANGE` hardcoded portfolio-header percentage remains in DashboardClient, but it is unchanged by this diff and out of Item B's named scope (`+4.1%`/`mockDelta`/`seededFrac`).

**Verdict**: APPROVED

## High-level view

The port in `src/components/AreaChart.tsx` is a line-for-line translation of the design-system source: same `scaleCoords` math with `min = Math.min(0, …)`, same `viewBox 0 0 560 h`, gradient stops 0.35→0 (single) / 0.3→0 (multi), three gridlines at 0.25/0.5/0.75, a dashed `3 3` hover guide, `r=4` markers with a card-surface ring, and a square, shadow-less tooltip. The abstract design tokens map 1:1 to the app's `--color-dojo-*` variables, with the single documented exception of `--amber-500 → gold` (no amber token exists in the app); `SERIES_PALETTE` keeps the two literal hex values. All mapped tokens were verified to exist in `globals.css`.

Both chart sites now render through the port without touching their data sources. The detail page feeds the one real `{date, price}` history series (single-series mode) and falls back to a flat, label-less baseline below two real points rather than fabricating a curve. The dashboard transposes its per-collection series into the multi-series shape, omits x-axis labels (no per-point dates to show honestly), and keeps the "No price history yet" / "No cards" empty states. Because the port's tooltip has no value-masking hook, the dashboard's "hide values" toggle now renders a "Values hidden" placeholder instead of the chart — an honest substitution for the removed masked tooltip.

Item B is complete: `mockDelta`, `seededFrac`, and the hardcoded `+4.1%` are deleted (grep-confirmed absent across worktree `src`). The real stored `weeklyChangePct` (already a schema column, Scrydex `trends.days_7`) is now surfaced through the prices route, the collection GET select, and the want-list service; a `null` value renders a muted em-dash, never a fabricated number. Gainers/Losers sort by the real value with nulls excluded, and collections (which have no single per-collection weekly delta) honestly show em-dash.

Item C corrects two comments to match live code: the `scrydex.service.ts` header no longer claims there is no history endpoint (a real credit-gated `price_history` endpoint is wired), and the `cards/[id]/history` route comment describes the real honest empty state instead of the removed mock series.

<details>
<summary>Issues (0 blocking, 2 informational)</summary>

1. **Vestigial `realPts` array (informational)** — the detail page still computes a normalized `realPts` array that AreaChart does its own scaling over; it now only gates the baseline branch and single-chip color. Harmless; could be simplified later.
2. **Pre-existing `OVERALL_PCT_BY_RANGE` (informational, out of scope)** — the portfolio-header percentages are hardcoded but exist unchanged on master and are not among Item B's named targets. Not addressed by this batch by design.

</details>

<details>
<summary>Details</summary>

### Faithful port of the design-system AreaChart (Item A)

`src/components/AreaChart.tsx` is a direct translation of `dojo-design/.../feedback/AreaChart.jsx`, not a re-interpretation. The `scaleCoords` helper is identical including `range = (max - min) || 1` and the `min = Math.min(0, Math.min(...allValues))` baseline-at-zero behavior. The single-series branch uses gradient stops `0.35 → 0`, the multi-series branch `0.3 → 0`, matching the source exactly. Gridlines render at `[0.25, 0.5, 0.75]`, the hover guide is a `strokeDasharray="3 3"` vertical line on `--color-dojo-stroke-strong`, markers are `r=4` filled with the series color and ringed with `--color-dojo-card` (`strokeWidth={2}`), and the tooltip is `1px --color-dojo-stroke` on `--color-dojo-raised`, square corners, `padding: "8px 12px"`, no shadow and no blur. The `viewBox` is `0 0 560 h`, the x-axis label row and multi-series legend are both ported, and single-series `trendColor` resolves green-rising (`JADE`) / red-dipping (`VERM`). The one React/TS adaptation — wrapping each series' area+line in `<g>` instead of `<React.Fragment>` — is cosmetically identical in the rendered SVG.

Token mapping matches the required table and was verified against `globals.css`: `accent→gold (#E9B43B)`, `jade→jade`, `verm→vermilion`, `amber→gold` (with the explicit comment noting no separate amber token), `stroke-card→stroke`, `stroke-strong→stroke-strong`, `surface-card→card`, `surface-raised→raised`, `text-faint→faint`, `text-heading→ink`, `font-body→--font-body`. The design source actually uses `--stroke-card` (white .10) for gridlines and the tooltip border; mapping that to `--color-dojo-stroke` (also white .10) is the correct equivalent. `SERIES_PALETTE` preserves the two literal hex values `#D400FF` and `#2D7FF9`. Types were ported verbatim from `AreaChart.d.ts` and exported so both sites type their props.

### Both chart sites re-wired without changing data sources

The detail page (`search/[id]/page.tsx`) removed the ~200-line hand-rolled `DojoChart` (custom pointer handling, outside-click dismissal, HTML tooltip, x-axis sampler) and now renders `<AreaChart data={detailChartData} height={170} color={detailChartColor} />`. The data source is unchanged: the same `useQuery(["card-history", id])` → `windowPts` pipeline feeds `detailChartData`, which maps real `{date, price}` points to `{label, value}` when there are ≥2 real points in the window, and otherwise returns a two-point flat, label-less baseline (`value: 1`) — no fabricated dates or prices. `detailChartColor` reproduces the old per-chip color affordance (single selected grade → that chip's color; otherwise trend coloring). The removed tooltip took its `boxShadow` with it — grep confirms no shadow/blur in the detail chart region.

The dashboard `MultiLineComparisonChart` kept its two honest empty states (`seriesList.length === 0 || every series < 2 points` → "No price history yet"; no values → "No price history yet") and now transposes the per-series arrays into the port's row-per-index shape, bounding the row count by the shortest series so no read runs past an array end. X-axis labels are deliberately empty strings because the real history points carry no per-point date labels here — omitting rather than fabricating, consistent with AGENTS.md rule 2. The removed soft tooltip (`boxShadow: "5px 5px 0 0 #000"`) is gone. Because the ported tooltip exposes raw values with no mask hook, the `hidden` eye-toggle now short-circuits to a "Values hidden" placeholder — an honest trade documented in the component comment, preserving the privacy affordance the toggle promises.

### Real weekly deltas replace all fabricated numbers (Item B)

`mockDelta`, `seededFrac`, and the hardcoded `▲ +4.1% · 1M` are all deleted — grep across the worktree `src` returns no matches for any of the three. The replacement reads `Card.weeklyChangePct` (an existing schema column, confirmed present in both master and worktree `schema.prisma`, so no schema change), surfaced through three thin additions: the prices route now returns `weeklyChangePct: card.weeklyChangePct ?? null`, the collection GET select adds `weeklyChangePct: true`, and the want-list service item carries `weeklyChangePct`. The detail header prints the real value with sign-driven arrow and jade/vermilion color, falling back to a muted em-dash when null. On the dashboard, `fmtDelta` turns a number into `{delta, up}` and a null into `{delta: null}` → `DeltaTag` renders em-dash with no arrow/color. Gainers filter `>= 0` and sort descending, Losers filter `< 0` and sort ascending, both excluding nulls. Collections honestly show em-dash since no per-collection weekly delta is stored. The `up` direction is now derived from the real sign rather than a seeded coin-flip.

### Comment corrections (Item C)

Both edits are comment-only. The `scrydex.service.ts` header previously claimed "There is NO history endpoint … `fetchPriceHistory` is deleted"; it now correctly states that `GET /{slug}/v1/cards/{id}/price_history` (3 credits, credit-gated) exists and is wired via `fetchScrydexPriceHistory`, while noting the legacy `/prices/history/...` path still 404s. The `cards/[id]/history` route comment no longer says the detail page "falls back to its mock series" — it describes the real honest empty state (flat, label-less baseline). Both corrections align stale load-bearing comments with live behavior rather than stripping them.

### Constraints and verification

No schema/migration/dependency change (schema, migrations, `package.json`, `package-lock.json` all absent from the diff name-list). The credit gate is untouched and no Scrydex/external call is introduced — `weeklyChangePct` is read from already-stored columns. Design-token discipline holds and the component carries no blur/backdrop/soft-shadow/glow; the only `boxShadow` hits in the touched files are unrelated UI (dropdown popovers, the "add your first card" CTA's hard-offset NeoPOP shadow, view-toggle inset borders) that predate this diff. Load-bearing comments were corrected, not stripped.

Verification evidence is recorded in the commit messages across all four commits: `prisma generate`, lint clean, type-check clean, build OK, and unit 101/101 (including a new collection-series test), plus a grep confirming the three removals and the no-shadow/no-blur state. Per the review instructions this evidence is accepted rather than re-run; the two narrow spot-checks performed (grep for the three removals across worktree `src`; grep for blur/shadow in the component and both sites) corroborate the recorded results.

</details>

<details>
<summary>File map</summary>

- `src/components/AreaChart.tsx` — new shared client component; faithful port of the design-system AreaChart (single + multi series).
- `src/app/(dashboard)/search/[id]/page.tsx` — removed hand-rolled `DojoChart`; renders via AreaChart; real `weeklyChangePct` header with em-dash fallback.
- `src/app/(dashboard)/dashboard/_components/DashboardClient.tsx` — removed `mockDelta`/`seededFrac`; MultiLineComparisonChart renders via AreaChart; real-delta Gainers/Losers/Most-Valuable/want rows; "Values hidden" placeholder.
- `src/app/api/cards/[id]/prices/route.ts` — returns real `weeklyChangePct` (null-safe) alongside prices.
- `src/app/api/users/me/collection/route.ts` — adds `weeklyChangePct` to the card select.
- `src/lib/services/want-list.service.ts` — adds `weeklyChangePct` to want-list items.
- `src/app/api/cards/[id]/history/route.ts` — comment corrected to describe the honest empty state.
- `src/lib/services/scrydex.service.ts` — header docstring corrected to reflect the live price_history endpoint.

Full diff: `git -C "d:\Pokemon\.worktrees\batch2a-charts" diff master...batch2a-charts`

</details>
