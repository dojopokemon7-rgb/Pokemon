# Implementation Plan — Revert eBay SOLD sales from AUTO-LOAD back to LOAD-ON-CLICK

Goal: reverse commit c71ff2b's auto-load of recent eBay SOLD sales. After this change, opening a
card detail page auto-loads ONLY history + population (unchanged). The Recent Sales section shows a
"Load recent sales" button; clicking it fires the existing `POST /api/cards/[id]/ebay-sold` (1 Scrydex
credit), then reads + displays stored rows via `GET /api/cards/[id]/ebay-sold`. Not clicking spends
nothing on sales.

All work is in the worktree `d:\Pokemon\Pokemon\.worktrees\fix-sales-on-click`. Do NOT touch
`prisma/schema.prisma` or `src/lib/auth.ts`. Pre-existing `src/lib/auth.ts` type errors (H-2) are not ours.

## Key findings from investigation (cite before editing)

- **`POST /api/cards/[id]/ebay-sold` already exists** and already top-gates on `isScrydexOnViewApproved()`
  (`SCRYDEX_ONVIEW_ENABLED`). BUT at `src/app/api/cards/[id]/ebay-sold/route.ts:174` it calls
  `pullAndStoreSoldListings(id)` WITHOUT `{ creditAuth: "onview" }`. Inside the writer that becomes
  `assertScrydexEnrichApproved("listings", 1, undefined)`, which authorizes ONLY under the BULK gate.
  So on staging/prod (only ONVIEW set) the route passes its top check but the writer throws
  `ScrydexCreditsNotApproved` → caught → `{ pulled:false }`, storing nothing. The button would never work.
  FIX: pass `{ creditAuth: "onview" }` to the writer. The writer already accepts
  `opts?: { creditAuth?: "onview" }` and `assertScrydexEnrichApproved` authorizes on the onview flag
  alone WITHOUT widening the bulk gate (see `src/lib/services/scrydex-credit-gate.ts`). This is the ONLY
  edit this route needs — do NOT widen the bulk gate; do NOT change the GET.
- **Old button UX is recoverable from `git show c71ff2b`**: the page used to hold a `salesRequested`
  boolean state; render was `salesRequested ? <RecentSales .../> : <button className="dojo-btn dojo-btn-outline">Load recent sales</button>`. The button `onClick` set `salesRequested=true`, fired
  `fetch(POST /api/cards/[id]/ebay-sold, {credentials:"include"})`, then in `.finally()` invalidated
  `["ebay-sold", id]`. The `.dojo-btn-outline` class exists in `src/app/globals.css`.
- **Enrich route** (`src/app/api/cards/[id]/enrich/route.ts`) currently has the SALES pull as the third
  pull (`pullAndStoreSoldListings(id, { creditAuth: "onview" })` → `salesStored`), surfaced as
  `sales:{stored}` in the 200 body. History + population (pulls 1–2) and the weekly-delta side-write
  (pull 4) stay as-is.
- **`RecentSales`** (`src/components/RecentSales.tsx`) currently auto-fetches the GET on mount via
  `useQuery` (no `enabled` guard). It must NOT auto-fetch; the GET fires only after the button click.
- **Tests present**: `tests/integration/enrich-route.test.ts` (asserts the sales pull — TASK 1a/1c/fail-open),
  `tests/integration/ebay-sold-post.test.ts` (POST gating), and the known-flake `tests/unit/add-invalidates-chart.test.tsx` (passes alone). There is NO `tests/unit/recent-sales.test.tsx` in THIS worktree yet.

---

- [ ] 1. Fix the ebay-sold POST writer gating so the button works under the on-view allowance.
      In `src/app/api/cards/[id]/ebay-sold/route.ts`, change the writer call (currently
      `const { stored } = await pullAndStoreSoldListings(id);`) to
      `const { stored } = await pullAndStoreSoldListings(id, { creditAuth: "onview" });`. Leave the
      top-level `isScrydexOnViewApproved()` short-circuit, the `requireAuth` guard, the rate-limit, the
      fail-open try/catch, and the entire GET handler untouched. Do NOT touch the bulk gate. Update the
      route's header doc-comment line that says it "runs the credit-gated single writer" to note the
      pull is authorized by the on-view allowance (`creditAuth:"onview"`), mirroring the enrich route.
      Files: `src/app/api/cards/[id]/ebay-sold/route.ts`
      Verify: `npm run test:integration -- ebay-sold-post` passes (and later the new assertion in step 6).

