# Phase 1 front-end UI fixes — kill fabricated price, drop onboarding chrome, hide Want-to-buy, fill tile art, align both charts to the design-system AreaChart

Five purely front-end fixes landing on `phase1-ui-fixes` (base `978de3f`, `origin/master`): removing the hardcoded `246` price fallback (#6), deleting the Explore CONTINUE/Skip footer (#9), dropping the synthetic `__want_buy__` dashboard series (#7), making the trending tile art fill the tile width (#11), and bringing both hand-rolled charts in line with `AreaChart.jsx` under the NeoPOP no-blur rule (#13). The diff touches exactly three `.tsx` files plus the plan doc under `.agents/` — no schema, no migration, no new dependency, no external/Scrydex call. Each change is a deletion or a token/markup swap; nothing alters chart data, series math, offset pagination, or query wiring.

Watch for: nothing blocking. The one deliberate deviation from a literal reading of #13 — the dashboard chart has no x-axis date-label row — is the honest choice (the dashboard series carry `{value}` with no per-point label, so a label row would fabricate dates, violating rule 2); the detail chart, which has real dates, does get the row (confirmed). The implementer's recorded gate (prisma generate → lint → type-check → build → 101 unit tests) is present in the plan's verification note and the per-item evidence matches the diff.

**Verdict**: APPROVED

## High-level view

The fabricated `$246` fallback is gone: `price` is now typed `number | null` and every downstream consumer — the price header, the `ADD_ROWS` raw price, the PSA-10 multiplier base, `addTotal`, and the `AddQtyRow` prop — guards `null` and renders `—` instead of coercing to `0` or inventing a figure. No API or schema change; a genuinely priced card (tile passes `?price=`) still shows its price.

The dashboard no longer injects the virtual Want-to-buy entry into `collOptions`, which also removes the fabricated `paid = wantBuyTotal * 0.74` target. The injection block is deleted and `wantItems` is dropped from the memo's dependency array (it is still consumed by the separate `wantRows` memo, so the want-list query stays). The wantlist page and the `useWantToBuy` star read the `["want-list"]` family directly and are untouched.

The Explore CONTINUE button + Skip link footer `<div>` is removed from the `!hasQuery` branch; the SHOW MORE offset-pagination block directly above it is preserved intact with its load-bearing comment, and `fetchMoreTrending`/`hasMoreTrending` are not touched. Onboarding routes are not in the diff.

The trending tile art wrapper changes from `width:62%, alignSelf:center` to `width:100%` with no fixed pixel height; `CardImage.tsx` is unchanged and keeps the `660/921` aspect ratio, so height scales proportionally.

Both charts now match `AreaChart.jsx`: gradient stops `0.3 → 0` filling every series on the dashboard, a real vertical `linearGradient` area fill on the detail chart (replacing the flat polygon opacity), dashed strong-stroke hover guides (`strokeDasharray="3 3"`, `var(--color-dojo-stroke-strong)`) in both, SVG `<circle>` markers with a raised-surface ring and no CSS glow, and tooltips on `var(--color-dojo-raised)` with the blur/soft-shadow removed (the dashboard keeps a sanctioned hard-offset `5px 5px 0 0 #000`). The detail chart gains a sampled x-axis date-label row guarded on real points; the dashboard legend requirement is already met by its existing focus-chip row.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking findings. All five acceptance criteria are met and the AGENTS.md invariants hold.

</details>

<details>
<summary>Details</summary>

### #6 — the `246` literal is gone and null propagates honestly

The definition changed from `fetchedPrice ?? (priceParam > 0 ? priceParam : 246)` to `const price: number | null = fetchedPrice ?? (priceParam > 0 ? priceParam : null)`. The acceptance criterion is that no downstream consumer silently coerces that null into a fabricated number, and every path in the diff does guard it:

- The raw row keeps `rawPrice = price` (not `price || 0`), so a null raw price stays null rather than rendering a misleading `$0.00`.
- The PSA-10 heuristic uses `(rawPrice ?? 0) + 10` only to keep the multiplier finite, but the price itself is `gradedData?.price ?? (rawPrice != null ? rawPrice * psa10Multiplier : null)` — when raw is null and the graded route has no price, PSA-10 is null, not a number computed off a fabricated base. This is the correct reading of rule 2: the `?? 0` is confined to the divisor and never leaks into the displayed value.
- `addTotal` multiplies by `(d.price ?? 0)` so a null row contributes 0 to the total instead of `NaN`.
- The price header renders `price != null ? fmtUSD(price) : "—"` and dims to `--color-dojo-faint` when null — matching the list's "No price data" treatment.
- `AddQtyRow`'s prop widened to `number | null` and its render guards `null → "—"`; the call sites pass `price={d.price}` unchanged, which type-checks because the row price is now nullable.

No API or schema change, consistent with the criterion. The load-bearing PSA-multiplier heuristic comment is preserved and extended to explain the null case.

### #9 — footer removed, pagination preserved

The `{/* CONTINUE / Skip footer … */}` block and its `<div>` (CONTINUE button + Skip `<Link>`) are deleted from the `!hasQuery` branch. The SHOW MORE block immediately above (`!trendingLoading && !trendingError && hasMoreTrending && (…)`) is untouched — confirmed at L1340-1351 with its "real keyset pagination" comment intact. Both buttons only ever called `router.push("/dashboard")`/`href="/dashboard"`, so removing them does not affect `/api/users/me/onboarding` or the profile flow; onboarding routes are not in the diff. `router` and `Link` remain used elsewhere in the file (the implementer's lint pass confirms no unused-import).

### #7 — synthetic Want-to-buy injection removed

The entire `if (!hasNamedWant) { … opts.push({ id: "__want_buy__", … paid: Math.round(wantBuyTotal * 0.74) … }) }` block is deleted from `collOptions`, replaced with a comment explaining why. This removes both the dashboard selector/comparison-chart entry and the fabricated `paid = ×0.74` estimate (rule 2). `wantItems` is correctly dropped from the memo's dependency array since it is no longer referenced inside it; it is still used by the separate `wantRows` memo, so the `["want-list","all"]` query remains. The wantlist page and `useWantToBuy` star are not in the diff and read the want-list family independently.

### #11 — trending tile art fills the tile

`TrendCardTile`'s art wrapper changes from `width:"62%", alignSelf:"center"` to `width:"100%"`. No fixed pixel height is introduced, and `CardImage.tsx` is not in the diff — it retains `aspectRatio: "660 / 921"` and `width/height:100%`, so height scales proportionally with the now-full-width wrapper. The CardImage fallback-chain comment above the wrapper is preserved.

### #13 — both charts aligned to AreaChart.jsx, no blur anywhere

Checked against `d:\Pokemon\dojo-design\dojo-design-system\components\feedback\AreaChart.jsx` (the task's `.reference\…` path is absent in the worktree; the plan documents this substitution and the file content is identical to the spec quoted in the findings). The `AreaChart` reference uses gradient stops `0.3 → 0` (multi) / `0.35 → 0` (single), three solid grid lines, a dashed `stroke-strong` hover guide (`strokeDasharray="3 3"`), markers as `circle r=4 fill=color stroke=surface-card strokeWidth=2`, a tooltip on `surface-raised` with a `stroke-card` border and no shadow/blur, an x-axis label row, and (multi) a legend row.

Dashboard `MultiLineComparisonChart`:
- Gradient stops bumped `0.25/0.02 → 0.3/0`, and the area fill is now drawn per series (the `isSingle` gate is removed, and the dead `isSingle` const with it) — the lines are mapped after the areas so they sit on top.
- The hover guide is now `stroke="var(--color-dojo-stroke-strong)"` with `strokeDasharray="3 3"`.
- The absolutely-positioned `<span>` glow dots carrying `boxShadow: "0 0 0 2px …, 0 0 8px …"` are replaced with SVG `<circle>` markers (`r` 4/5 focused, `stroke="var(--color-dojo-raised)"`, `strokeWidth={2}`) — no CSS glow remains.
- The tooltip loses `backdropFilter: "blur(6px)"` and the soft `boxShadow: "0 6px 18px rgba(0,0,0,0.6)"`; background is now `var(--color-dojo-raised)` with the `--color-dojo-stroke` border, and elevation uses the sanctioned hard-offset `boxShadow: "5px 5px 0 0 #000"`. Square corners retained.

Detail `DojoChart`:
- The flat `<polygon fill={s.color} opacity={…}>` is replaced with a real vertical `linearGradient` (`<defs>` with per-series `dojoDetailGrad-${si}`, stops `0.3 → 0`) referenced as `fill="url(#dojoDetailGrad-${si})"`.
- The hover guide becomes `var(--color-dojo-stroke-strong)` + `strokeDasharray="3 3"`.
- Markers go to `r={4}`, `stroke="var(--color-dojo-raised)"`, `strokeWidth={2}`.
- The tooltip moves from `--color-dojo-overlay` to `--color-dojo-raised`, keeping the 1px stroke, no shadow, square corners.
- A sampled x-axis date-label row (`~5` evenly-spaced labels via `fmtChartDate`) is added, guarded on `points && points.length > 1` so the flat-baseline/mock case renders no row (no fabricated dates).
- PSA 9's raw hex `#0AC27E` is swapped to `var(--color-dojo-jade)`; Raw stays neutral grey (no matching token), PSA 10 was already `--color-dojo-gold`.

A workspace grep across all three edited files found no `backdropFilter`, no `blur(` in CSS context, no `0 0 8px` glow, no `0 6px 18px` soft shadow, no raw `rgba(255,255,255,0.25|0.3)` guide stroke, and no `rgba(18,18,18…)` tooltip background. The only `blur` hits are DOM `.blur()` input calls and prose in comments — unrelated. The dashboard x-axis label row is intentionally omitted because the dashboard series have no per-point date, which would require fabricating labels; its legend requirement is satisfied by the existing focus-chip row. This is the single documented deviation and it is the rule-2-correct one.

### Invariants and verification evidence

Scope matches the plan exactly: `git diff 978de3f --stat` shows only the three target `.tsx` files plus `phase1-plan.md`. No `prisma/schema.prisma`, no migration, no `package.json` change, no new import of an external/Scrydex client, and the credit gate (`scrydex-credit-gate.ts`) is not touched — it stays at default DENY. Rule 2 is strengthened in three places (removing `246`, the `×0.74` paid, and the `|| 0` price coercion). Rule 3 (id vs externalId) is unaffected — no identity code changed. Rule 10 holds: tokens throughout, square corners preserved, no `ArrowRight` copy introduced. Redis/Zod/ownership-scoping/offset-pagination paths are not in the diff. Load-bearing comments are preserved and in several cases extended.

Per the task's verification discipline, the recorded gate was read, not re-run: the plan's "Verification note (iteration 1)" records `npx prisma generate`, `npm run lint` (exit 0), `npm run type-check` (exit 0), `npm run build` (exit 0), and `npm run test:unit` (17 files / 101 tests passed, including `use-want-to-buy`, `card-price`, `scrydex-credit-gate`). The evidence is present and its per-item claims match the diff, so no suite was re-run. The one narrow spot-check performed — a single multi-file grep for `backdropFilter`/`blur`/`0 0 8px`/`246`/`__want_buy__`/soft-shadow/guide-stroke patterns — was justified by the need to confirm the #13 no-blur criterion across both chart files, and it came back clean.

</details>

<details>
<summary>File map</summary>

- `src/app/(dashboard)/search/[id]/page.tsx` — #6 null price propagation across header/ADD_ROWS/addTotal/AddQtyRow; #13 detail chart gradient fill, dashed guide, raised-ring markers, raised tooltip, sampled x-axis labels, PSA 9 token color.
- `src/app/(dashboard)/dashboard/_components/DashboardClient.tsx` — #7 remove `__want_buy__` injection + trim memo deps; #13 per-series gradient fill, dashed strong-stroke guide, SVG circle markers (glow removed), tooltip blur/soft-shadow removed, hard-offset shadow.
- `src/app/(dashboard)/search/page.tsx` — #9 delete CONTINUE/Skip footer (SHOW MORE preserved); #11 trending tile art wrapper 62% → 100%.
- `.agents/tasks/phase1-plan.md` — implementation plan + iteration-1 verification note (doc only).

Full diff: `git -C d:\Pokemon\.worktrees\phase1-ui-fixes diff 978de3f`

</details>
