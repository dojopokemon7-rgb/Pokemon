# Implementation Plan — Dojo Performance Optimization

> Ordered by dependency and impact. Each item names the file(s), the exact
> change, why it's safe (which AGENTS.md invariant it respects), and how to
> verify. All work in `.worktrees/perf-optimize`. Windows/PowerShell: quote the
> space in the path, use `;` not `&&`. Run commands with
> `cwd = d:\Work Code\Projects\pokemon TCG\app\Pokemon\.worktrees\perf-optimize`.
>
> The repo is TDD-pinned by F-numbers. The one behavior-touching change here
> (Want to Buy optimistic UI) does NOT require changing a test first: the F-07
> e2e (`e2e/want-list.spec.ts`) waits for the POST response before asserting and
> makes no claim about pre-response timing, so it stays green. If an implementer
> wants to *pin* the new optimistic behavior, add an assertion (noted in step 1),
> but it is not required to keep the gate green.

---

- [ ] 1. Add optimistic UI to `useWantToBuy` (fixes the user-reported "Want to Buy" lag AT THE HOOK).
      Rewrite both `add` and `remove` mutations to use the standard TanStack
      optimistic pattern so the star flips on tap instead of after a POST+refetch
      round-trip:
      - `onMutate(externalId|rowId)`: `await queryClient.cancelQueries({ queryKey: ["want-list"] })`;
        snapshot `queryClient.getQueryData(["want-list","BUY"])`; `setQueryData(["want-list","BUY"], …)`
        to insert (for `add`, a synthetic row `{ id: "optimistic-"+externalId, cardId: externalId, intent: "BUY" }`)
        or drop (for `remove`, filter out the matching row id). Return `{ previous }` as context.
      - `onError(_e,_v,ctx)`: restore `ctx.previous` via `setQueryData`.
      - keep `onSettled: () => queryClient.invalidateQueries({ queryKey: ["want-list"] })` (eventual consistency; required by ARCHITECTURE.md §7).
      `isWanted` / `toggle` surface stays identical — all three callers (search tiles ×2, detail page) get the fix for free.
      Why safe: no API/Zod/ownership/credit-gate change; only client cache timing. Mirrors the existing optimistic pattern in `CardDetailsPopup.tsx`.
      Files: `src/lib/hooks/useWantToBuy.ts`
      Verify: `npm run type-check` passes; `npm run test:e2e -- want-list` (or full `npm run test:e2e`) — F-07 add→move→remove lifecycle still green. Manual: in `npm run dev`, tap a search tile star → it fills instantly before the network settles; on a forced 500 it reverts.
      Optional pin: add to `e2e/want-list.spec.ts` an assertion that the star's pressed/aria-state flips BEFORE `waitForResponse` resolves (write test change first if pinning).

- [ ] 2. Add the composite index backing the collection `addedAt desc` ordering.
      Add `@@index([userId, addedAt])` to the `UserCollection` model (next to the
      existing `@@index([userId])` etc.), with a one-line load-bearing comment
      explaining it serves the dashboard/portfolio/collection reads that filter by
      `userId` and sort `addedAt desc` (same rationale as `Card.@@index([updatedAt])`).
      Why safe: additive index only — no query, API, or data-shape change; cannot
      alter results, only speeds the sort on the first-byte-critical dashboard SSR
      and the collection GET.
      Files: `prisma/schema.prisma`
      Verify: `npm run db:migrate` (dev) or `npm run db:push` against a reachable
      `DATABASE_URL`; then `npm run build` succeeds (prisma generate clean). Confirm
      `/dashboard` and `/api/users/me/collection` still return the same rows in the
      same order (ordering unchanged, just indexed).

- [ ] 3. Parallelize the independent `count` in the trending page-1 path.
      In the `sort === "trending" && offset === 0` branch, the `card.count({ where: gameFilter })`
      used only for `hasMore` runs strictly after the ranked+backfill fetches. Issue
      the `count` concurrently with the ranked query (e.g. kick off the count promise
      before awaiting, then `await` it when computing `hasMore`), using `Promise.all`
      so the cold-cache Explore load does 1 fewer serial round-trip.
      Keep offset pagination exactly as-is (AGENTS.md rule 12 — do NOT switch to keyset).
      Keep the `TRENDING_SELECT` projection and the 120 s Redis cache (fail-open) untouched.
      Why safe: pure await-reordering; identical result set, identical `nextCursor`
      math, identical cache behavior.
      Files: `src/app/api/cards/trending/route.ts`
      Verify: `npm run test:e2e -- show-more-duplicates` (F-04 pagination still correct, no dup cards across pages) and `npm run type-check`. Manual: Explore first load returns the same grid + working SHOW MORE.

- [ ] 4. (Optional, medium win) Collapse the card-detail graded double-request into one round-trip.
      Only do this if steps 1–3 are green and you want to halve the detail page's
      graded network. Extend `GET /api/cards/[id]/graded` to accept an optional
      `grades` CSV (e.g. `?grades=9,10`); when present, call `pullAndStoreScrydexPrice`
      ONCE and run `pickGradedPrice` per requested grade, returning `{ prices: { "9": …, "10": … } }`
      (keep the existing single-`grade` response shape for back-compat). Then collapse
      the two `useQuery`s in `search/[id]/page.tsx` into one `["graded", id, "9,10"]`.
      Why safe / credit-gate: the single pull is the SAME gated call the current
      first request already makes — this ELIMINATES the second request, it does NOT
      add a new live credit-consuming Scrydex call (AGENTS.md credit-gate rule).
      Route still returns 200 with null prices on unknown/unpriced (NFR-4 degradation).
      Files: `src/app/api/cards/[id]/graded/route.ts`, `src/app/(dashboard)/search/[id]/page.tsx`
      Verify: `npm run test:e2e -- card-detail-chart` + `graded-add-flow` stay green;
      `npm run test:integration` (graded golden prices) passes; `npm run type-check`.
      Manual: card detail still shows PSA 10 price + PSA 9 chip, now from one request.

- [ ] 5. Final gate.
      Run the full verification gate and clean up any temp build logs.
      Files: none (verification only).
      Verify: `npm run lint`; `npm run type-check`; `npm run test:unit`;
      `npm run test:integration`; `npm run test:chart-accuracy`; `npm run build`.
      (`npm run test:e2e` requires a reachable `DATABASE_URL` + standalone build on
      :3001 — run it if the DB is reachable; otherwise note it as the one gate
      segment that needs the live Supabase env.) All green = done.

---

## Explicitly OUT of scope (evidence says not worth it)

- Bundle splitting / lazy-loading routes — build table shows healthy sizes.
- Switching trending/search to keyset pagination — forbidden by AGENTS.md rule 12.
- Adding Redis to any path in a way that could make a cache miss fail a request.
- `pg_trgm` index on `card.name` — premature at current catalog size (YAGNI; revisit if the catalog grows into the thousands).
- Changing the `["want-list"]` family-wide invalidate — it is the correct eventual-consistency contract (ARCHITECTURE.md §7).
