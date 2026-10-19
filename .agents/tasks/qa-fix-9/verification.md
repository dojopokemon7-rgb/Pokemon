# QA #9 — Portfolio layout shift — verification note

Iteration: FIRST (no `review.json` present at start).

File changed: `src/app/(dashboard)/portfolio/page.tsx` (single page) +
`tests/unit/portfolio-remove.test.tsx` (added one no-shift assertion).

## What was wrong (confirmed by reading the render region)

- Page is a client component (`"use client"` at top) that Next.js App Router
  SSR-renders. `view` starts `"list"`; a post-mount `useEffect` flips it to
  `"grid"` on desktop (`matchMedia("(min-width: 640px)")`). On desktop the server
  (and the client's first render) paints the LIST, then the effect flips to GRID
  → a visible layout jump on load. (9a)
- The "N selected / Remove from collection" bulk bar was rendered conditionally
  (`selectMode && selectedIds.size > 0`) in normal flow BETWEEN the list-header
  toolbar and the Content block. Selecting the first card inserted it and SHOVED
  the whole list down (~48px + 12px margin); clearing selection pulled it back. (9b)

## The fix

### 9a — first-paint view jump (hydration-safe)
Chose option (ii). A lazy `useState(() => matchMedia(...))` initializer is NOT
safe here: because this is an SSR'd client component, the server renders `"list"`
(no `window`), so the client's FIRST render must also be `"list"` for hydration
parity — a lazy initializer that returned `"grid"` would cause a hydration
mismatch warning.

Instead: added a `viewResolved` state (default `false`), set to `true` inside the
existing post-mount effect (same effect that applies the desktop grid default).
The Content block now holds on the EXISTING loading skeleton while
`isLoading || !viewResolved`, so on the first client tick the list is never
painted-then-jumped to grid. No new flash is introduced (the skeleton already
renders during data load); the server and client first render are identical
(skeleton / list-state markup unchanged), so hydration is clean.

### 9b — selection bar no longer shoves the list
Chose option (i). The bulk bar is now ALWAYS mounted whenever `selectMode` is on
(reserving its exact vertical space + constant `marginBottom`). When nothing is
selected it is `visibility: hidden` (keeps identical layout height, removed from
a11y tree via `aria-hidden`, Remove button `tabIndex={-1}` so it isn't focusable)
rather than unmounted. Selecting the first card toggles visibility/contents only —
it never inserts/removes the container, so total height is stable for the whole
Select-mode session and the list never moves. `visibility: hidden` (vs a guessed
`minHeight`) guarantees the reserved height is byte-identical to the rendered bar.
Bulk-delete behavior, the mutation, the confirm dialog, and selection logic are
unchanged — layout only. Gold styling / square corners / tokens preserved.

## Tests
Added `tests/unit/portfolio-remove.test.tsx`:
"the bulk-action bar reserves its space in select mode so selecting never shifts
the list" — asserts the `data-testid="bulk-bar"` container is ABSENT before Select
mode, PRESENT (aria-hidden) as soon as Select mode is on with nothing selected,
and the SAME single container (count + working Remove button, no longer
aria-hidden) after selecting — i.e. selecting does not insert/remove the box.

## Commands run (from worktree root `d:\Pokemon\Pokemon\.worktrees\qa-fix-9`)

| Command | Result |
|---|---|
| `npm run type-check` | PASS (tsc --noEmit, exit 0) |
| `npm run lint` | PASS (eslint, exit 0) |
| `npm run test:unit` | PASS — 67 files, 503 tests passed |
| `npm run test:integration` | PASS — 60 files, 417 tests passed |

Known pre-existing flake `tests/unit/add-invalidates-chart.test.tsx` PASSED in the
full unit run (2065ms) — not a regression. Integration stderr lines are the
expected Redis fall-through / rate-limit fall-open logs (AGENTS.md rule 1).

Not run (per instructions — remote DB saturated): `build:standalone`, `test:e2e`,
`test:chart-accuracy`.

Nothing was pushed, merged, or deployed.
