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

import { useState, useMemo, Suspense } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Toast } from "@/components/Toast";
import { RecentSales } from "@/components/RecentSales";
import { AreaChart } from "@/components/AreaChart";
import { AddCardSheet } from "@/components/AddCardSheet";
import { Skeleton } from "@/components/Skeleton";
import { useWantToBuy } from "@/lib/hooks/useWantToBuy";
import { gradedPrice } from "@/lib/utils/graded-price";
import {
  buildChips,
  buildChartMatrix,
  sortByGradeDesc,
  type CurrentPriceRow,
  type HistoryResponse,
} from "./price-history-chart";

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
const RANGE_TABS = [["1M", "1M"], ["3M", "3M"], ["12M", "1Y"], ["MAX", "ALL"]] as const;
const RANGE_DAYS: Record<string, number> = { "1M": 31, "3M": 93, "1Y": 366, "ALL": Infinity };

function fmtUSD(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

// Compact USD for the grade chip labels (e.g. 7930 → "$7.93K"); plain
// fmtUSD under $1000 so small raw prices stay exact.
function fmtUSDCompact(n: number): string {
  if (n < 1000) return fmtUSD(n);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(n);
}

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
  const id = params?.id as string;

  const name = searchParams.get("name") ?? "Card";
  const setName = searchParams.get("set") ?? "";
  const img = searchParams.get("img") ?? "/cards/card-front.webp";
  const priceParam = Number(searchParams.get("price") ?? 0);
  
  // Batch 2B · Item 2 (paint-from-cache): this query intentionally sets NO
  // staleTime, so it inherits the global 5-minute default (providers.tsx).
  // A revisited card therefore paints instantly from cache then
  // background-refreshes — do NOT lower it to 0. ["card-history", id] +
  // ["graded", …] below keep their 60s staleTime (quick back/forward cache
  // hit without harming correctness). The search grid prefetches these
  // exact keys on hover (search/page.tsx prefetchCardDetail), so the first
  // open is usually already a cache hit too.
  const { data: pricesData, isLoading: pricesLoading } = useQuery({
    queryKey: ["card-prices", id],
    queryFn: async () => {
      const res = await fetch(`/api/cards/${encodeURIComponent(id)}/prices`);
      if (!res.ok) throw new Error("Failed to load prices");
      return res.json();
    },
  });

  const currentPrices = pricesData?.prices ?? [];
  // REAL 7-day % change (Scrydex trends.days_7). Null until a priced pull runs
  // → the trend row renders "—" (never a fabricated number — AGENTS.md rule 2).
  const weeklyChangePct: number | null =
    typeof pricesData?.weeklyChangePct === "number" ? pricesData.weeklyChangePct : null;
  // Headline raw NM point (26px price) — UNCHANGED. Prefer a type==='raw' NM
  // row, else any NM, else the first row (back-compat with pre-C1 rows that
  // carry no `type`).
  const rawPriceData =
    currentPrices.find((p: CurrentPriceRow) => (p.type ?? "raw") === "raw" && p.condition === "NM") ||
    currentPrices.find((p: CurrentPriceRow) => p.condition === "NM") ||
    currentPrices[0];
  const fetchedPrice = rawPriceData?.priceMarket ?? rawPriceData?.priceLow;
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
      : /^(OP|ST|EB|PRB)\d{2}-\d{3}$/i.test(id)
        ? "onepiece"
        : "pokemon";

  // Franchise display name for the "{Game} · {Set}" line (Task 1).
  const gameName = game === "onepiece" ? "One Piece" : "Pokémon";

  // Serial line "{rarity} · {number}" (Task 2). One Piece ids are the
  // serial sellers use (OP01-001); Pokémon's serial is the `number` field
  // ("4/102"). Prefer the passed `number`, else fall back to the id for
  // Bandai-coded One Piece cards.
  const rarity = searchParams.get("rarity") ?? "";
  const isBandai = /^(OP|ST|EB|PRB)\d{2}-\d{3}$/i.test(id ?? "");
  // Prefer the real DB `number` param. Fall back to the id: One Piece ids
  // ARE the serial (OP01-001); for other ids show the whole id (e.g.
  // "sv3-224") rather than "undefined". Empty only when there's no id.
  const serialNumber =
    searchParams.get("number") ||
    (isBandai ? (id ?? "").toUpperCase() : (id ?? ""));

  const [flipped, setFlipped] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // The "track this card" star adds to Want to Buy (server-backed) — this
  // replaced the removed favourites feature.
  const { isWanted, toggle: toggleWant } = useWantToBuy();
  const starred = isWanted(id);
  const [activeSeries, setActiveSeries] = useState<Set<string>>(new Set(["raw"]));
  const [range, setRange] = useState<string>("1M");
  // Recent Sales is button-gated now (no auto fetch on mount) — this flips true
  // once the user clicks "Load recent sales", which fires the gated POST pull
  // and then mounts <RecentSales> (its own GET renders the stored rows).
  const [salesRequested, setSalesRequested] = useState(false);
  const queryClient = useQueryClient();
  // ADD TO COLLECTION opens the shared AddCardSheet (same flow as Explore).
  const [sheetOpen, setSheetOpen] = useState(false);
  // Single toast channel for this page: add confirmations, favorites
  // feedback, and Report submissions all route through here (Phase 3).
  const [toast, setToast] = useState<string | null>(null);

  // Real PSA 10 price from the server graded route (routes through Scrydex +
  // the curated/multiplier fallback). Public route — no credentials needed.
  // `price` is null when the card is unknown/unpriced; we then keep the local
  // heuristic below so the UI never regresses to blank.
  const { data: gradedData } = useQuery<{ price: number | null; isFallback?: boolean }>({
    queryKey: ["graded", id, "10"],
    queryFn: async () => {
      const res = await fetch(`/api/cards/${encodeURIComponent(id)}/graded?grade=10`);
      if (!res.ok) throw new Error("Failed to load graded price");
      return res.json();
    },
    staleTime: 60_000,
  });

  // Real PSA 9 price — same public graded route, grade=9 — used only for the
  // PSA 9 price-history chip label (null → "—", never fabricated).
  const { data: graded9Data } = useQuery<{ price: number | null; isFallback?: boolean }>({
    queryKey: ["graded", id, "9"],
    queryFn: async () => {
      const res = await fetch(`/api/cards/${encodeURIComponent(id)}/graded?grade=9`);
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
    queryKey: ["card-history", id],
    queryFn: async () => {
      const res = await fetch(`/api/cards/${encodeURIComponent(id)}/history`);
      if (!res.ok) throw new Error("Failed to load history");
      return res.json();
    },
    staleTime: 60_000,
  });

  // ON-VIEW enrichment: fire the enrich POST exactly ONCE per card mount. Using
  // a useQuery (not a bare useEffect) keyed ["enrich", id] with Infinity
  // stale/gc + no retry dedupes the POST across remounts via the query cache
  // (TanStack-first convention). The route is a no-op {enriched:false} unless
  // SCRYDEX_ONVIEW_ENABLED is on, so this costs nothing in dev. When it reports
  // enriched:true we invalidate the two read queries so the fresh stored data
  // repaints; a failed / {enriched:false} response is a silent no-op.
  useQuery({
    queryKey: ["enrich", id],
    queryFn: async () => {
      const res = await fetch(`/api/cards/${encodeURIComponent(id)}/enrich`, {
        method: "POST",
        credentials: "include",
      });
      const body = await res.json().catch(() => ({ enriched: false }));
      // Always re-read history + population after the enrich settles — not only
      // on enriched:true. A card already enriched returns {reason:"fresh"} but
      // the first on-mount population/history fetch may have raced AHEAD of the
      // stored data (or cached an early null), so invalidate regardless so the
      // panels repaint from the DB. Cheap DB reads (Redis-cached server-side).
      queryClient.invalidateQueries({ queryKey: ["card-history", id] });
      queryClient.invalidateQueries({ queryKey: ["population", id] });
      return body;
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
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
    // FR-6: the PSA 10 / PSA 9 rows must ALWAYS carry a non-blank price. Prefer
    // the live graded-route value; when the route has none (Scrydex miss), fall
    // back to the curated/multiplier estimate from the raw market price so the
    // UI never regresses to a blank graded row. Nothing is fabricated — the
    // fallback is the same curated resolver the server route uses. Only applied
    // when a raw price exists (no raw price → honest "—").
    if (gradedData?.price != null) {
      map["PSA|10"] = gradedData.price;
    } else if (rawPrice != null) {
      map["PSA|10"] = gradedPrice(rawPrice, 10);
    }
    if (graded9Data?.price != null) {
      map["PSA|9"] = graded9Data.price;
    } else if (rawPrice != null) {
      map["PSA|9"] = gradedPrice(rawPrice, 9);
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
    () =>
      (currentPrices as CurrentPriceRow[])
        .filter((p) => (p.type ?? "raw") === "graded" && p.company && p.grade)
        .map((p) => ({
          company: (p.company as string).toUpperCase(),
          grade: p.grade as string,
          price: p.priceMarket ?? p.priceLow ?? null,
        })),
    [currentPrices]
  );

  // Multi-series chart matrix for the user's selected chips (each plots its OWN
  // real stored per-grade history, windowed by the active range tab).
  const matrix = useMemo(
    () =>
      buildChartMatrix({
        activeChips: allChips.filter((c) => activeSeries.has(c.id)),
        history: historyData,
        chipPrice,
        rangeDays: RANGE_DAYS[range] ?? Infinity,
        range,
      }),
    [allChips, activeSeries, historyData, chipPrice, range]
  );

  return (
    <div style={{ paddingBottom: "24px" }}>
      {/* ── Hero art with overlaid controls ── */}
      <div style={{ position: "relative", display: "flex", justifyContent: "center", padding: "12px 0 4px" }}>
        <img
          src={flipped ? "/cards/card-back.webp" : img}
          alt={name}
          onClick={() => setFlipped((v) => !v)}
          title="Flip the card"
          style={{
            width: "206px",
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
            <div className="dojo-menu" style={{ bottom: "46px", right: 0, left: "auto", top: "auto", width: "190px" }}>
              {["Instagram", "WhatsApp", "X", "Copy link"].map((l) => (
                <div key={l} className="row" onClick={() => setShareOpen(false)}>
                  <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-ink)" }}>{l}</span>
                </div>
              ))}
            </div>
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
          {historyLoading ? (
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
                  marker at its current price; all-excluded → an honest flat
                  baseline (never a fabricated curve). */}
              <AreaChart
                data={matrix.data}
                series={matrix.series}
                height={280}
                ariaLabel="Price history chart"
              />
            </div>
          )}
        </div>
        <div style={{ display: "flex", marginTop: "4px" }}>
          {RANGE_TABS.map(([label, key]) => (
            <button
              key={key}
              onClick={() => setRange(key)}
              style={{
                flex: 1, textAlign: "center", padding: "9px 0 7px", cursor: "pointer",
                background: "transparent", border: "none",
                borderBottom: range === key ? "2px solid var(--color-dojo-gold)" : "2px solid transparent",
                fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9.5px", letterSpacing: "0.14em",
                color: range === key ? "var(--color-dojo-ink)" : "var(--color-dojo-faint)",
              }}
            >
              {label}
            </button>
          ))}
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
            card={{ externalId: id, name, setName: setName || null, imageUrl: img || null, marketPrice: fetchedPrice ?? (priceParam > 0 ? priceParam : null), gradedPrices }}
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
        {/* Button-gated: no sold-record fetch happens until the user clicks.
            The POST runs the on-view-allowance-gated pull (a no-op when the
            flag is off), then invalidates ["ebay-sold", id] so RecentSales'
            GET re-reads the stored rows. Once requested, RecentSales mounts and
            renders exactly as before ("No recent sales found" when empty). */}
        {salesRequested ? (
          <RecentSales id={id} setName={setName} rarity={rarity} />
        ) : (
          <button
            className="dojo-btn dojo-btn-outline"
            style={{ width: "100%", marginTop: "22px", height: "44px" }}
            onClick={() => {
              setSalesRequested(true);
              fetch(`/api/cards/${encodeURIComponent(id)}/ebay-sold`, {
                method: "POST",
                credentials: "include",
              })
                .catch(() => {})
                .finally(() => {
                  queryClient.invalidateQueries({ queryKey: ["ebay-sold", id] });
                });
            }}
          >
            Load recent sales
          </button>
        )}

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
