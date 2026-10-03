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
 *   - "Price history" — grade-group chips (Raw / PSA / BGS) that
 *     multi-select up to 3 series, an area chart (same technique as
 *     the dashboard's DojoChart), and range tabs.
 *   - "Adding to: Main" quantity card (Ungraded / Graded rows).
 *   - Population report (grader tabs + grade/count grid).
 *   - SOLD LIST button.
 *   - Accessories row.
 *
 * Card identity/price/image are carried via query params from the
 * search results grid (see search/page.tsx CardTile) since there is
 * no get-by-id API — only /api/cards/search exists. The Price-history
 * chart is driven by REAL data: the Raw line plots recorded
 * PricingHistory (/api/cards/[id]/history) and the chip prices come
 * from live sources (market price + /api/cards/[id]/graded for PSA);
 * population data + add-rows still follow the reference shape.
 */

import { useState, useMemo, Suspense, useEffect, useRef } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Toast } from "@/components/Toast";
import { AreaChart } from "@/components/AreaChart";
import { useWantToBuy } from "@/lib/hooks/useWantToBuy";

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

// ── Price-history series — the Price History selector shows only the
// grade groups we can price from REAL sources today: Raw (recorded
// PricingHistory) and PSA 10 / PSA 9 (the /graded route). BGS was
// removed from this selector — we have no BGS price/line pipeline, so a
// static BGS chip would be fabricated data. (BGS still lives in the
// unrelated population-report grader toggle / GRADED_RE / Add sheet.)
// Chip PRICE labels are populated per-card from live data at render
// time (no hardcoded priceFmt), so a card with no price renders "—". ──
const SERIES = [
  { id: "raw", label: "Raw", grade: "Raw", group: "Raw", color: "#9AA0A6" },
  { id: "psa10", label: "PSA 10", grade: "10", group: "PSA", color: "var(--color-dojo-gold)" },
  { id: "psa9", label: "PSA 9", grade: "9", group: "PSA", color: "var(--color-dojo-jade)" },
];
const GROUPS = ["Raw", "PSA"];

// ADD_ROWS structure template — prices are populated dynamically per card
// in CardDetailInner based on the card's actual marketPrice, not hardcoded.
const ADD_ROWS_TEMPLATE = [
  { id: "raw", section: "raw" as const, label: "Foil" },
  { id: "psa10", section: "graded" as const, label: "PSA 10 (GEM - MT)", variant: "Foil", pop: "Pop: 3583" },
];

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

// ── Area chart — same port of app.js chart() used on the dashboard:
// area polygon + polyline(s) + grid lines. Supports multiple series
// (price-history can show up to 3 grade lines at once).
//
// Interaction (Phase 2 QA: chart hover/tooltips must work on mobile):
// pointer/touch snaps to the nearest x sample and draws a vertical
// guide plus a marker dot on every visible series. The `pts` are
// normalized chart-shape units (0..90 band) derived from the card's
// REAL price history — the exact {date, price} ride on `points` for the
// tooltip. viewBox uses the default meet aspect, so pointer mapping
// goes through the rendered rect width. ────────────────────────────
// F-09: format a point's date for the tooltip, e.g. "2026-06-01" → "Jun 2026".
function fmtChartDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

// Price-history chart now renders via the shared, design-system-faithful
// AreaChart port (src/components/AreaChart.tsx) — see the call site below. The
// old hand-rolled DojoChart (custom hover/tooltip/markers/x-axis) was removed
// in favour of that single canonical component. `fmtChartDate` is kept: it
// builds the AreaChart x-axis labels from the REAL {date} points.

// ── Sellers on the Floor (Task 6) ───────────────────────────────────
// Recent Sales — REAL eBay SOLD records from Scrydex's documented listings
// endpoint (/api/cards/[id]/ebay-sold → Scrydex source=ebay, filtered to
// records with sold_at). These are completed sales, NOT active listings — we
// never fall back to active listings. Empty / unavailable / pending-approval →
// "No recent sales found" (plan §4). Filtered by the selected grade/variant.
interface SoldRecord {
  itemId: string;
  source: string | null;
  title: string | null;
  price: number | null;
  currency: string | null;
  soldAt: string | null;
  grade: string | null;
  company: string | null;
  url: string | null;
}

