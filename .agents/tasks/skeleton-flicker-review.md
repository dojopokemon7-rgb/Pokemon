# Delayed-skeleton flicker fix for dashboard/portfolio/search loads

The dashboard, portfolio, and search routes flashed a full-page grey skeleton on fast (<250ms) navigations, and the dashboard comparison chart flashed its block skeleton on a fast first-load history fetch — the "awkward blink" the user reported. The fix adds a `useDelayedFlag(active, delayMs)` hook that only reports `true` after `active` has stayed true continuously for the delay (and clears instantly otherwise), gates the in-component chart skeleton behind it, and delays the three route-level `loading.tsx` skeletons purely in CSS (`opacity:0` revealed ~250ms later). Front-end only: no dependency, no schema, no Scrydex/credit-gate, no e2e. One Vitest fake-timer test pins the hook's three transitions.

Watch for: (likely) the reduced-motion comment on `.dojo-delayed-skeleton` is factually wrong — the global reduced-motion block zeroes `animation-duration` but NOT `animation-delay`, so the 250ms delay is not collapsed; the documented WHY is incorrect even though behavior is harmless. (likely) on a genuine <250ms first load the chart area now briefly renders the "No price history yet" empty text before the real chart swaps in, since the skeleton is suppressed but data hasn't arrived yet.

**Verdict**: APPROVED

## High-level view

The hook is the correct shape: it stays false until `active` has been true for the whole delay and resets to false the instant `active` drops, with the pending timer cleared on every re-run so there's no setState-after-unmount leak. The chart gate wires it in without touching the honest "No price history yet" branch, which still fires on genuine no-data — not replaced by a looping skeleton.

Route-level `loading.tsx` can't delay its own mount (the Next.js router owns its lifecycle), so the delay is done in CSS via a class that starts at `opacity:0` and reveals after 250ms. Using a class rather than an inline animation is deliberate so the global reduced-motion media query can reach it. The 250ms value is shared between the CSS and `DEFAULT_DELAY_MS` with lockstep comments, and sits inside the project's documented motion budget.

Two caveats, both non-blocking. The reduced-motion justification in the CSS and `loading.tsx` comments is wrong: the media block only overrides `animation-duration` (to 0.01ms), not `animation-delay`, so reduced-motion users still wait the full 250ms before the placeholder snaps in — they do not "see a steady placeholder right away" as claimed. The end behavior is fine (delayed, non-fading appear), but the load-bearing comment misdescribes the mechanism, which matters in a codebase that treats comments as the record of WHY. Separately, suppressing the chart skeleton during the <250ms first-load window means the else-branch renders with empty series, so the "No price history yet" text can flash for a beat before real data draws — a different brief artifact than the skeleton it replaces.

<details>
<summary>Issues (2)</summary>

1. **Reduced-motion comment is inaccurate** — the comment on `.dojo-delayed-skeleton` (and the three `loading.tsx` copies) claims the reduced-motion block "collapses the 250ms delay"; it does not — that block overrides `animation-duration`/`-iteration-count`/`transition-duration` only, never `animation-delay`. Behavior is unaffected (delayed non-fading appear) but the WHY is false; fix the comment to match the actual mechanism.
2. **Possible "No price history yet" flash on fast first load** — gating the chart skeleton off during the <250ms first-load window lets the else-branch render with empty `seriesList`, briefly showing the empty-state text before data arrives. Only affects a genuine first load that resolves under the delay; weigh whether a brief empty-text swap is preferable to the skeleton it replaced.

</details>

<details>
<summary>Details</summary>

## The hook: delayed-true, immediate-false

`useDelayedFlag(active, delayMs)` holds a single boolean. When `active` is true it arms a `setTimeout(delayMs)` that flips the flag true; when `active` is false it calls `setFlag(false)` synchronously and arms no timer. The effect depends on `[active, delayMs]`, and its cleanup clears any pending timer before the next run, so flipping `active` false (or unmounting) cancels an in-flight timer — no setState-after-unmount. This satisfies the two hard requirements: true appears only after a continuous `delayMs` of truth, and false is immediate with no lingering true.

