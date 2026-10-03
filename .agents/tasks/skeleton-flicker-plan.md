# Implementation Plan — Fix awkward skeleton flicker on fast page loads

Worktree: `d:\Pokemon\.worktrees\fix-skeleton-flicker` (run every command with this as cwd; the repo path contains a space — quote it in PowerShell).

## Context & root cause (what I verified by reading code)

The user reports: navigating to the Dashboard flashes full-page grey skeleton placeholders even though data loads in under a second — the skeleton appears and vanishes so fast it reads as a flicker.

Two skeleton layers exist on `(dashboard)`:

1. **Route-level `loading.tsx` (confirmed main offender).** `src/app/(dashboard)/dashboard/loading.tsx` is a Next.js streaming skeleton the router paints INSTANTLY on navigation while the server component awaits Prisma. It cannot "delay" itself in JS (the router owns its mount/unmount around the server await), so the only lever is CSS: start it invisible and reveal it only after a delay. The two siblings `search/loading.tsx` and `portfolio/loading.tsx` are the **identical pattern** (outer wrapper `<div>` + inner placeholder `<div>`s each with inline `animation: "dojo-pulse 1.5s ease-in-out infinite"`), so they get the same one-line treatment.

2. **In-component TanStack skeleton in `DashboardClient.tsx`.** The chart gate `chartLoading = historyLoading && collectionIdsQuery.length > 0` renders `<Skeleton/>`. It is already well-gated: `placeholderData: (prev) => prev` keeps the previous chart painted on range/selection switches, so `historyLoading` (isLoading) is true ONLY on the genuine first load. On that genuine first load it can still flash if the first history fetch is sub-250ms — so wrap the gate in the delay hook. The stat blocks are NOT skeletoned (SSR initialData), so they need no change.

### Design decisions (locked, with rationale)

- **Delay = 250ms.** Task-suggested default, inside the project's snappy-motion budget (120/150/200/250ms). Long enough to swallow the sub-second fast loads the user reported (nothing shows, no flicker); short enough that a genuinely slow fetch reveals the skeleton promptly. A single shared `DELAY_MS = 250` constant is used by both the hook default and the CSS keyframe delay so they stay in lockstep (comment the "why" at both sites).

- **Reduced-motion decision: reduced-motion users see the skeleton IMMEDIATELY (no delayed reveal), rendered as a stable, non-pulsing placeholder.** Reasoning grounded in the existing `globals.css`: the global `@media (prefers-reduced-motion: reduce)` block zeroes `animation-duration` AND `animation-delay`-bearing durations to `0.01ms !important` for every element, and the `.dojo-skeleton` comment already documents that **class-based** animations are covered by this block while **inline** `animation:` styles are NOT. If the delayed-appear is written as a CSS **class** applied to the `loading.tsx` wrapper, reduced-motion users have the 250ms delay collapsed to ~0ms by that existing block — the end-state (`opacity: 1`) applies immediately, so the skeleton is simply visible right away. That is the least-jarring outcome for them: no fade/pop-in surprise mid-load, just a steady placeholder. This is why the delayed-appear MUST be a CSS class (`.dojo-delayed-skeleton`) on the wrapper, never an inline `animation`. The inner pulse animations stay inline (as today) so they are unaffected either way — but for reduced-motion users the pulse strobe is already their concern, not ours (pre-existing, inline, out of scope). The `useDelayedFlag` hook has no reduced-motion branch: for the in-component case, a 250ms delay has no motion and is harmless under reduced-motion; keeping the hook pure keeps it trivially testable.

- **No new dependency, no schema/migration, no Scrydex/credit-gate touch.** Pure front-end. `scrydex-credit-gate.ts` stays default DENY; `SCRYDEX_LIVE_CREDITS_APPROVED` and the `scrydex:credit-approval` Redis flag are not touched.

### Verification sequence (run after all code items, from the worktree root)

1. `npx prisma generate`
2. `npm run lint`
3. `npm run type-check`
4. `npm run build` — NOTE: build may fail ONLY on `next/font/google` offline font fetch in `src/app/layout.tsx` (known pre-existing offline issue). Treat green `lint` + `type-check` + `test:unit` as passing; a build failure whose sole error is the offline Google-font fetch is acceptable and must be reported as such (do not "fix" it).
5. `npm run test:unit`

---

## Items

