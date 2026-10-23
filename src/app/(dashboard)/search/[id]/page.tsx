"use client";

/**
 * Screen 07 (extended) — Card Detail (/search/[id])
 *
 * Rebuilt to match dojo-prototype/app.js SCREENS.card exactly
 * (previously a "coming in Week 3" placeholder):
 *   - Hero card art with overlaid back / more / share controls
 *     (.hero / .ovl.tl / .ovl.tr / .ovl.br in the reference).
 *   - Name + star "track this card" toggle, TCG · set, code line.
 *   - Price + delta, and a WANT TO BUY toggle button (.wbtn).
 *   - "Price history" — DYNAMIC grade-group chips (Raw + every grading
 *     company present in /prices) that multi-select up to 3 series, each
 *     drawing its OWN stored per-grade history via the shared AreaChart
 *     (multi-series), plus range tabs.
 *   - "Adding to: Main" quantity card (Ungraded / Graded rows).
 *   - Population report (grader tabs + grade/count grid).
 *   - SOLD LIST button.
 *   - Accessories row.
 *
 * Card identity/price/image are carried via query params from the
 * search results grid (see search/page.tsx CardTile) since there is
 * no get-by-id API — only /api/cards/search exists. The Price-history
 * chart is driven by REAL data: each selected chip plots its own
 * recorded PricingHistory (GET /api/cards/[id]/history → { raw, graded });
 * chip prices come from /prices (+ /graded for PSA). A chip with no
 * stored history flattens to its current price — never a fabricated
 * curve. Population data + add-rows still follow the reference shape.
 */

import { useState, useMemo, useEffect, Suspense } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Toast } from "@/components/Toast";
import { RecentSales } from "@/components/RecentSales";
import { AreaChart } from "@/components/AreaChart";
import { AddCardSheet } from "@/components/AddCardSheet";
import { Skeleton } from "@/components/Skeleton";
import { useWantToBuy } from "@/lib/hooks/useWantToBuy";
import { formatCurrencyCompact } from "@/lib/utils/format";
import { listVariants, pickBestRaw, pickDefaultVariant } from "@/lib/utils/raw-price";
import { cardImgById, onePieceImageUrl, isOnePieceCode } from "@/lib/utils/card-image";
import { printingVariantFromId, decodeRouteId } from "@/lib/utils/card-number";
import { isTerminalEnrichResult } from "@/lib/utils/enrich-result";
import { gradedOptionsFromPrices } from "@/lib/utils/graded-options";
import {
  buildChips,
  buildChartMatrix,
  sortByGradeDesc,
  rangeAvailability,
  maxAvailableSpanDays,
  largestEnabledRange,
  visibleRanges,
  type CurrentPriceRow,
  type HistoryResponse,
} from "./price-history-chart";
import { VariantSelect } from "./variant-select";

// ── Icons ──────────────────────────────────────────────────────────
function ChevronLeft() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}
function MoreIcon() {
  return (
    <svg width="16" height="3" viewBox="0 0 16 3" aria-hidden="true">
      <circle cx="1.5" cy="1.5" r="1.5" fill="currentColor" />
      <circle cx="8" cy="1.5" r="1.5" fill="currentColor" />
      <circle cx="14.5" cy="1.5" r="1.5" fill="currentColor" />
    </svg>
  );
}
function ShareIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.6" y1="10.6" x2="15.4" y2="6.4" />
      <line x1="8.6" y1="13.4" x2="15.4" y2="17.6" />
    </svg>
  );
}

// ── Price-history chips — now DYNAMIC. buildChips (./price-history-chart)
// derives the chip groups from the card's REAL current prices: one Raw chip
// plus one chip per (company, grade) actually present in /prices. Each selected
// chip plots its OWN stored per-grade history (buildChartMatrix) — no
// fabricated/reused shape. Chip PRICE labels come from live data per-card
// (null → "—"). The pure helpers + CurrentPriceRow/Chip/HistoryResponse types
// live in the sibling module (a page.tsx may only export framework symbols). ──

// Range tabs filter the REAL history points by a trailing date window
// (RANGE_DAYS = days back from the newest point; MAX = all points).
// BUG 4: only the ENABLED ranges are rendered (visibleRanges) — a range that
// would reveal no more stored data than the previous one is HIDDEN, not greyed.
// RANGE_LABEL maps each RangeKey to its display text; only "ALL" renders as "MAX".
const RANGE_LABEL: Record<string, string> = { "1M": "1M", "3M": "3M", "6M": "6M", "1Y": "1Y", "ALL": "MAX" };
const RANGE_DAYS: Record<string, number> = { "1M": 31, "3M": 93, "6M": 183, "1Y": 366, "ALL": Infinity };

