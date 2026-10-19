# QA #8 (Medium) — Collections loading skeleton (no layout shift)

## The bug
On the You/account page, the Collections section showed a short plain-text
`Loading collections…` line during the first load, then swapped it for the taller
real rows. The height difference caused content below to JUMP (CLS / layout shift)
when data arrived.

## The fix
`src/app/(dashboard)/you/_components/CollectionsSection.tsx` — the `isLoading`
branch now renders a skeleton placeholder instead of the text line. Only the
`isLoading` branch changed; the empty-state block and loaded-rows block are
untouched.

### Footprint match (row count + per-row height)
- **Row count: 2** placeholder rows — a typical short collection list, chosen to
  approximate the real list without overshooting (not 10).
- **Per-row height ≈ the real row (~56–57px):** each skeleton row reuses the real
  row's wrapper (`borderBottom: 1px solid var(--color-dojo-divider)`) and the same
  inner `padding: "13px 0"` (26px vertical). Inside: a `Skeleton height={14}`
  name line + 6px gap + `Skeleton height={9}` caption line ≈ 26 + 14 + 6 + 9 = 55px
  + 1px border ≈ 56px. The real row is 26px padding + ~16px name + 3px gap + ~10px
  caption ≈ 55px + 1px border. Swapping skeleton → real rows (or → empty state)
  shifts content below by a negligible amount, removing the jump.
- Composed from the existing shared `<Skeleton>` primitive (`@/components/Skeleton`,
  `.dojo-skeleton`, token-driven `--color-dojo-raised`, square corners, NeoPOP,
  reduced-motion-safe, decorative/`aria-hidden` by default). No new component.
- `.dojo-fade-in-fast` on the swap target matches the dashboard's skeleton→content
  reveal pattern (e.g. `search/[id]/page.tsx`, `DashboardClient.tsx`).

## Test approach
No component-test harness existed for `CollectionsSection` (searched `tests/` and
`e2e/`). Added a focused jsdom + Vitest + Testing Library test following the
existing `tests/unit/portfolio-remove.test.tsx` pattern (render the component in a
`QueryClientProvider` with a stubbed fetch):

- `tests/unit/collections-loading-skeleton.test.tsx` — with a never-resolving
  `/api/collections` fetch the query stays `isLoading`; asserts the
  `data-testid="collections-skeleton"` placeholder renders with ≥1 `.dojo-skeleton`
  element and that the old `Loading collections…` TEXT is gone.

## Commands run (from the worktree root) and results
| Command | Result |
|---|---|
| `npm run type-check` | PASS (exit 0) |
| `npm run lint` | PASS (exit 0) |
| `npm run test:unit` | PASS — 67 files, **502 passed / 502** |
| `npm run test:integration` | PASS — 60 files, **417 passed / 417** |

The known pre-existing flake (`tests/unit/add-invalidates-chart.test.tsx` 5s timeout
under full-suite load) did NOT occur this run — it passed as part of the 502.

Skipped per instructions (remote DB saturated): `build:standalone`, `test:e2e`.

## Constraints honored
- Single component file + one new test + this note. Reused the existing `Skeleton`
  primitive; no new component files, no new deps.
- Design tokens only, square corners (radius 0), NeoPOP (no blur/glow/shadow),
  inline-style + `.dojo-*` pattern (no Tailwind utilities).
- Zero Scrydex credits; no data-fetching / query / route / credit / sync changes.
- Load-bearing comments preserved; a WHY comment added for the skeleton.