- [ ] 2. Remove the SALES pull from the on-view enrich route; keep history + population + weekly-delta.
      In `src/app/api/cards/[id]/enrich/route.ts`: (a) remove `pullAndStoreSoldListings` from the import
      block `import { pullAndStoreScrydexHistory, pullAndStorePopulation, pullAndStoreSoldListings, pullAndStoreScrydexWeeklyDelta } from "@/lib/services/scrydex-pricing.service";`; (b) delete the
      `let salesStored = 0;` declaration; (c) delete the entire "Third pull: recent eBay SOLD listings"
      block (the `{ try { const r = await pullAndStoreSoldListings(id, { creditAuth: "onview" }); salesStored = r.stored; } catch {} }` block and its comment); (d) remove the `sales: { stored: salesStored }`
      field from the final `NextResponse.json(...)` body so it returns
      `{ enriched: true, history: { stored: historyStored }, population: { stored: populationStored } }`.
      Keep history (pull 1), population (pull 2), the weekly-delta side-write (pull 4), the 24h freshness
      marker covering the whole attempt, the fail-open contracts, and the cache busting exactly as-is.
      Update the module doc-comment (top of file) and the marker comment that currently reads
      "all three pulls" / "history/population/listings" back to history + population (+ weekly-delta
      side-write) so the doc chain (RULE 14) is honest.
      Files: `src/app/api/cards/[id]/enrich/route.ts`
      Verify: `npm run type-check` passes (no unused-import / undefined-symbol error from the removed symbol);
      `npm run test:integration -- enrich-route` after step 5's test edits.

- [ ] 3. Revert `RecentSales` so its GET does NOT fire on mount (button-triggered only).
      In `src/components/RecentSales.tsx`, add an `enabled` gate to the `useQuery` so the pure-Postgres
      GET fetch only runs when the parent has requested sales. Simplest: accept a new optional prop
      `enabled?: boolean` (default `false` is WRONG for the isolated unit test — instead default it to
      `true` and let the PAGE control mounting, OR gate internally). Chosen approach: keep `RecentSales`
      a pure presentational+fetch component and let the PARENT control whether it is mounted at all (the
      old UX mounted it only after the click). So `RecentSales` itself needs NO change to its fetch —
      reverting the PAGE (step 4) to mount it only post-click restores on-click behavior, and the
      component's on-mount GET then only runs after the click. Therefore: make NO functional change to
      `RecentSales.tsx` except update its top doc-comment to state it is mounted by the page ONLY after
      the user clicks "Load recent sales" (no longer auto-displayed), so the comment is not stale.
      If review prefers an explicit internal guard instead of mount-gating, that is an acceptable
      equivalent — but mount-gating is the smaller diff and matches the pre-c71ff2b design exactly.
      Files: `src/components/RecentSales.tsx`
      Verify: `npm run test:unit -- recent-sales` passes after step 7 adds the test.

- [ ] 4. Revert the card-detail page to the button-gated Recent Sales UX (restore pre-c71ff2b wiring).
      In `src/app/(dashboard)/search/[id]/page.tsx`: (a) re-add the state
      `const [salesRequested, setSalesRequested] = useState(false);` near the other card-detail state
      (next to `rangeTouched` / `queryClient`); (b) replace the current always-rendered
      `<RecentSales id={id} setName={setName} rarity={rarity} />` and its "Auto-displayed" comment block
      with the conditional: when `salesRequested`, render `<RecentSales .../>`; otherwise render a
      `<button className="dojo-btn dojo-btn-outline" style={{ width:"100%", marginTop:"22px", height:"44px" }}>Load recent sales</button>` whose `onClick` sets `setSalesRequested(true)` then
      `fetch(\`/api/cards/${encodeURIComponent(id)}/ebay-sold\`, { method:"POST", credentials:"include" }).catch(()=>{}).finally(()=>{ queryClient.invalidateQueries({ queryKey:["ebay-sold", id] }); })`
      (restore the exact old block from `git show c71ff2b`, including its explanatory comment);
      (c) in the enrich `useQuery` queryFn, remove the line
      `queryClient.invalidateQueries({ queryKey: ["ebay-sold", id] });` and its 3-line comment, since
      enrich no longer stores sales — KEEP the `["card-history", id]` and `["population", id]`
      invalidations. Do NOT introduce any named export (PAGE-EXPORT GUARD: `page.tsx` exports ONLY the
      default) — this change adds no helpers, so no relocation to `src/lib` is needed.
      Files: `src/app/(dashboard)/search/[id]/page.tsx`
      Verify: `npm run type-check` passes; `npm run build` passes the Next Page-type phase (step 8).