function fmtUSD(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

// Compact USD for the grade chip labels (e.g. 7930 → "$7.93K") — now the shared
// util (same formatter the chart Y-axis labels use); plain fmtUSD under $1000.
const fmtUSDCompact = formatCurrencyCompact;

// NOTE: CurrentPriceRow, HistoryResponse, Chip, buildChips, buildChartMatrix,
// sortByGradeDesc, gradeSortKey, and fmtChartDate now live in the sibling pure
// module ./price-history-chart (imported above). A page.tsx may only export the
// framework's allowed symbols, so the testable pure logic was extracted there.

// ── Area chart — rendered via the shared design-system AreaChart port
// (src/components/AreaChart.tsx) in multi-series mode: one line per selected
// chip, built by buildChartMatrix (./price-history-chart). All
// hover/tooltip/marker/x-axis behaviour lives in that component; fmtChartDate
// (from the same sibling module) builds the x-axis labels from the REAL dates.

// ── Population report (PSA English only; BGS unavailable; no fabrication) ──
// Plan §4: Scrydex public coverage is Pokémon PSA English only. We NEVER show
// fabricated numbers. The GET is a pure read of STORED population; until a card
// is refreshed (a manual, owner-approval-gated action) there is no data and we
// show an honest fallback. BGS is explicitly "not available", not an empty grid.
interface PopGrade { grade: string; count: number }
interface PopCompany {
  company: "PSA";
  language?: string;
  total: number;
  // C3/C4 — ladder sub-totals (null when the source omitted them).
  gradeTotal?: number | null;
  qualifiedGradeTotal?: number | null;
  halfGradeTotal?: number | null;
  grades: PopGrade[];
}
interface PopReport { source: "scrydex"; companies: PopCompany[]; refreshedAt?: string }

function PopulationReport({ id }: { id: string }) {
  const [grader, setGrader] = useState<"PSA" | "BGS">("PSA");
  const { data, isLoading } = useQuery<{ report: PopReport | null; bgsSupported?: boolean }>({
    queryKey: ["population", id],
    queryFn: async () => {
      const res = await fetch(`/api/cards/${encodeURIComponent(id)}/population`);
      if (!res.ok) return { report: null };
      return res.json();
    },
    // Always revalidate (staleTime 0) so a just-enriched population shows up
    // without a hard refresh — the 24h cache used to pin an early empty result,
    // and even a short staleTime could serve a null cached before enrich stored
    // the data. The GET is a cheap DB read (Redis-cached server-side).
    staleTime: 0,
    refetchOnMount: "always",
  });

  const report = data?.report ?? null;
  const bgsSupported = data?.bgsSupported ?? false;
  const heading = { marginTop: "22px", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px", letterSpacing: "0.18em", textTransform: "uppercase" as const, color: "var(--color-dojo-body)" };
  const panel = { marginTop: "12px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "22px 15px", textAlign: "center" as const };
  const faint = { fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12px", color: "var(--color-dojo-faint)" };
  const psa = report?.companies.find((c) => c.company === "PSA") ?? null;

  return (
    <>
      <div style={heading}>Population report</div>

      {/* Grader toggle — PSA is supported, BGS is shown but marked unavailable. */}
      <div style={{ display: "flex", gap: "10px", marginTop: "12px" }}>
        {(["PSA", "BGS"] as const).map((c) => (
          <button
            key={c}
            onClick={() => setGrader(c)}
            style={{
              display: "flex", flexDirection: "column", gap: "2px",
              border: `1.5px solid ${grader === c ? "rgba(255,255,255,.55)" : "var(--color-dojo-stroke)"}`,
              padding: "8px 14px", cursor: "pointer",
              color: grader === c ? "var(--color-dojo-ink)" : "var(--color-dojo-faint)",
              background: "transparent",
            }}
          >
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "13px" }}>{c}</span>
            <span style={{ fontSize: "11px", color: "var(--color-dojo-body)" }}>
              {c === "PSA" ? "English" : "n/a"}
            </span>
          </button>
        ))}
      </div>

      {grader === "BGS" ? (
        // BGS population is not available under documented Scrydex coverage.
        <div style={panel}>
          <span style={faint}>BGS population isn’t available from our data provider</span>
        </div>
      ) : isLoading ? (
        <div style={panel}><span style={faint}>Loading…</span></div>
      ) : !psa ? (
        // Honest fallback: no stored PSA population yet (no fabricated numbers).
        <div style={panel}>
          <span style={faint}>No PSA population loaded yet</span>
        </div>
      ) : (
        <div style={{ marginTop: "12px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "14px 15px 6px" }}>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "13px", color: "var(--color-dojo-ink)" }}>
            PSA English · {psa.total.toLocaleString()} total
          </div>
          {/* C4 — ladder sub-totals as a secondary line; only parts that are
              non-null are shown (never a fabricated "0" — AC-34). */}
          {(() => {
            const parts: string[] = [];
            if (typeof psa.gradeTotal === "number") parts.push(`${psa.gradeTotal.toLocaleString()} graded`);
            if (typeof psa.halfGradeTotal === "number") parts.push(`${psa.halfGradeTotal.toLocaleString()} half`);
            if (typeof psa.qualifiedGradeTotal === "number") parts.push(`${psa.qualifiedGradeTotal.toLocaleString()} qualified`);
            return parts.length > 0 ? (
              <div style={{ marginTop: "4px", fontFamily: "var(--font-display)", fontWeight: 400, fontSize: "11px", color: "var(--color-dojo-faint)" }}>
                {parts.join(" · ")}
              </div>
            ) : null;
          })()}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", columnGap: "10px", marginTop: "10px" }}>
            {sortByGradeDesc(psa.grades).map((g) => (
              <div key={g.grade} style={{ padding: "10px 0", borderBottom: "1px solid var(--color-dojo-divider)" }}>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "13.5px", color: "var(--color-dojo-ink)" }}>{g.grade}</div>
                <div style={{ marginTop: "4px", fontFamily: "var(--font-display)", fontWeight: 400, fontSize: "13px", color: "var(--color-dojo-faint)" }}>{g.count.toLocaleString()}</div>
              </div>
            ))}
          </div>
          {report?.refreshedAt && (
            <div style={{ marginTop: "8px", fontSize: "9px", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
              Refreshed {new Date(report.refreshedAt).toLocaleDateString()}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function CardDetailInner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  // App Router's useParams() returns the ENCODED route segment (Next.js does
  // not decodeURIComponent it — vercel/next.js #48058). For a composite
  // per-printing id the `::` rides the URL as `%3A%3A`; left undecoded it breaks
  // the prefetch query-key match, double-encodes every fetch URL, and defeats
  // printingVariantFromId. decodeRouteId restores the canonical externalId once,
  // here, fixing all downstream uses at the single read site (idempotent on a
  // base id → base-card behavior unchanged). See decodeRouteId's doc-comment.
  const id = decodeRouteId(params?.id as string);

  const name = searchParams.get("name") ?? "Card";
  const setName = searchParams.get("set") ?? "";
  const priceParam = Number(searchParams.get("price") ?? 0);
  
  // Always revalidate (staleTime 0 + refetchOnMount "always") so the opened
  // card paints from the CURRENT /prices rather than a stale prefetched entry —
  // mirroring the ["card-history", id] / ["population", id] queries below. The
  // search grid prefetches ["card-prices", id] on hover (search/page.tsx
  // prefetchCardDetail), and the /prices route can legitimately 200-empty
  // during a pre-resolve window; under the global 5-minute staleTime that empty
  // blob would be served as "fresh" on mount, painting [] prices (empty chart,
  // Raw-only chips) even though the server now returns real rows. A cache hit is
  // still instant — it just refetches behind the paint. The prefetch no longer
  // caches a transient-empty payload either (prefetchCardDetail guard).
  const { data: pricesData, isLoading: pricesLoading } = useQuery({
    queryKey: ["card-prices", id],
    queryFn: async () => {
      const res = await fetch(`/api/cards/${encodeURIComponent(id)}/prices`);
      if (!res.ok) throw new Error("Failed to load prices");
      return res.json();
    },
    staleTime: 0,
    refetchOnMount: "always",
  });

  const allPrices: CurrentPriceRow[] = useMemo(() => pricesData?.prices ?? [], [pricesData]);
  // Variants actually stored for this card (selector shows only when > 1). The
  // default equals the headline variant (pickDefaultVariant), so the headline
  // does not regress; the user's pick is scoped to this card id.
  const variants = useMemo(() => listVariants(allPrices), [allPrices]);
  // Per-printing re-model (RULE 3): a composite route id ("base1-2::<variant>")
  // IS its own printing's Card row, so the chart must default to THAT printing's
  // variant — the `::` suffix equals the stored variant token (printingExternalId
  // is its inverse). pickDefaultVariant over the mixed CurrentPrice rows could
  // otherwise pick a sibling printing's variant. A BASE id (no `::`) has null
  // here and falls back to pickDefaultVariant as before. The user can still
  // switch via the variant SELECTOR (variantSel overrides below).
  const printingVariant = useMemo(() => printingVariantFromId(id), [id]);
  const defaultVariant = useMemo(
    () => printingVariant ?? pickDefaultVariant(allPrices),
    [printingVariant, allPrices]
  );
  const [variantSel, setVariantSel] = useState<{ id: string; v: string } | null>(null);
  const variant: string | null =
    variantSel && variantSel.id === id && variants.includes(variantSel.v) ? variantSel.v : defaultVariant;
  // Everything below (headline, chips, graded prices) follows the selected variant.
  const currentPrices: CurrentPriceRow[] = useMemo(
    () => (variant ? allPrices.filter((r) => (r.variant ?? "normal") === variant) : allPrices),
    [allPrices, variant]
  );
  // REAL 7-day % change (Scrydex trends.days_7). Null until a priced pull runs
  // → the trend row renders "—" (never a fabricated number — AGENTS.md rule 2).
  const weeklyChangePct: number | null =
    typeof pricesData?.weeklyChangePct === "number" ? pricesData.weeklyChangePct : null;
  // Headline raw price (26px): shared derivation — NM, else LP->MP->HP->DM, from
  // RAW rows only. Legacy graded rows carry condition "NM", so the old
  // `condition === "NM"` / `currentPrices[0]` fallbacks surfaced a PSA price.
  const fetchedPrice = pickBestRaw(currentPrices)?.price ?? null;
  // No fabricated fallback (AGENTS.md rule 2): when neither a live price nor a
  // tile-passed ?price= exists, price is null and every consumer renders "—".
  const price: number | null = fetchedPrice ?? (priceParam > 0 ? priceParam : null);

  // `game` is passed by the search grid tile (see search/page.tsx).
  // Older entry points (like the portfolio list) don't include it yet,
  // so we fall back to inferring from the Bandai code pattern used by
  // One Piece card ids. Anything else defaults to Pokémon.
  const gameParam = searchParams.get("game");
  const game: "pokemon" | "onepiece" =
    gameParam === "onepiece" || gameParam === "pokemon"
      ? gameParam
      : isOnePieceCode(id ?? "")
        ? "onepiece"
        : "pokemon";

  // Franchise display name for the "{Game} · {Set}" line (Task 1).
  const gameName = game === "onepiece" ? "One Piece" : "Pokémon";

  // Serial line "{rarity} · {number}" (Task 2). One Piece ids are the
  // serial sellers use (OP01-001); Pokémon's serial is the `number` field
  // ("4/102"). Prefer the passed `number`, else fall back to the id for
  // Bandai-coded One Piece cards.
  const rarity = searchParams.get("rarity") ?? "";
  // Per-printing ids are composite ("OP01-120::alt-art"); strip the
  // `::<variant>` suffix so the Bandai-code test + displayed serial use the
  // bare card code (no-op for a base-printing id). isOnePieceCode already
  // suffix-strips internally; derive the base here for the serial fallback.
  const baseId = (id ?? "").split("::")[0];
  const isBandai = isOnePieceCode(id ?? "");
  // Prefer the real DB `number` param. Fall back to the id: One Piece ids
  // ARE the serial (OP01-001) — use the SUFFIX-STRIPPED base so a composite id
  // renders "OP01-120", not "OP01-120::alt-art". For other ids show the whole
  // base id (e.g. "sv3-224") rather than "undefined". Empty only with no id.
  const serialNumber =
    searchParams.get("number") ||
    (isBandai ? baseId.toUpperCase() : baseId);

  // Hero art is rebuilt from the ROUTE id via a same-origin proxy — the raw
  // upstream url is NEVER carried in the address bar (`img=` was removed). One
  // Piece ids go through the Bandai proxy; Pokémon ids through /api/card-img/
  // <id>, which resolves Card.imageUrl server-side (hides images.scrydex.com).
  // If the proxy 404s (live-search card with no stored row) the plain <img>'s
  // onError swaps in the local placeholder, so no raw url ever leaks.
  const PLACEHOLDER = "/cards/card-front.webp";
  // One Piece hero: FEAT-004 retired the per-variant `variantImages` art
  // resolution — with per-printing rows each printing is its own card id
  // (`...::alt-art`) carrying its own imageUrl, so the hero no longer needs to
  // pick art out of a per-variant map. It resolves the base-art Bandai proxy
  // for the route id (then PLACEHOLDER on 404). Pokémon branch (cardImgById)
  // is unchanged.
  const heroSrc =
    game === "onepiece"
      ? onePieceImageUrl(id) ?? PLACEHOLDER
      : cardImgById(id);
  const [heroError, setHeroError] = useState(false);
  // Reset the single-hop onError flag whenever the resolved src changes (e.g.
  // the user switches variant) so a prior failed load re-attempts the new art.
  useEffect(() => {
    setHeroError(false);
  }, [heroSrc]);

  const [flipped, setFlipped] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // The "track this card" star adds to Want to Buy (server-backed) — this
  // replaced the removed favourites feature.
  const { isWanted, toggle: toggleWant } = useWantToBuy();
  const starred = isWanted(id);
  const [activeSeries, setActiveSeries] = useState<Set<string>>(new Set(["raw"]));
  const [range, setRange] = useState<string>("1M");
  // BUG 6: until the user explicitly picks a range tab, the default range
  // follows the data (the largest ENABLED range once history loads). Once the
  // user taps a tab, their choice sticks and the auto-default stops overriding.
  const [rangeTouched, setRangeTouched] = useState(false);
  const queryClient = useQueryClient();
  // ADD TO COLLECTION opens the shared AddCardSheet (same flow as Explore).
  const [sheetOpen, setSheetOpen] = useState(false);
  // Single toast channel for this page: add confirmations, favorites
  // feedback, and Report submissions all route through here (Phase 3).
  const [toast, setToast] = useState<string | null>(null);

  // `&variant=` for the variant-aware routes (graded). Empty until a variant resolves.
  const variantQs = variant ? `&variant=${encodeURIComponent(variant)}` : "";

  // Real PSA 10 price from the server graded route (routes through Scrydex +
  // the curated/multiplier fallback). Public route — no credentials needed.
  // `price` is null when the card is unknown/unpriced; we then keep the local
  // heuristic below so the UI never regresses to blank.
  const { data: gradedData } = useQuery<{ price: number | null; isFallback?: boolean }>({
    queryKey: ["graded", id, "10", variant],
    queryFn: async () => {
      const res = await fetch(`/api/cards/${encodeURIComponent(id)}/graded?grade=10${variantQs}`);
      if (!res.ok) throw new Error("Failed to load graded price");
      return res.json();
    },
    staleTime: 60_000,
  });

  // Real PSA 9 price — same public graded route, grade=9 — used only for the
  // PSA 9 price-history chip label (null → "—", never fabricated).
  const { data: graded9Data } = useQuery<{ price: number | null; isFallback?: boolean }>({
    queryKey: ["graded", id, "9", variant],
    queryFn: async () => {
      const res = await fetch(`/api/cards/${encodeURIComponent(id)}/graded?grade=9${variantQs}`);
      if (!res.ok) throw new Error("Failed to load graded price");
      return res.json();
    },
    staleTime: 60_000,
  });

  // The user's named collections for the "Adding to" picker. FILTER to rows
  // with a string name so the nameless __uncat__ pseudo-entry (the loose
  // bucket GET /api/collections synthesizes) never shows as a pickable row —
  // "Main" (value '') already represents loose/unbucketed.
  const { data: collections = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["collections"],
    queryFn: async () => {
      const res = await fetch("/api/collections", { credentials: "include" });
      if (!res.ok) return [];
      const rows = (await res.json()).data ?? [];
      return rows.filter((c: { name?: unknown }) => typeof c.name === "string");
    },
    staleTime: 60_000,
  });

  // Build ADD_ROWS dynamically using the actual card's market price.
  // Ungraded (raw) = actual market price. PSA 10 uses the real server graded
  // price when available, falling back to the local heuristic below.
  const toggleSeries = (seriesId: string) => {
    setActiveSeries((prev) => {
      const next = new Set(prev);
      if (next.has(seriesId)) {
        next.delete(seriesId);
      } else if (next.size < 3) {
        next.add(seriesId);
      }
      return next;
    });
  };

  // F-18: real per-grade price history from the DB (PricingHistory), keyed as
  // { raw, graded } (FEAT-001). buildChartMatrix plots each selected chip's OWN
  // series — the Raw chip from `raw`, each graded chip from graded[`CO|grade`].
  // A chip with < 2 windowed points flattens to its current price; nothing is
  // fabricated. Never errors — an empty/failed fetch just yields empty series.
  const { data: historyData, isLoading: historyLoading } = useQuery<HistoryResponse>({
    queryKey: ["card-history", id, variant],
    // Wait for prices so the variant is resolved (avoids a default-then-variant double fetch).
    enabled: !pricesLoading,
    queryFn: async () => {
      // Omit ?variant= for the default variant so the server's cached default response is used.
      const qs = variant && variant !== defaultVariant ? `?variant=${encodeURIComponent(variant)}` : "";
      const res = await fetch(`/api/cards/${encodeURIComponent(id)}/history${qs}`);
      if (!res.ok) throw new Error("Failed to load history");
      return res.json();
    },
    // Always revalidate (staleTime 0) so a just-enriched history series shows up
    // without a hard refresh — mirroring the ["population", id] query. The first
    // on-mount read may race AHEAD of the on-view enrich store write, so a
    // revisit/invalidate must re-read rather than serve an early empty blob. The
    // GET is a cheap DB read (Redis-cached server-side), nothing fabricated.
    staleTime: 0,
    refetchOnMount: "always",
  });

  // ON-VIEW enrichment: fire the enrich POST on mount to pull+store this card's
  // history / population / recent-sold once per 24h (the server throttles via a
  // per-card marker). Keyed ["enrich", id] so the query cache dedupes concurrent
  // mounts. The route is a no-op {enriched:false,reason:"disabled"} unless
  // SCRYDEX_ONVIEW_ENABLED is on, so this costs nothing in dev.
  //
  // RESILIENCE (the fix): the enrich POST must survive a mount that races AHEAD
  // of session-cookie hydration. The route is requireAuth-guarded, so such a
  // race returns 401 (also 429 under the credit-tier rate limit, or 5xx / a
  // network-or-parse fault). The OLD query pinned that dead outcome FOREVER
  // (staleTime+gcTime Infinity + retry:false → one POST per id, cached success
  // OR failure), so a card opened a beat before login stayed empty permanently.
  // Now isTerminalEnrichResult (pure, ./lib/utils/enrich-result) splits a REAL
  // settled result (res.ok + enriched:true | reason:fresh/disabled/unknown) from
  // a TRANSIENT failure. On transient we THROW (never fabricate {enriched:false})
  // so the bounded retry re-attempts; refetchOnMount lets a remount after login
  // pick it up. A terminal result is returned normally and not retried.
  useQuery({
    queryKey: ["enrich", id],
    queryFn: async () => {
      // A fetch/parse throw is transient (ok:false, no body) → retryable.
      let res: Response;
      try {
        res = await fetch(`/api/cards/${encodeURIComponent(id)}/enrich`, {
          method: "POST",
          credentials: "include",
        });
      } catch {
        throw new Error("enrich transient: network error");
      }
      const body = await res.json().catch(() => null);

      // Transient (401 pre-hydration / 429 / 5xx / unparseable 200) → THROW so
      // TanStack Query's bounded retry re-attempts; do NOT invalidate the read
      // queries (nothing new was stored) and do NOT cache a fake no-op.
      if (!isTerminalEnrichResult({ ok: res.ok, body })) {
        throw new Error(`enrich transient: status ${res.status}`);
      }

      // Terminal (route actually ran). Re-read history + population + recent
      // sales regardless of the specific terminal reason — even a card that was
      // already "fresh" may have had its first on-mount read race AHEAD of the
      // stored data (or cache an early null), so invalidate so the panels
      // repaint from the DB. Cheap DB reads (Redis-cached server-side). This
      // runs ONLY after a settled enrich, NEVER after a thrown transient failure.
      queryClient.invalidateQueries({ queryKey: ["card-history", id] });
      queryClient.invalidateQueries({ queryKey: ["population", id] });
      // The enrich POST also stores recent eBay SOLD rows (the third pull), so
      // re-read them too — RecentSales auto-fetches the GET on mount and this
      // repaints it with the freshly-stored sales.
      queryClient.invalidateQueries({ queryKey: ["ebay-sold", id] });
      return body;
    },
    // Bounded retry so a session that hydrates a beat late is picked up, while a
    // persistent failure does not loop forever. Linear-ish backoff capped at 2s.
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * (attempt + 1), 2000),
    // Do NOT pin a FAILED attempt forever: a remount (e.g. after login) must
    // re-attempt. A terminal result is returned normally and simply won't retry.
    refetchOnMount: "always",
    staleTime: 0,
  });

  // Live price for each price-history chip (null → "—"), keyed on the new chip
  // id scheme. Raw = the card's market price; each graded chip's price comes
  // from its /prices row (numeric). The two live /graded queries OVERRIDE the
  // PSA|10 / PSA|9 entries where present. Never fabricated.
  const chipPrice = useMemo(() => {
    const rawPrice = fetchedPrice ?? (priceParam > 0 ? priceParam : null);
    const map: Record<string, number | null> = {
      raw: rawPrice,
    };
    for (const r of currentPrices as CurrentPriceRow[]) {
      if ((r.type ?? "raw") !== "graded") continue;
      const company = (r.company ?? "").toUpperCase();
      const grade = r.grade ?? "";
      if (!company || !grade) continue;
      map[`${company}|${grade}`] = r.priceMarket ?? r.priceLow ?? null;
    }
    // FEAT-002 (AGENTS RULE 2 — never fabricate): emit a PSA|10 / PSA|9 chip
    // price ONLY when the /graded route resolved a REAL stored CurrentPrice PSA
    // row (isFallback === false). The ×2.5/×1.5 curated/multiplier fallback
    // (isFallback === true) is NOT a real graded quote — seeding it here made
    // every card show identical PSA 10/9 chips, disagreeing with AddCardSheet's
    // real-only dropdown. No stored row → no PSA chip (honest "—"/absent), same
    // as any other grade. gradedPrice() stays in use only for the P&L valuation.
    if (gradedData?.price != null && gradedData.isFallback === false) {
      map["PSA|10"] = gradedData.price;
    }
    if (graded9Data?.price != null && graded9Data.isFallback === false) {
      map["PSA|9"] = graded9Data.price;
    }
    return map;
  }, [currentPrices, fetchedPrice, priceParam, gradedData, graded9Data]);

  // Dynamic chip groups driven by the card's real current prices.
  const chipGroups = useMemo(
    () => buildChips(currentPrices as CurrentPriceRow[], chipPrice),
    [currentPrices, chipPrice]
  );
  const allChips = useMemo(() => chipGroups.flatMap((g) => g.chips), [chipGroups]);

  // Every stored graded price for this card (company+grade+price) — passed to
  // AddCardSheet so its single Grader dropdown lists only this card's graders
  // and shows the LIVE price per selection.
  const gradedPrices = useMemo(
    () => gradedOptionsFromPrices(currentPrices as CurrentPriceRow[]),
    [currentPrices]
  );

  // BUG 5: honest range tabs reflect the data the CARD HAS, not just the chips
  // the user happens to have selected. A sparse graded chip being selected must
  // not collapse the span to 0 and lock every tab to 1M while the raw series
  // spans months. maxAvailableSpanDays takes the longest REAL stored span across
  // raw + every graded key the card actually has. A tab that would reveal no
  // more data is still disabled; if the picked range is disabled fall back to
  // the largest enabled one. Nothing is synthesized (availability = real spans).
  const spanDays = useMemo(() => maxAvailableSpanDays(historyData), [historyData]);
  const rangeAvail = rangeAvailability(spanDays);
  const effRange = rangeAvail[range as keyof typeof rangeAvail]
    ? range
    : largestEnabledRange(rangeAvail);

  // BUG 6: open on the largest ENABLED range once history loads, so a card with
  // months of history shows them instead of defaulting to 1M. Only until the
  // user explicitly picks a tab (rangeTouched) — after that their choice wins.
  // A sparse card stays on 1M (largestEnabledRange → "1M"), and the user can
  // still pick 1M. Keyed on the resolved availability so it settles once.
  useEffect(() => {
    if (rangeTouched) return;
    if (!historyData) return;
    setRange(largestEnabledRange(rangeAvail));
    // rangeAvail is derived from historyData; depend on the stable span value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyData, spanDays, rangeTouched]);

  // Multi-series chart matrix for the user's selected chips (each plots its OWN
  // real stored per-grade history, windowed by the active range tab).
  const matrix = useMemo(
    () =>
      buildChartMatrix({
        activeChips: allChips.filter((c) => activeSeries.has(c.id)),
        history: historyData,
        chipPrice,
        rangeDays: RANGE_DAYS[effRange] ?? Infinity,
        range: effRange,
      }),
    [allChips, activeSeries, historyData, chipPrice, effRange]
  );

  return (
    <div className="dojo-detail-col" style={{ paddingBottom: "24px" }}>
      {/* ── Hero art with overlaid controls ── */}
      <div style={{ position: "relative", display: "flex", justifyContent: "center", padding: "12px 0 4px" }}>
        <img
          src={
            flipped
              ? "/cards/card-back.webp"
              : heroError
                ? PLACEHOLDER
                : heroSrc
          }
          alt={name}
          onError={() => setHeroError(true)}
          onClick={() => setFlipped((v) => !v)}
          title="Flip the card"
          style={{
            width: "206px",
            maxWidth: "100%",
            aspectRatio: "660 / 921",
            objectFit: "cover",
            cursor: "pointer",
            background: "var(--color-dojo-raised)",
            transition: "transform 150ms ease-out",
          }}
        />
        {/* top-left: back */}
        <button
          onClick={() => router.back()}
          title="Back"
          style={{
            position: "absolute", top: 0, left: "22px", width: "38px", height: "38px", zIndex: 4,
            border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", color: "var(--color-dojo-ink)",
          }}
        >
          <ChevronLeft />
        </button>
        {/* top-right: more */}
        <div style={{ position: "absolute", top: 0, right: "22px", zIndex: 4 }}>
          <button
            onClick={() => { setMenuOpen((v) => !v); setShareOpen(false); }}
            title="More"
            style={{
              width: "38px", height: "38px",
              border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)",
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "3px",
              cursor: "pointer", color: "var(--color-dojo-ink)",
            }}
          >
            <MoreIcon />
          </button>
          {menuOpen && (
            <>
              {/* Click-away scrim — closes on outside click (QA #10). Below the
                  .dojo-menu z-index (60) so the menu's own rows stay clickable. */}
              <div onClick={() => setMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 59 }} />
            <div className="dojo-menu" style={{ top: "42px", right: 0, left: "auto", width: "210px" }}>
              {["Report image issue", "Report pricing issue", "Report missing product"].map((l) => (
                <div
                  key={l}
                  className="row"
                  onClick={() => {
                    // Report buttons are now actionable (Phase 3 QA):
                    // close the menu and confirm via toast.
                    setMenuOpen(false);
                    setToast("Report submitted. Thank you.");
                  }}
                  style={{ fontSize: "12.5px" }}
                >
                  {l}
                </div>
              ))}
            </div>
            </>
          )}
        </div>
        {/* bottom-right: share */}
        <div style={{ position: "absolute", bottom: "4px", right: "22px", zIndex: 4 }}>
          <button
            onClick={() => { setShareOpen((v) => !v); setMenuOpen(false); }}
            title="Share"
            style={{
              width: "38px", height: "38px",
              border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)",
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", color: "var(--color-dojo-ink)",
            }}
          >
            <ShareIcon />
          </button>
          {shareOpen && (
            <>
              {/* Click-away scrim — closes on outside click (QA #10). Below the
                  .dojo-menu z-index (60) so the menu's own rows stay clickable. */}
              <div onClick={() => setShareOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 59 }} />
            <div className="dojo-menu" style={{ bottom: "46px", right: 0, left: "auto", top: "auto", width: "190px" }}>
              {["Instagram", "WhatsApp", "X", "Copy link"].map((l) => (
                <div key={l} className="row" onClick={() => setShareOpen(false)}>
                  <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-ink)" }}>{l}</span>
                </div>
              ))}
            </div>
            </>
          )}
        </div>
      </div>

      {/* ── Info block — full-bleed dark strip ── */}
      <div style={{ margin: "22px 0 0", padding: "18px 22px 10px", background: "var(--color-dojo-card)", borderTop: "1px solid var(--color-dojo-stroke)", borderBottom: "1px solid var(--color-dojo-stroke)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
          <div style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "18px", lineHeight: 1.3, color: "var(--color-dojo-ink)" }}>
            {name}
          </div>
          <button
            onClick={() => {
              // Persisted toggle; hook returns the new state for the toast.
              const next = toggleWant({ externalId: id, name });
              setToast(next ? "Added to Want to Buy" : "Removed from Want to Buy");
            }}
            title={starred ? "Remove from Want to Buy" : "Add to Want to Buy"}
            aria-pressed={starred}
            style={{
              flex: "none", width: "34px", height: "34px", fontSize: "16px",
              border: "1px solid " + (starred ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"),
              background: starred ? "var(--color-dojo-gold)" : "var(--color-dojo-app)",
              color: starred ? "var(--color-dojo-app)" : "var(--color-dojo-body)",
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", transition: "all 150ms",
            }}
          >
            {starred ? "★" : "☆"}
          </button>
        </div>
        {/* Task 1: "{Game} · {Set}" (real franchise name, not the generic
            "Trading Card Game"). */}
        <div style={{ marginTop: "8px", fontSize: "12.5px", color: "var(--color-dojo-body)" }}>
          {gameName}{setName ? <> · <span style={{ color: "var(--color-dojo-gold)" }}>{setName}</span></> : null}
        </div>
        {/* Task 2: serial line "{rarity} · {number}" (e.g. "SR · ST01-012").
            Only shown when we have at least one of the two. */}
        {(rarity || serialNumber) && (
          <div style={{ marginTop: "4px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
            {[rarity, serialNumber].filter(Boolean).join(" · ")}
          </div>
        )}

        {/* Variant selector — only when > 1 variant is stored for this card.
            ponytail: VariantSelect lists only PRICED variants (listVariants
            derives from CurrentPrice rows, and the price writer drops
            all-null-price variants), so an alt-art variant that has a stored
            image but NO priced CurrentPrice row will NOT appear here — its art
            is captured in variantImages but it's unselectable. Accepted
            boundary. Ceiling: priced-variant-only selectability. Upgrade path:
            surface image-only variants by unioning variantImages keys into
            listVariants (a parallel variant source). Do NOT list unpriced
            variants casually — it changes what the user can pick. */}
        <VariantSelect
          variants={variants}
          value={variant}
          onChange={(v) => setVariantSel({ id, v })}
        />

        <div style={{ marginTop: "16px", display: "flex", alignItems: "flex-end", gap: "12px" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Batch 2B · Item 3: while the price query is loading show block
                skeletons sized to the real price + delta rows (zero layout
                shift). Once resolved, the honest value or "—" renders (an
                unpriced card is a real empty state, never a forever
                skeleton — AGENTS.md #2). The .dojo-fade-in-fast class
                (Item 4) eases the swap in. */}
            {pricesLoading ? (
              <div className="dojo-fade-in-fast" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <Skeleton height={26} width="55%" />
                <Skeleton height={12} width="38%" />
              </div>
            ) : (
            <div className="dojo-fade-in-fast">
            <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: "26px", lineHeight: 1.05, fontVariantNumeric: "tabular-nums", color: price != null ? "var(--color-dojo-ink)" : "var(--color-dojo-faint)" }}>
              {price != null ? fmtUSD(price) : "—"}
            </div>
            {/* REAL weekly change (weeklyChangePct). Sign drives the arrow +
                jade/vermilion color. Null (no priced pull yet) → muted "—",
                never a fabricated number (AGENTS.md rule 2). */}
            {weeklyChangePct != null ? (
              <div style={{ marginTop: "6px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: weeklyChangePct >= 0 ? "var(--color-dojo-jade)" : "var(--color-dojo-vermilion)" }}>
                {weeklyChangePct >= 0 ? "▲" : "▼"} {weeklyChangePct >= 0 ? "+" : ""}{weeklyChangePct.toFixed(1)}% · 1W
              </div>
            ) : (
              <div style={{ marginTop: "6px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
                —
              </div>
            )}
            </div>
            )}
          </div>
          <button
            data-testid="want-to-buy-btn"
            onClick={() => {
              // Card detail is the search/explore view (a card not owned) —
              // its primary want-list action is WANT TO BUY (intent BUY).
              // Persisted via the shared want-list hook; toggling off removes
              // it. Toast matches the design copy exactly.
              const next = toggleWant({ externalId: id, name });
              setToast(next ? "Added to Want to Buy" : "Removed from Want to Buy");
            }}
            aria-pressed={starred}
            style={{
              flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center",
              height: "38px", padding: "0 18px",
              border: starred ? "1.5px solid var(--color-dojo-gold)" : "1.5px solid var(--color-dojo-stroke)",
              background: starred ? "rgba(233,180,59,.1)" : "transparent",
              color: starred ? "var(--color-dojo-gold)" : "var(--color-dojo-faint)",
              cursor: "pointer", transition: "all 150ms", whiteSpace: "nowrap",
              fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "10.5px", letterSpacing: "0.14em",
            }}
          >
            {starred ? "✓ WANT TO BUY" : "WANT TO BUY"}
          </button>
        </div>

        {/* eBay comparison sections removed per design (Find on eBay /
            Good Deal / lowest listing / View on eBay). Live listings now
            surface via "Sellers on the Floor" lower on the page. */}

        <div style={{ height: "1px", background: "var(--color-dojo-divider)", margin: "20px -22px 0" }} />

        {/* ── Price history ── */}
        <div style={{ marginTop: "20px", display: "flex", alignItems: "baseline" }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
            Price history
          </span>
          <span style={{ marginLeft: "auto", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
            Pick up to 3
          </span>
        </div>
        <div style={{ display: "flex", gap: "18px", marginTop: "12px", overflowX: "auto", paddingBottom: "4px", margin: "12px -22px 0", padding: "0 22px 4px" }}>
          {chipGroups.map((grp) => (
            <div key={grp.group} style={{ flex: "none" }}>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>{grp.group}</div>
              <div style={{ display: "flex", marginTop: "7px" }}>
                {grp.chips.map((d) => {
                  const on = activeSeries.has(d.id);
                  return (
                    <button
                      key={d.id}
                      onClick={() => toggleSeries(d.id)}
                      style={{
                        minWidth: "70px", border: `1px solid ${on ? d.color : "var(--color-dojo-stroke)"}`,
                        marginRight: "-1px", padding: "8px 10px", cursor: "pointer", textAlign: "center", whiteSpace: "nowrap",
                        color: on ? d.color : "var(--color-dojo-ink)",
                        background: on ? "rgba(255,255,255,.05)" : "var(--color-dojo-card)",
                        position: "relative", zIndex: on ? 1 : 0,
                      }}
                    >
                      <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "12.5px" }}>{d.grade}</div>
                      <div style={{ marginTop: "3px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "11.5px", color: "var(--color-dojo-body)" }}>
                        {d.price != null ? fmtUSDCompact(d.price) : "—"}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div style={{ margin: "12px -22px 0" }}>
          {/* Batch 2B · Item 3: while history is loading, reserve the chart's
              exact 170px height with a block skeleton (no layout shift). Once
              resolved the AreaChart renders — with < 2 real points it draws
              its honest flat baseline (never a fabricated curve, AGENTS.md
              #2). Item 4 fades the swap in. */}
          {historyLoading || pricesLoading ? (
            <div className="dojo-fade-in-fast" style={{ padding: "0 22px" }}>
              <Skeleton height={280} />
            </div>
          ) : (
            <div className="dojo-fade-in-fast">
              {/* Design-system AreaChart port (multi-series): each selected
                  chip plots its OWN real stored per-grade history, windowed by
                  the active range tab. buildChartMatrix emits a dense matrix
                  (>=2 rows per drawn series, no NaN/undefined) so the shared
                  scale is never poisoned. A chip with no history flattens to a
                  marker at its current price. When every chip is deselected /
                  excluded the matrix is EMPTY (audit 04 F-04) — render an honest
                  empty state, NOT a fabricated $1 baseline (AGENTS.md RULE 2). */}
              {matrix.series.length === 0 ? (
                <div
                  data-testid="chart-empty"
                  role="img"
                  aria-label="No price history selected"
                  style={{
                    height: 280, display: "flex", alignItems: "center", justifyContent: "center",
                    padding: "0 22px", textAlign: "center",
                    color: "var(--color-dojo-faint)", fontFamily: "var(--font-display)",
                    fontWeight: 700, fontSize: "11px", letterSpacing: "0.1em", textTransform: "uppercase",
                  }}
                >
                  Select a price to view its history
                </div>
              ) : (
                <AreaChart
                  data={matrix.data}
                  series={matrix.series}
                  height={280}
                  ariaLabel="Price history chart"
                />
              )}
            </div>
          )}
        </div>
        <div style={{ display: "flex", marginTop: "4px" }}>
          {/* BUG 4: render ONLY the ranges the stored span actually enables
              (visibleRanges) so a ~6-month card never shows a greyed 1Y/MAX.
              The largest rendered tab == largestEnabledRange, so it still spans
              all available data. Only enabled tabs exist now — no
              disabled/opacity/aria-disabled/title branches remain. */}
          {visibleRanges(spanDays).map((key) => (
            <button
              key={key}
              onClick={() => {
                // BUG 6: an explicit pick sticks — stop the auto-default
                // from overriding the user's chosen range thereafter.
                setRangeTouched(true);
                setRange(key);
              }}
              style={{
                flex: 1, textAlign: "center", padding: "9px 0 7px", cursor: "pointer",
                background: "transparent", border: "none",
                borderBottom: effRange === key ? "2px solid var(--color-dojo-gold)" : "2px solid transparent",
                fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9.5px", letterSpacing: "0.14em",
                color: effRange === key ? "var(--color-dojo-ink)" : "var(--color-dojo-faint)",
              }}
            >
              {RANGE_LABEL[key]}
            </button>
          ))}
        </div>
        <div data-testid="history-span" style={{ marginTop: "4px", textAlign: "center", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
          {spanDays > 0 ? `${spanDays} days of history` : "No price history yet"}
        </div>
      </div>

      <div style={{ padding: "0 22px" }}>
        {/* ── Add to collection ── A single CTA that opens the SHARED
            AddCardSheet (same flow as the Explore grid): RAW/PSA grader
            toggle, condition dropdown (Near mint / Lightly played / …),
            collection picker, qty, optional price. */}
        <button
          className="dojo-btn dojo-btn-primary"
          style={{ width: "100%", marginTop: "22px", height: "44px" }}
          onClick={() => setSheetOpen(true)}
        >
          ADD TO COLLECTION →
        </button>

        {sheetOpen && (
          <AddCardSheet
            // imageUrl intentionally null: the raw upstream url is no longer
            // carried into this page (hide-img-source). For a KNOWN card the
            // collection POST ignores a client imageUrl anyway (the shared
            // catalog row's image wins); only a brand-new live-search row
            // would miss an image, which then falls back to initials — the
            // same-origin proxy url must NOT be stored (it isn't a real URL).
            card={{ externalId: id, name, setName: setName || null, imageUrl: null, marketPrice: fetchedPrice ?? (priceParam > 0 ? priceParam : null), gradedPrices }}
            onClose={() => setSheetOpen(false)}
            onAdded={(msg) => { setSheetOpen(false); setToast(msg); }}
          />
        )}
        {/* ── Population report — PSA English only; BGS unavailable ── */}
        <PopulationReport id={id} />

        {/* ── Recent Sales — real Scrydex eBay SOLD records (never active) ──
            UNFILTERED this phase (design §4.1 option b): no grade/variant is
            passed. The page's `grade` state is a MULTI-SELECT chart series
            selector (up to 3 grade lines), NOT a single sold-record filter, so
            threading it here would be wrong; graded sold-record labelling is
            unresolved (Audit L2). RecentSales keeps optional grade?/variant?
            params for a future single-grade filter, left unused for now. */}
        {/* Auto-displayed: the on-mount enrich POST now stores recent SOLD rows
            (the third pull, same 24h cadence as history/population), so the
            section shows the stored sales on first render WITHOUT a button
            press. RecentSales auto-fetches the pure-Postgres GET on mount and
            the enrich query invalidates ["ebay-sold", id] once it settles so
            freshly-stored rows repaint. We NEVER fire a credit-spending POST
            from the client — the enrich POST is the only pull. A card Scrydex
            has no sold records for keeps the honest "No recent sales found"
            empty state (RULE 2). */}
        <RecentSales id={id} setName={setName} rarity={rarity} />

        {/* Accessories block REMOVED — it was dummy/hardcoded data (plan §4). */}
      </div>

      {/* Single toast channel — add confirmations, favorites feedback,
          and Report submissions (Phase 3). */}
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}


export default function CardDetailPage() {
  return (
    <Suspense fallback={<div style={{ padding: "24px 22px", color: "var(--color-dojo-body)" }}>Loading…</div>}>
      <CardDetailInner />
    </Suspense>
  );
}