The test (`tests/unit/useDelayedFlag.test.tsx`, jsdom + fake timers) pins all three transitions the task asks for: still false at 249ms, true after crossing 250ms, and an immediate reset to false when `active` rerenders to false without advancing any timer. `renderHook` from `@testing-library/react` is already used by `use-want-to-buy.test.tsx`, so no new dependency enters the tree. The test comment correctly identifies which assertion catches a dropped timer vs. a dropped immediate-reset.

## Chart gate and the preserved empty state

```
chartLoading = historyLoading && collectionIdsQuery.length > 0   // true ONLY on genuine first load (placeholderData keeps data on switches)
showChartSkeleton = useDelayedFlag(chartLoading, 250)
render: showChartSkeleton ? <Skeleton/> : <MultiLineComparisonChart/>
```

Because `placeholderData: (prev) => prev` keeps `isLoading` false on every range/collection switch after the first, `chartLoading` is only true on the genuine first load — so the delay gate only ever affects that one window. A sub-250ms fetch resolves `chartLoading` to false before the timer fires, the skeleton never mounts, and the chart (or its honest empty state) draws. A slow fetch keeps `chartLoading` true past 250ms and the skeleton appears. The `MultiLineComparisonChart` "No price history yet" branch is untouched and still fires whenever `seriesList` has zero points, so genuine no-data is honest — not a forever/looping skeleton (AGENTS.md #2 preserved).

The edge worth naming: during the <250ms first-load window `showChartSkeleton` is false but data hasn't arrived, so the else-branch renders `MultiLineComparisonChart` with an empty `seriesList` → the "No price history yet" text paints for a beat and then swaps to the real chart once data lands. For loads under the delay this trades the old whole-duration grey skeleton for a brief empty-text flash. It's arguably still an improvement over the reported skeleton blink and is confined to the first-load fast path, so it's not blocking — but it is a behavioral change in that window, not a pure "show nothing."

## Route-level CSS delay and the reduced-motion comment

`loading.tsx` is painted instantly by the router while the server component awaits Prisma and cannot self-delay in JS, so the reveal is CSS: `.dojo-delayed-skeleton { opacity:0; animation: dojo-skeleton-appear 1ms linear 250ms forwards }`. A sub-250ms server fetch swaps to real content before the animation fires, so no grey flash; a slow fetch reveals the placeholder after the delay. Token colors (inherited by inner placeholders), square corners, no blur, consistent with the existing `dojo-pulse` look. The 250ms is shared with `DEFAULT_DELAY_MS` and both carry lockstep comments.

The one defect is in the justification, not the code. The comment states the delay is a CLASS (not inline) so the reduced-motion block "zeroes animation-duration AND -delay to 0.01ms !important ... which collapses the 250ms delay → reduced-motion users see a steady placeholder right away." The actual block (globals.css) overrides only:

```
animation-duration: 0.01ms !important;
animation-iteration-count: 1 !important;
transition-duration: 0.01ms !important;
scroll-behavior: auto !important;
```

There is no `animation-delay` override anywhere in globals.css (grep confirms zero matches). So under reduced-motion the element still waits the full 250ms, then snaps `opacity:0→1` in 0.01ms (no visible fade). The behavior is benign and arguably still desirable (fast loads still skip the skeleton; slow loads get a non-fading placeholder), but the stated reason — delay collapsed, placeholder immediate — is false. In a codebase where comments are load-bearing (AGENTS.md #14), the comment should describe what actually happens: the class is still worth keeping (so the fade duration is zeroed for reduced-motion, avoiding a mid-load fade/pop), but the delay is NOT collapsed.

</details>

<details>
<summary>File map</summary>

- `src/components/useDelayedFlag.ts` — new hook + `DEFAULT_DELAY_MS`; delayed-true / immediate-false with timer cleanup.
- `tests/unit/useDelayedFlag.test.tsx` — new Vitest fake-timer test: before-delay false, after-delay true, reset-on-false.
- `src/app/(dashboard)/dashboard/_components/DashboardClient.tsx` — gate chart skeleton behind `useDelayedFlag(chartLoading, 250)`; empty state untouched.
- `src/app/globals.css` — new `@keyframes dojo-skeleton-appear` + `.dojo-delayed-skeleton` class; reduced-motion comment inaccurate.
- `src/app/(dashboard)/dashboard/loading.tsx`, `portfolio/loading.tsx`, `search/loading.tsx` — add `.dojo-delayed-skeleton` class + comment.

Full diff: `git diff master` in the worktree.

</details>
