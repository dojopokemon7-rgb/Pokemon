# Verification — SSR dashboard chart flicker root-cause fix

## What changed (root cause → fix)

The dashboard page already SSR'd collection rows (stats + card lists paint
instantly), but the comparison chart depended on a SEPARATE client query
(`["portfolio-history", collectionIdsQuery, activeRange]`) with NO `initialData`.
That query only fetched after hydration; while it ran, `showChartSkeleton`
flipped and swapped in a grey `<Skeleton>`, then swapped to the real chart — the
reported flicker.

Fix: server-render the DEFAULT-range histories with the page and hand them to the
chart query as `initialData` when the live key matches the SSR key, so on first
paint `isLoading` is already false and the skeleton branch never runs.

- NEW `src/lib/services/collection-history.service.ts` — `buildCollectionHistories`,
  the route body extracted verbatim (range→startDate, ownership-scoped lots,
  honest null gaps, `buildCollectionSeries`). ONE source of truth for route + SSR.
- `src/app/api/users/me/collection/history/route.ts` — now a THIN caller:
  same param parsing, same `{ histories }` shape, same graceful empty-on-error 200.
- `src/app/(dashboard)/dashboard/page.tsx` — computes `defaultCollectionIds`
  (`["__uncat__", ...collections.map(c=>c.id)]`) + `DEFAULT_RANGE = "1M"`, builds
  histories (Prisma-only, zero credits), folds them into the existing per-user
  `dashboard:<userId>` cache (legacy entries without `histories` recompute), and
  passes `initialHistories` / `initialRange` / `initialCollectionIdsQuery`.
- `src/app/(dashboard)/dashboard/_components/DashboardClient.tsx` — new props +
  conditional `initialData` on the history query (only when
  `collectionIdsQuery === initialCollectionIdsQuery && activeRange === initialRange`).
  `placeholderData:(prev)=>prev`, the delayed skeleton, and the honest
  "No price history yet" empty state are all preserved.
- NEW `tests/unit/collection-history-service.test.ts` — (a) service shape parity
  with the route's fixture, (b) SSR-key parity with the client's first-render key.

Preserved: userId ownership scoping, honest null gaps (never fabricated 0), the
GET response shape, the credit gate (untouched — DENY default), offset pagination
elsewhere, design tokens, load-bearing comments. The `__uncat__`-vs-`null` route
behavior is reproduced identically on both paths (NOT "fixed" — out of scope).

## Commands run (worktree, LOCAL env
`DATABASE_URL=DIRECT_URL=postgresql://dojo:dojo@localhost:5433/dojo`,
`REDIS_URL=redis://localhost:6380`)

| Step | Command | Result |
|---|---|---|
| 1 | `npx prisma generate` | OK — Prisma Client v6.19.3 generated |
| 2 | `npm run lint` | PASS (exit 0) |
| 3 | `npm run type-check` | PASS — clean, exit 0 |
| 4 | `npm run build` | PASS (exit 0) — `/dashboard` route compiled; no font failure this run |
| 5 | `npm run test:unit` | PASS — 22 files, 145 tests (incl. 5 new) |
| 6 | `npm run test:integration` | PASS — 16 files, 116 tests (incl. the 8 history-null-safe route tests, unchanged) |

e2e NOT run per instructions.