- [ ] 1. Add the delayed-appear CSS to `globals.css` (route-level fix enabler).
      Add a new `@keyframes dojo-skeleton-appear` (0% `opacity: 0` → 100% `opacity: 1`) and a `.dojo-delayed-skeleton` class that applies `opacity: 0` as its base and `animation: dojo-skeleton-appear 1ms linear 250ms forwards` (1ms visible-transition, 250ms delay, `forwards` holds opacity:1). Place it next to the existing `@keyframes dojo-pulse` / `.dojo-skeleton` block (~line 950–975) and add a load-bearing comment explaining: (a) WHY it must be a class not inline (so the existing `prefers-reduced-motion` block zeroes the 250ms delay → skeleton shows immediately for reduced-motion users), (b) the 250ms rationale, (c) square corners / no blur / token colors only. Do NOT modify the existing reduced-motion block — it already covers this class correctly.
      Files: `src/app/globals.css`
      Verify: part of the final sequence — `npm run lint` passes (CSS is not linted by eslint, but the file must stay syntactically valid so `npm run build`'s CSS step does not error on it); confirmed green in the full build/type-check run at the end.

- [ ] 2. Apply `.dojo-delayed-skeleton` to the three `(dashboard)` route-level loading skeletons.
      Add `className="dojo-delayed-skeleton"` to the single outermost wrapper `<div>` of each loading component (the one that already carries `aria-busy`/`aria-label`). This makes the whole skeleton start invisible and reveal only after 250ms of real server await; a sub-250ms fetch swaps to real content first (no flicker). Keep the existing inline inner `dojo-pulse` animations, the `aria-busy`/`aria-label`, token colors, and all comments intact; add a one-line comment on each wrapper noting the delayed-reveal (reference the globals.css class). All three are the same edit.
      Files: `src/app/(dashboard)/dashboard/loading.tsx`, `src/app/(dashboard)/portfolio/loading.tsx`, `src/app/(dashboard)/search/loading.tsx`
      Verify: `npm run type-check` passes (JSX/prop types valid). Runtime visual confirmation (flag for coder): throttle the server / network and confirm a fast dashboard nav shows NO grey skeleton flash, while an artificially slow load (e.g. add a temporary delay in the dashboard server component locally, then remove it) reveals the skeleton after ~250ms.

- [ ] 3. Create the `useDelayedFlag` hook.
      Create a client hook `useDelayedFlag(active: boolean, delayMs = 250): boolean` that returns `false` immediately whenever `active` is `false`, and returns `true` only after `active` has been continuously `true` for `delayMs`. Implementation: `"use client"`; `useState(false)` + `useEffect([active, delayMs])` that, when `active` is true, `setTimeout(() => setFlag(true), delayMs)` and clears the timer on cleanup/when `active` goes false (also `setFlag(false)` immediately when inactive). Export a shared `const DEFAULT_DELAY_MS = 250` and use it as the default param; comment the 250ms rationale and that it mirrors the CSS delay in globals.css.
      Files: `src/components/useDelayedFlag.ts`
      Verify: `npm run type-check` passes; covered by the unit test in item 5.

- [ ] 4. Gate the DashboardClient chart skeleton behind the delay hook.
      Import `useDelayedFlag` and compute `const showChartSkeleton = useDelayedFlag(chartLoading, 250);` right after the existing `const chartLoading = ...` line, then change the chart render gate from `chartLoading ? <Skeleton/> : ...` to `showChartSkeleton ? <Skeleton/> : ...`. Do NOT touch the `MultiLineComparisonChart` honest empty states ("No price history yet" / "No cards in this collection yet") — those remain the genuine no-data states (AGENTS.md #2: never a forever skeleton, never fabricate). Preserve the load-bearing comments on `placeholderData` and `chartLoading`; add a short comment that the delay suppresses the sub-250ms first-load flash while slow first loads still get the skeleton.
      Files: `src/app/(dashboard)/dashboard/_components/DashboardClient.tsx`
      Verify: `npm run type-check` passes; `npm run build` (chart still renders; subject to the known offline-font caveat above). Runtime (flag for coder): on a genuine first dashboard load with a selected collection, a sub-second history fetch shows no chart skeleton flash; the "No price history yet" empty state still appears for a collection with <2 real points.

- [ ] 5. Add the one unit test for `useDelayedFlag` (fake timers).
      Create a Vitest + `@testing-library/react` `renderHook` test using fake timers (`vi.useFakeTimers()` in `beforeEach`, `vi.useRealTimers()` in `afterEach`). Follow the existing `tests/unit/use-want-to-buy.test.tsx` style (globals on, `renderHook`, `act`). Cover: (a) returns `false` immediately when `active` becomes true; stays `false` after advancing < delay (e.g. `act(() => vi.advanceTimersByTime(249))`); (b) flips `true` after advancing to/past the delay (`act(() => vi.advanceTimersByTime(1))` to cross 250, or advance 250 from start); (c) when `active` goes back to `false`, the flag returns to `false` immediately (rerender with `active=false`, assert `false` without advancing timers). No frameworks beyond what the repo already uses; no fixtures.
      Files: `tests/unit/useDelayedFlag.test.tsx`
      Verify: `npm run test:unit` — the new test file passes (and the full unit suite stays green).

- [ ] 6. Run the full verification sequence and record results.
      Run, from the worktree root, in order: `npx prisma generate`, `npm run lint`, `npm run type-check`, `npm run build`, `npm run test:unit`. Expected: lint, type-check, and test:unit all green. `npm run build` is acceptable to fail ONLY if the sole error is the `next/font/google` offline font fetch in `src/app/layout.tsx` (pre-existing offline limitation) — report that explicitly; any OTHER build error is a real failure to fix.
      Files: none (verification only)
      Verify: lint + type-check + test:unit exit 0; build either succeeds or fails solely on the documented offline-font fetch.

---

## Notes / assumptions

- The three `loading.tsx` files are genuinely the same pattern, so item 2 batches them into one edit as the task permits ("IF trivially the same pattern"). This is not over-reach — it is the identical one-line className addition. If the coder finds any of the three wrappers has multiple top-level siblings (it does not today — each has a single outer `<div>`), apply the class to the outermost wrapper only.
- The in-component fix (items 3–4) is lower priority per the task (the chart gate is already well-gated), but applying the delay hook is cheap insurance against the sub-250ms first-load flash and keeps the two layers consistent.
- Reduced-motion behavior is handled entirely by the EXISTING global `prefers-reduced-motion` block — no new reduced-motion CSS is added; the class-vs-inline choice in item 1 is what routes reduced-motion users to the "show immediately" path. This is documented in the globals.css comment so it is not accidentally "fixed" later.
- Credit gate untouched; no Scrydex/external calls; no schema/dependency change — all edits are front-end files listed above.