- [ ] 5. Update the enrich-route integration test to assert NO sales pull.
      In `tests/integration/enrich-route.test.ts`: (a) remove `pullAndStoreSoldListings: vi.fn(),` from
      the `pricingMock` hoisted object and its comment; (b) remove the per-test default
      `pricingMock.pullAndStoreSoldListings.mockResolvedValue(...)` in `beforeEach`; (c) delete the three
      TASK-1 sales tests ("(TASK 1a) ... creditAuth:onview", "(TASK 1c) ... sales.stored:0",
      "(TASK 1 fail-open) ..."); (d) in the remaining stale/first-open tests, remove any
      `expect(body.sales)...` assertion and any `expect(pricingMock.pullAndStoreSoldListings)...`; (e) ADD
      one positive assertion to the "(c) stale > 24h" and/or "first-ever open" test that enrich does NOT
      import/call a sales pull — simplest honest check: assert `body.sales` is `undefined` and that the
      body shape is exactly `{ enriched, history, population }`. Keep the history/population/weekly-delta
      assertions and the fail-open + 401 + unknown-card + freshness tests unchanged (drop their
      `pullAndStoreSoldListings` references only).
      Files: `tests/integration/enrich-route.test.ts`
      Verify: `npm run test:integration -- enrich-route` — all enrich tests pass with no reference to a
      sales pull.

- [ ] 6. Extend the ebay-sold POST integration test to pin on-view authorization of the writer call.
      In `tests/integration/ebay-sold-post.test.ts`, add a test: with
      `process.env.SCRYDEX_ONVIEW_ENABLED = "true"`, a known card, `pullAndStoreSoldListings` mocked to
      resolve `{ stored: 2, credits: 1 }`, the POST returns 200 `{ pulled:true, stored:2 }` AND
      `expect(pricingMock.pullAndStoreSoldListings).toHaveBeenCalledWith("base1-4", { creditAuth: "onview" })`.
      This pins the step-1 gating fix (button works under the on-view allowance, bulk gate not required).
      Keep the existing "allowance OFF → {pulled:false}, no call", the 401, and the public-GET tests
      as-is (they still hold). Ensure the `afterEach` env cleanup already present covers the new flag.
      Files: `tests/integration/ebay-sold-post.test.ts`
      Verify: `npm run test:integration -- ebay-sold-post` — all pass including the new on-view assertion.

- [ ] 7. Add a `RecentSales` unit test asserting NO fetch on mount and a fetch after a button click.
      Because the on-click wiring lives in the PAGE (step 4), test it at the smallest honest seam: render
      a tiny harness that reproduces the page's `salesRequested` conditional — initially a "Load recent
      sales" button (no `<RecentSales>` mounted, so the stubbed `fetch` is NOT called); after a
      `fireEvent.click`, `<RecentSales>` mounts and the stubbed GET fetch fires and renders rows / the
      "No recent sales found" empty state. Follow the existing component-test pattern
      (`QueryClientProvider` wrapper + `vi.stubGlobal("fetch", ...)`, as in the main worktree's
      `recent-sales.test.tsx`). Assertions: (1) before click, `fetch` has 0 calls and the button text is
      present; (2) after click, `fetch` was called with the `ebay-sold` GET URL and a sold row (or the
      empty state) renders. Keep the render of a populated `{ listings:[...] }` row (date, formatted
      price, "PSA 10", View-sale link) to preserve the presentational coverage the main-worktree test had.
      Files: `tests/unit/recent-sales.test.tsx` (new)
      Verify: `npm run test:unit -- recent-sales` — new tests pass; no live Scrydex/network call.

- [ ] 8. Full verification gate.
      Run the project's real commands in order and confirm each passes. The known flake
      `tests/unit/add-invalidates-chart.test.tsx` passes when run alone — if it flakes in the full unit
      run, re-run it in isolation to confirm, do NOT "fix" it. `npm run build` is MANDATORY and must clear
      the Next Page-type phase (proving `page.tsx` has no named export — PAGE-EXPORT GUARD).
      Files: none (verification only)
      Verify, in order:
      - `npm run type-check` — passes except the pre-existing `src/lib/auth.ts` (H-2) errors, which are not ours and must be unchanged in count/identity.
      - `npm run lint` — passes (no unused imports from the removed sales symbol).
      - `npm run test:unit` — passes (recent-sales new tests green; add-invalidates-chart caveat above).
      - `npm run test:integration` — passes (enrich-route and ebay-sold-post updated; sold-listing.test.ts still green).
      - `npm run build` — completes, clearing the Next Page-type phase (no named `page.tsx` export).

## Net behavior after the change

Open card → `POST /enrich` auto-loads history + population (+ weekly-delta side-write) once per 24h
(unchanged). Recent Sales shows a "Load recent sales" button. Clicking it fires
`POST /api/cards/[id]/ebay-sold` (authorized by `SCRYDEX_ONVIEW_ENABLED`, ~1 credit), invalidates
`["ebay-sold", id]`, mounts `RecentSales` which reads stored rows via the pure-Postgres GET and renders
them — or the honest "No recent sales found" empty state when Scrydex has none (RULE 2). Not clicking
spends nothing on sales. No credit-spending POST ever fires on mount. Public routes stay 200/fail-open
(RULE 7); the bulk gate is never widened.