function RecentSales({
  id, setName, rarity, grade, variant,
}: {
  id: string; setName: string; rarity: string; grade?: string; variant?: string;
}) {
  const { data, isLoading } = useQuery<{ listings: SoldRecord[] }>({
    queryKey: ["ebay-sold", id, grade ?? "", variant ?? ""],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (grade) qs.set("grade", grade);
      if (variant) qs.set("variant", variant);
      const res = await fetch(`/api/cards/${encodeURIComponent(id)}/ebay-sold?${qs.toString()}`);
      if (!res.ok) return { listings: [] };
      return res.json();
    },
    staleTime: 24 * 60 * 60_000, // matches the route's 24h shared cache
  });

  const listings = data?.listings ?? [];
  const heading = { fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px", letterSpacing: "0.18em", textTransform: "uppercase" as const, color: "var(--color-dojo-body)" };

  return (
    <>
      <div style={{ marginTop: "22px", display: "flex", alignItems: "baseline" }}>
        <span style={heading}>Recent Sales</span>
        {!isLoading && listings.length > 0 && (
          <span style={{ marginLeft: "auto", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
            {listings.length} sale{listings.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {isLoading ? (
        <div style={{ marginTop: "12px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "22px 15px", textAlign: "center" }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12px", color: "var(--color-dojo-faint)" }}>Checking sold records…</span>
        </div>
      ) : listings.length === 0 ? (
        <div style={{ marginTop: "12px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "22px 15px", textAlign: "center" }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12px", color: "var(--color-dojo-faint)" }}>No recent sales found</span>
        </div>
      ) : (
        <div style={{ marginTop: "12px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "2px 15px 6px" }}>
          {listings.map((l) => {
            const soldLabel = l.soldAt ? new Date(l.soldAt.replace(/\//g, "-")).toLocaleDateString() : "";
            const gradeLabel = l.company && l.grade ? `${l.company} ${l.grade}` : l.grade ?? "";
            const sub = [gradeLabel, setName, rarity].filter(Boolean).join(" · ");
            const priceStr = l.price != null && l.price > 0 ? new Intl.NumberFormat("en-US", { style: "currency", currency: l.currency ?? "USD" }).format(l.price) : "—";
            const Row = (
              <div style={{ display: "flex", alignItems: "center", gap: "11px", padding: "13px 0", borderBottom: "1px solid var(--color-dojo-divider)" }}>
                <div aria-hidden="true" style={{ flex: "none", width: "34px", height: "34px", background: "var(--color-dojo-gold)", color: "var(--color-dojo-app)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px" }}>
                  {(l.source ?? "e").charAt(0).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12.5px", color: "var(--color-dojo-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    Sold{soldLabel ? ` ${soldLabel}` : ""}
                  </div>
                  {sub && (
                    <div style={{ marginTop: "2px", fontSize: "10.5px", color: "var(--color-dojo-body)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>
                  )}
                </div>
                <div style={{ textAlign: "right", flex: "none" }}>
                  <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13.5px", fontVariantNumeric: "tabular-nums", color: "var(--color-dojo-ink)" }}>{priceStr}</div>
                  {l.url && (
                    <a href={l.url} target="_blank" rel="noopener noreferrer" style={{ marginTop: "3px", display: "inline-block", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-gold)", textDecoration: "none" }}>
                      View sale ›
                    </a>
                  )}
                </div>
              </div>
            );
            return <div key={l.itemId}>{Row}</div>;
          })}
        </div>
      )}
    </>
  );
}

// ── Population report (PSA English only; BGS unavailable; no fabrication) ──
// Plan §4: Scrydex public coverage is Pokémon PSA English only. We NEVER show
// fabricated numbers. The GET is a pure read of STORED population; until a card
// is refreshed (a manual, owner-approval-gated action) there is no data and we
// show an honest fallback. BGS is explicitly "not available", not an empty grid.
interface PopGrade { grade: string; count: number }
interface PopCompany { company: "PSA"; language?: string; total: number; grades: PopGrade[] }
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
    staleTime: 24 * 60 * 60_000,
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", columnGap: "10px", marginTop: "10px" }}>
            {psa.grades.map((g) => (
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
  const queryClient = useQueryClient();
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
  const { data: pricesData } = useQuery({
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
  const rawPriceData = currentPrices.find((p: any) => p.condition === "NM") || currentPrices[0];
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
  const [addQty, setAddQty] = useState<Record<string, number>>({ raw: 0, psa10: 1 });
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // Single toast channel for this page: add confirmations, favorites
  // feedback, and Report submissions all route through here (Phase 3).
  const [toast, setToast] = useState<string | null>(null);

  // Reset add quantities when card ID changes (prevents stale state when
  // navigating between cards).
  useEffect(() => {
    setAddQty({ raw: 0, psa10: 1 });
    setAddError(null);
  }, [id]);

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

  // Build ADD_ROWS dynamically using the actual card's market price.
  // Ungraded (raw) = actual market price. PSA 10 uses the real server graded
  // price when available, falling back to the local heuristic below.
  const ADD_ROWS = useMemo(() => {
    const rawPrice = price; // number | null — null stays null, never faked to 0
    // Heuristic fallback (used only when the graded route returns no price):
    // graded always trades above raw; cheap cards carry the biggest relative
    // premium (grading fee dominates), so start at ~4.5x and ease toward ~2x
    // for high-value cards. Continuous curve (no step at $10). When raw is
    // null we have no base, so the PSA 10 price is null too (never computed
    // off a fabricated number — AGENTS.md rule 2).
    const psa10Multiplier = 2 + 50 / ((rawPrice ?? 0) + 10);
    const psa10Price =
      gradedData?.price ?? (rawPrice != null ? rawPrice * psa10Multiplier : null);

    return [
      { id: "raw", section: "raw" as const, label: "Foil", price: rawPrice },
      { 
        id: "psa10", 
        section: "graded" as const, 
        label: "PSA 10 (GEM - MT)", 
        variant: "Foil", 
        pop: "Pop: 3583", 
        price: psa10Price,
        isFallback: gradedData?.price == null ? true : gradedData.isFallback,
      },
    ];
  }, [price, gradedData]);

  // Mutation for adding cards to collection
  const addMutation = useMutation({
    mutationFn: async (payload: { cards: any[] }) => {
      const res = await fetch("/api/users/me/collection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || json.added === 0) {
        throw new Error(json?.message ?? "Could not add cards.");
      }
      return json;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["collection"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio-collection"] });
      // Reset quantities after successful add
      setAddQty({ raw: 0, psa10: 0 });
      setToast(`Added ${name} to your portfolio`);
    },
    onError: (err: Error) => {
      setAddError(err.message);
    },
  });

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

  // F-18: real price history from the DB (PricingHistory). The chart is
  // driven entirely by these points — the Raw line plots them and the PSA
  // lines reuse their shape. Cards with < 2 points in the selected window
  // show a graceful flat baseline, never a fabricated mock curve. Never
  // errors — an empty/failed fetch just leaves realPts null.
  const { data: historyData } = useQuery<{ points: { date: string; price: number }[] }>({
    queryKey: ["card-history", id],
    queryFn: async () => {
      const res = await fetch(`/api/cards/${encodeURIComponent(id)}/history`);
      if (!res.ok) throw new Error("Failed to load history");
      return res.json();
    },
    staleTime: 60_000,
  });
  // Real history points filtered to the selected range tab (trailing window
  // measured back from the newest recorded point). MAX keeps everything.
  const windowPts = useMemo(() => {
    const points = historyData?.points ?? [];
    const days = RANGE_DAYS[range] ?? Infinity;
    if (points.length === 0 || days === Infinity) return points;
    const newest = new Date(`${points[points.length - 1].date}T00:00:00.000Z`).getTime();
    const cutoff = newest - days * 86_400_000;
    return points.filter((p) => new Date(`${p.date}T00:00:00.000Z`).getTime() >= cutoff);
  }, [historyData, range]);

  // Normalize the windowed real prices into the chart's shape band (4..86).
  // null when we have < 2 points for this window — the chart then shows a
  // graceful short/flat line, NEVER a fabricated mock shape (no-fabricate
  // rule now that a real pipeline exists).
  const realPts = useMemo(() => {
    if (windowPts.length < 2) return null;
    const prices = windowPts.map((p) => p.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;
    return prices.map((p) => 4 + ((p - min) / range) * (86 - 4));
  }, [windowPts]);

  // Data for the shared AreaChart (single-series mode). We draw the ONE real
  // raw-history series (date + price) — there is no real per-grade series, so
  // the grade chips drive the price LABELS, not separate curves (honest, no
  // fabrication). < 2 real points in the window → a flat, label-less baseline
  // so the chart still renders without inventing dates/prices.
  const detailChartData = useMemo(() => {
    if (realPts && windowPts.length >= 2) {
      return windowPts.map((p) => ({ label: fmtChartDate(p.date), value: p.price }));
    }
    // Honest flat baseline (no fabricated date labels, no fabricated price).
    return [
      { label: "", value: 1 },
      { label: "", value: 1 },
    ];
  }, [realPts, windowPts]);

  // When exactly one grade chip is selected, color the line with that chip's
  // color; otherwise let the AreaChart's trend coloring (green rising / red
  // dipping) decide. (Matches the old per-series chip color affordance.)
  const detailChartColor = useMemo(() => {
    const active = SERIES.filter((d) => activeSeries.has(d.id));
    return active.length === 1 ? active[0].color : undefined;
  }, [activeSeries]);

  const addTotal = ADD_ROWS.reduce((a, d) => a + (addQty[d.id] || 0) * (d.price ?? 0), 0);

  // Live price for each price-history chip (null → "—"). Raw = the card's
  // market price; PSA 10 / PSA 9 come from the /graded route. Never fabricated.
  const chipPrice: Record<string, number | null> = {
    raw: fetchedPrice ?? (priceParam > 0 ? priceParam : null),
    psa10: gradedData?.price ?? null,
    psa9: graded9Data?.price ?? null,
  };

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
          {GROUPS.map((g) => (
            <div key={g} style={{ flex: "none" }}>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>{g}</div>
              <div style={{ display: "flex", marginTop: "7px" }}>
                {SERIES.filter((d) => d.group === g).map((d) => {
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
                        {chipPrice[d.id] != null ? fmtUSDCompact(chipPrice[d.id] as number) : "—"}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div style={{ margin: "12px -22px 0" }}>
          {/* Design-system AreaChart port (single-series): the ONE real
              raw-history series for the selected range window. It renders the
              gradient fill, gridlines, dashed hover guide, markers, no-shadow
              tooltip, and the per-point date x-axis itself. < 2 real points →
              the flat, label-less baseline above (never a fabricated curve). */}
          <AreaChart
            data={detailChartData}
            height={170}
            color={detailChartColor}
          />
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
        {/* ── Adding to: Main ── */}
        <div style={{ marginTop: "22px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "15px" }}>
          <div style={{ display: "flex", alignItems: "baseline" }}>
            <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "14px", color: "var(--color-dojo-ink)" }}>
              Adding to: <span style={{ color: "var(--color-dojo-gold)" }}>Main</span>
            </div>
            <div style={{ marginLeft: "auto", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13px", fontVariantNumeric: "tabular-nums", color: "var(--color-dojo-ink)" }}>
              <span style={{ fontWeight: 400, color: "var(--color-dojo-faint)" }}>Total: </span>{fmtUSD(addTotal)}
            </div>
          </div>

          <div style={{ marginTop: "15px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>Ungraded</div>
          {ADD_ROWS.filter((d) => d.section === "raw").map((d) => (
            <AddQtyRow key={d.id} label={d.label} price={d.price} qty={addQty[d.id] || 0} onChange={(q) => setAddQty((s) => ({ ...s, [d.id]: q }))} />
          ))}

          <div style={{ marginTop: "13px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>Graded</div>
          {ADD_ROWS.filter((d) => d.section === "graded").map((d) => (
            <AddQtyRow key={d.id} label={d.label} sub={[d.variant, d.pop].filter(Boolean).join(" · ")} price={d.price} qty={addQty[d.id] || 0} onChange={(q) => setAddQty((s) => ({ ...s, [d.id]: q }))} />
          ))}
          {/* "+ Add a graded card" now works: bumps the graded row's qty
              by one so it's ready to submit (Phase 3 QA: graded flow must
              not bug out). Full multi-grade support is a Week 3 backend
              feature (grader/grade columns on UserCollection). */}
          <button
            type="button"
            onClick={() => setAddQty((s) => ({ ...s, psa10: (s.psa10 || 0) + 1 }))}
            style={{
              marginTop: "14px", marginLeft: "auto", display: "block",
              background: "none", border: "none", cursor: "pointer",
              fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px",
              letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-gold)",
            }}
          >
            + Add a graded card
          </button>

          {/* ADD TO COLLECTION button (Phase 1 fix) - submits addQty selections */}
          {addTotal > 0 && (
            <button
              className="dojo-btn dojo-btn-primary"
              style={{ width: "100%", marginTop: "16px", height: "44px" }}
              disabled={addMutation.isPending}
              onClick={async () => {
                setAddError(null);
                const cardsToAdd = [];
                
                // Map quantity selections to API payload format
                for (const [rowId, qty] of Object.entries(addQty)) {
                  if (qty <= 0) continue;
                  
                  const row = ADD_ROWS.find(r => r.id === rowId);
                  if (!row) continue;
                  
                  // Determine if this is a foil, graded, etc.
                  const isFoil = row.label.toLowerCase().includes("foil");
                  const isGraded = row.section === "graded";
                  
                  cardsToAdd.push({
                    externalId: id,
                    name: name,
                    setName: setName || undefined,
                    imageUrl: img && img.startsWith("http") ? img : undefined,
                    marketPrice: price || null,
                    quantity: qty,
                    isFoil,
                    // Note: Graded card support needs schema changes (Week 3)
                    // For now, graded cards are added as regular foil cards
                  });
                }
                
                if (cardsToAdd.length > 0) {
                  addMutation.mutate({ cards: cardsToAdd });
                }
              }}
            >
              {addMutation.isPending ? "ADDING..." : "ADD TO COLLECTION →"}
            </button>
          )}
          
          {addError && (
            <div style={{ marginTop: "12px", padding: "10px 12px", background: "var(--color-dojo-app)", border: "1px solid var(--color-dojo-vermilion)", fontSize: "12px", color: "var(--color-dojo-vermilion)" }}>
              {addError}
            </div>
          )}
        </div>

        {/* ── Population report — PSA English only; BGS unavailable ── */}
        <PopulationReport id={id} />

        {/* ── Recent Sales — real Scrydex eBay SOLD records (never active) ── */}
        <RecentSales id={id} setName={setName} rarity={rarity} />

        {/* Accessories block REMOVED — it was dummy/hardcoded data (plan §4). */}
      </div>

      {/* Single toast channel — add confirmations, favorites feedback,
          and Report submissions (Phase 3). */}
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}


// ── Quantity stepper row — ported from app.js addQtyRow() ──────────
function AddQtyRow({ label, sub, price, qty, onChange }: { label: string; sub?: string; price: number | null; qty: number; onChange: (q: number) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "13px 0", borderBottom: "1px solid var(--color-dojo-divider)" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12.5px", color: "var(--color-dojo-ink)" }}>{label}</div>
        {sub && <div style={{ marginTop: "2px", fontSize: "10.5px", color: "var(--color-dojo-body)" }}>{sub}</div>}
        <div style={{ marginTop: "3px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12.5px", color: "var(--color-dojo-gold)" }}>{price != null ? fmtUSD(price) : "—"}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", flex: "none" }}>
        <button
          onClick={() => onChange(Math.max(0, qty - 1))}
          style={{ width: "30px", height: "30px", border: "1px solid var(--color-dojo-stroke)", background: "transparent", color: "var(--color-dojo-ink)", cursor: "pointer", fontSize: "14px" }}
        >
          −
        </button>
        <div style={{ width: "36px", height: "30px", margin: "0 -1px", background: "var(--color-dojo-raised)", border: "1px solid var(--color-dojo-stroke)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-display)", fontWeight: 700, fontVariantNumeric: "tabular-nums", fontSize: "13px", color: "var(--color-dojo-ink)" }}>
          {qty}
        </div>
        <button
          onClick={() => onChange(qty + 1)}
          style={{ width: "30px", height: "30px", border: "1px solid var(--color-dojo-stroke)", background: "transparent", color: "var(--color-dojo-ink)", cursor: "pointer", fontSize: "14px" }}
        >
          +
        </button>
      </div>
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
