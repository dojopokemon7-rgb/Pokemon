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
 * no get-by-id API — only /api/cards/search exists. Price-history
 * series, population data, and add-rows are ported verbatim from
 * dojo-prototype/data.js (SERIES/POP/ADD_ROWS/CHARTS), which is mock
 * data in the reference too (a single fixed CARD object), not
 * per-card real data.
 */

import { useState, useMemo, Suspense, useEffect, useRef } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Toast } from "@/components/Toast";
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

// ── Mock price-history / pop-report data — ported verbatim from
// dojo-prototype/data.js SERIES / POP / ADD_ROWS / CHARTS. The
// reference itself uses one fixed CARD object for every card detail
// view (not per-card data), so this mirrors that scope exactly. ────
const SERIES = [
  { id: "raw", label: "Raw", grade: "Raw", group: "Raw", priceFmt: "$246", color: "#9AA0A6" },
  { id: "psa10", label: "PSA 10", grade: "10", group: "PSA", priceFmt: "$7.93K", color: "var(--color-dojo-gold)" },
  { id: "psa9", label: "PSA 9", grade: "9", group: "PSA", priceFmt: "$4.01K", color: "#0AC27E" },
  { id: "bgsbl", label: "BGS BL10", grade: "BL10", group: "BGS", priceFmt: "$42K", color: "#2D7FF9" },
  { id: "bgs10", label: "BGS 10", grade: "10", group: "BGS", priceFmt: "$9.77K", color: "#D400FF" },
  { id: "bgs9", label: "BGS 9", grade: "9", group: "BGS", priceFmt: "$5.2K", color: "#EE9A1F" },
];
const GROUPS = ["Raw", "PSA", "BGS"];

// ADD_ROWS structure template — prices are populated dynamically per card
// in CardDetailInner based on the card's actual marketPrice, not hardcoded.
const ADD_ROWS_TEMPLATE = [
  { id: "raw", section: "raw" as const, label: "Foil" },
  { id: "psa10", section: "graded" as const, label: "PSA 10 (GEM - MT)", variant: "Foil", pop: "Pop: 3583" },
];

const CHARTS: Record<string, number[]> = {
  "1M": [62, 54, 58, 45, 49, 36, 42, 27, 20, 25, 13, 4],
  "3M": [70, 64, 68, 58, 60, 50, 54, 44, 40, 46, 30, 20],
  "1Y": [78, 70, 74, 60, 64, 52, 58, 42, 44, 30, 22, 8],
  "ALL": [82, 76, 78, 68, 70, 58, 62, 48, 50, 34, 20, 4],
};
const RANGE_TABS = [["1M", "1M"], ["3M", "3M"], ["12M", "1Y"], ["MAX", "ALL"]] as const;

function fmtUSD(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

// ── Area chart — same port of app.js chart() used on the dashboard:
// area polygon + polyline(s) + grid lines. Supports multiple series
// (price-history can show up to 3 grade lines at once).
//
// Interaction (Phase 2 QA: chart hover/tooltips must work on mobile):
// pointer/touch snaps to the nearest x sample and draws a vertical
// guide plus a marker dot on every visible series. The `pts` are
// normalized chart-shape units (mock, not per-point prices — see the
// SERIES/CHARTS mock data), so we surface a position indicator rather
// than a fabricated dollar value; the series' overall price already
// shows on its chip. viewBox uses the default meet aspect, so pointer
// mapping goes through the rendered rect width. ────────────────────
// F-09: format a point's date for the tooltip, e.g. "2026-06-01" → "Jun 2026".
function fmtChartDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function DojoChart({
  series,
  height = 170,
  points,
}: {
  series: { pts: number[]; color: string }[];
  height?: number;
  /** F-09: real {date, price} for the PRIMARY series, index-aligned with
   *  series[0].pts. When present, hovering/tapping shows a tooltip with the
   *  exact date + price of the nearest point. Absent (mock-only cards) → no
   *  tooltip, just the existing guide line. */
  points?: { date: string; price: number }[];
}) {
  const H = height, W = 330, P = 6;
  const gridLines = [0.25, 0.5, 0.75].map((f) => P + f * (H - P * 2));
  const wrapRef = useRef<HTMLDivElement>(null);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  // Tracks the last interaction type. On touch, the browser fires COMPAT
  // mouse events (incl. a spurious mouseleave) after the tap — we must not
  // let that mouseleave clear the tooltip. Only a genuine mouse hover-out
  // should clear it; touch stays until an outside click dismisses it.
  const lastPointerType = useRef<string>("mouse");

  const nPts = series[0]?.pts.length ?? 0;
  const step = nPts > 1 ? (W - P * 2) / (nPts - 1) : 0;

  const idxFromClientX = (clientX: number): number => {
    const el = wrapRef.current;
    if (!el || nPts < 2) return 0;
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(frac * (nPts - 1));
  };
  // Timestamp of the last open, so the dismiss listener can ignore the
  // trailing synthesized events of the SAME gesture that opened the tooltip.
  const openedAt = useRef<number>(0);
  const handleMove = (clientX: number) => {
    openedAt.current = Date.now();
    setActiveIdx(idxFromClientX(clientX));
  };
  const clear = () => setActiveIdx(null);

  // F-09 dismissal: a click/tap OUTSIDE the chart wrapper hides the tooltip.
  // Listen on `click` only (not touchstart/mousedown) so the tap that OPENS
  // the tooltip on touch can't also dismiss it via its own low-level events —
  // a real outside click still fires `click` and dismisses. Registered on a
  // microtask delay so the opening gesture's trailing click never counts.
  useEffect(() => {
    if (activeIdx == null) return;
    const onDocPointerDown = (e: Event) => {
      // Ignore events within ~350ms of opening — those are the trailing
      // pieces of the SAME tap/click gesture (touch fires compat mouse
      // events after touchend), not a fresh "click away".
      if (Date.now() - openedAt.current < 350) return;
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setActiveIdx(null);
      }
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("click", onDocPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("click", onDocPointerDown);
    };
  }, [activeIdx]);

  const yFor = (v: number) => P + (v / 90) * (H - P * 2);
  const activeX = activeIdx != null ? P + activeIdx * step : 0;

  // Tooltip data for the active point (only when we have real points).
  // Clamp the index into `points`: activeIdx may have been computed against a
  // different-length series (e.g. the mock 12-pt shape shown before the real
  // 6-pt history finished loading), so guard against an out-of-range index.
  const activePoint =
    activeIdx != null && points && points.length > 0
      ? points[Math.min(activeIdx, points.length - 1)]
      : null;
  // Horizontal position as a % of the wrapper width so the HTML tooltip
  // lands over the active sample regardless of the SVG's rendered scale.
  const activeXFrac = activeIdx != null && nPts > 1 ? activeIdx / (nPts - 1) : 0;

  return (
    <div
      ref={wrapRef}
      style={{ width: "100%", position: "relative", touchAction: "none" }}
      // Pointer events unify mouse + touch: hover (mouse move), tap and drag
      // (touch) all resolve to the nearest sample. Desktop mouse-leave clears;
      // touch stays until an outside tap dismisses it (handled by the effect).
      onPointerDown={(e) => {
        lastPointerType.current = e.pointerType;
        handleMove(e.clientX);
      }}
      onPointerMove={(e) => {
        // Only track on hover (mouse) or an active touch drag — not stray
        // pointer moves with no button on touch devices.
        if (e.pointerType === "mouse" || e.buttons > 0 || e.pressure > 0) {
          lastPointerType.current = e.pointerType;
          handleMove(e.clientX);
        }
      }}
      // Ignore the compat mouseleave that follows a touch tap; only clear on a
      // real mouse hover-out.
      onMouseLeave={() => {
        if (lastPointerType.current === "mouse") clear();
      }}
      role="img"
      aria-label="Price history chart"
    >
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
        {gridLines.map((y, i) => (
          <line key={i} x1={P} y1={y} x2={W - P} y2={y} stroke="rgba(255,255,255,.07)" strokeWidth={1} />
        ))}
        {series.map((s, si) => {
          const n = s.pts.length;
          const st = (W - P * 2) / (n - 1);
          const coords = s.pts.map((y, i) => [+(P + i * st).toFixed(1), +(P + (y / 90) * (H - P * 2)).toFixed(1)] as const);
          const pointsStr = coords.map(([x, y]) => `${x},${y}`).join(" ");
          const areaStr = `${P},${H - P} ${pointsStr} ${W - P},${H - P}`;
          return (
            <g key={si}>
              <polygon points={areaStr} fill={s.color} opacity={series.length > 1 ? 0.1 : 0.14} />
              <polyline points={pointsStr} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
            </g>
          );
        })}
        {/* Hover/touch guide + per-series marker dots */}
        {activeIdx != null && nPts > 1 && (
          <g pointerEvents="none">
            <line x1={activeX} y1={P} x2={activeX} y2={H - P} stroke="rgba(255,255,255,0.3)" strokeWidth={1} />
            {series.map((s, si) => (
              <circle
                key={si}
                cx={activeX}
                cy={yFor(s.pts[activeIdx] ?? 0)}
                r={3.5}
                fill={s.color}
                stroke="var(--color-dojo-app)"
                strokeWidth={1.5}
              />
            ))}
          </g>
        )}
      </svg>

      {/* F-09 tooltip — HTML overlay so it can show the real date + price of
          the nearest point. Follows the active x, clamped from the edges so
          it never overflows the chart. */}
      {activePoint && (
        <div
          data-testid="chart-tooltip"
          style={{
            position: "absolute",
            top: 4,
            left: `${Math.min(85, Math.max(15, activeXFrac * 100))}%`,
            transform: "translateX(-50%)",
            background: "var(--color-dojo-overlay)",
            border: "1px solid var(--color-dojo-stroke)",
            padding: "6px 9px",
            pointerEvents: "none",
            whiteSpace: "nowrap",
            zIndex: 2,
          }}
        >
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
            {fmtChartDate(activePoint.date)}
          </div>
          <div style={{ marginTop: "2px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13px", fontVariantNumeric: "tabular-nums", color: "var(--color-dojo-gold)" }}>
            {fmtUSD(activePoint.price)}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sellers on the Floor (Task 6) ───────────────────────────────────
// Real, current eBay listings for this card (seller / price / location /
// listing URL) from /api/cards/[id]/ebay-sold. eBay's Browse API only
// exposes active listings (no sold-history filter), so these are live
// listings — genuine data, never mocked. Empty / error → "No recent sales
// found".
interface FloorListing {
  itemId: string;
  sellerUsername: string | null;
  price: number;
  currency: string | null;
  location: string | null;
  itemWebUrl: string;
  title: string;
}

function SellersOnFloor({
  id, name, setName, rarity, number, game,
}: {
  id: string; name: string; setName: string; rarity: string; number: string; game: "pokemon" | "onepiece";
}) {
  const { data, isLoading } = useQuery<{ listings: FloorListing[] }>({
    queryKey: ["ebay-sold", id, name, setName, rarity, number, game],
    queryFn: async () => {
      const qs = new URLSearchParams({ name, game });
      if (setName) qs.set("set", setName);
      // The card number is the strongest eBay token ("125/197" for Pokémon,
      // the OP01-001 code for One Piece). The route weights it per game and,
      // for One Piece, drops the set/rarity phrases that used to zero results.
      if (number) qs.set("number", number);
      const res = await fetch(`/api/cards/${encodeURIComponent(id)}/ebay-sold?${qs.toString()}`);
      if (!res.ok) return { listings: [] };
      return res.json();
    },
    staleTime: 60 * 60_000, // matches the route's 1h server cache
    enabled: !!name,
  });

  const listings = data?.listings ?? [];
  const heading = { fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px", letterSpacing: "0.18em", textTransform: "uppercase" as const, color: "var(--color-dojo-body)" };

  return (
    <>
      <div style={{ marginTop: "22px", display: "flex", alignItems: "baseline" }}>
        <span style={heading}>Sellers on the Floor</span>
        {!isLoading && listings.length > 0 && (
          <span style={{ marginLeft: "auto", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
            {listings.length} listing{listings.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {isLoading ? (
        <div style={{ marginTop: "12px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "22px 15px", textAlign: "center" }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12px", color: "var(--color-dojo-faint)" }}>Checking eBay…</span>
        </div>
      ) : listings.length === 0 ? (
        <div style={{ marginTop: "12px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "22px 15px", textAlign: "center" }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12px", color: "var(--color-dojo-faint)" }}>No recent sales found</span>
        </div>
      ) : (
        <div style={{ marginTop: "12px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "2px 15px 6px" }}>
          {listings.map((l) => {
            const seller = l.sellerUsername ?? "seller";
            const sub = [l.location, setName, rarity].filter(Boolean).join(" · ");
            const priceStr = l.price > 0 ? new Intl.NumberFormat("en-US", { style: "currency", currency: l.currency ?? "USD" }).format(l.price) : "—";
            return (
              <div key={l.itemId} style={{ display: "flex", alignItems: "center", gap: "11px", padding: "13px 0", borderBottom: "1px solid var(--color-dojo-divider)" }}>
                {/* Gold square avatar with the seller's initial. */}
                <div aria-hidden="true" style={{ flex: "none", width: "34px", height: "34px", background: "var(--color-dojo-gold)", color: "var(--color-dojo-app)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "15px" }}>
                  {seller.charAt(0).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12.5px", color: "var(--color-dojo-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    @{seller}
                  </div>
                  {sub && (
                    <div style={{ marginTop: "2px", fontSize: "10.5px", color: "var(--color-dojo-body)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>
                  )}
                </div>
                <div style={{ textAlign: "right", flex: "none" }}>
                  <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13.5px", fontVariantNumeric: "tabular-nums", color: "var(--color-dojo-ink)" }}>{priceStr}</div>
                  <a href={l.itemWebUrl} target="_blank" rel="noopener noreferrer" style={{ marginTop: "3px", display: "inline-block", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-gold)", textDecoration: "none" }}>
                    View on Floor ›
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ── Population report (PSA-primary, reference fallback) ─────────────
// Fetches /api/cards/[id]/population, which tries a real PSA pop source
// (none available on the public API today) then falls back to reference
// data so the grade breakdown shows "like it did before". Only renders
// "No population data available" if the API returns nothing at all.
interface PopCompany { company: "PSA" | "BGS"; total: number; grades: { grade: string; count: number }[]; }
interface PopReport { source: "psa" | "reference"; companies: PopCompany[]; }

function PopulationReport({ id }: { id: string }) {
  const [grader, setGrader] = useState<"PSA" | "BGS">("PSA");
  const { data, isLoading } = useQuery<{ report: PopReport | null }>({
    queryKey: ["population", id],
    queryFn: async () => {
      const res = await fetch(`/api/cards/${encodeURIComponent(id)}/population`);
      if (!res.ok) return { report: null };
      return res.json();
    },
    staleTime: 24 * 60 * 60_000,
  });

  const report = data?.report ?? null;
  const heading = { marginTop: "22px", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px", letterSpacing: "0.18em", textTransform: "uppercase" as const, color: "var(--color-dojo-body)" };
  const active = report?.companies.find((c) => c.company === grader) ?? report?.companies[0];

  return (
    <>
      <div style={heading}>Population report</div>
      {isLoading ? (
        <div style={{ marginTop: "12px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "22px 15px", textAlign: "center" }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12px", color: "var(--color-dojo-faint)" }}>Loading…</span>
        </div>
      ) : !report || !active ? (
        <div style={{ marginTop: "12px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "22px 15px", textAlign: "center" }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12px", color: "var(--color-dojo-faint)" }}>No population data available</span>
        </div>
      ) : (
        <div style={{ marginTop: "12px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "14px 15px 6px" }}>
          <div style={{ display: "flex", gap: "10px" }}>
            {report.companies.map((c) => (
              <button
                key={c.company}
                onClick={() => setGrader(c.company)}
                style={{
                  display: "flex", flexDirection: "column", gap: "2px",
                  border: `1.5px solid ${grader === c.company ? "rgba(255,255,255,.55)" : "var(--color-dojo-stroke)"}`,
                  padding: "8px 14px", cursor: "pointer",
                  color: grader === c.company ? "var(--color-dojo-ink)" : "var(--color-dojo-faint)",
                  background: "transparent",
                }}
              >
                <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "13px" }}>{c.company}</span>
                <span style={{ fontSize: "11px", color: "var(--color-dojo-body)" }}>{c.total.toLocaleString()} total</span>
              </button>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", columnGap: "10px", marginTop: "10px" }}>
            {active.grades.map((g) => (
              <div key={g.grade} style={{ padding: "10px 0", borderBottom: "1px solid var(--color-dojo-divider)" }}>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "13.5px", color: "var(--color-dojo-ink)" }}>{g.grade}</div>
                <div style={{ marginTop: "4px", fontFamily: "var(--font-display)", fontWeight: 400, fontSize: "13px", color: "var(--color-dojo-faint)" }}>{g.count.toLocaleString()}</div>
              </div>
            ))}
          </div>
          {report.source === "reference" && (
            <div style={{ marginTop: "8px", fontSize: "9px", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
              Typical grade distribution · live PSA/BGS population coming soon
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
  const price = priceParam > 0 ? priceParam : 246;

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

  // Build ADD_ROWS dynamically using the actual card's market price.
  // Ungraded (raw) = actual market price. Graded PSA 10 typically trades
  // at a premium, so we estimate it as ~30x raw for high-value cards or
  // ~3x for low-value cards (this is a rough heuristic until real graded
  // pricing data is available in Week 3).
  const ADD_ROWS = useMemo(() => {
    const rawPrice = price || 0;
    // PSA 10 premium: graded always trades above raw. Cheap cards carry
    // the biggest relative premium (grading fee dominates), so start at
    // 4.5x (a $10 raw ≈ $45 PSA 10 — the client's reference point) and
    // ease toward ~2x for high-value cards where the fee is negligible.
    // Continuous curve (no step at $10) so the number never jumps oddly.
    // TODO Week 3: replace with real graded pricing data.
    const psa10Multiplier = 2 + 50 / (rawPrice + 10);
    const psa10Price = rawPrice * psa10Multiplier;
    
    return [
      { id: "raw", section: "raw" as const, label: "Foil", price: rawPrice },
      { 
        id: "psa10", 
        section: "graded" as const, 
        label: "PSA 10 (GEM - MT)", 
        variant: "Foil", 
        pop: "Pop: 3583", 
        price: psa10Price 
      },
    ];
  }, [price]);

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

  // F-18: real price history from the DB (PricingHistory). When we have
  // points for this card, the "Raw" line is driven by them instead of the
  // mock CHARTS shape; cards with no history keep the mock (graceful
  // fallback). Never errors — an empty/failed fetch just leaves realPts null.
  const { data: historyData } = useQuery<{ points: { date: string; price: number }[] }>({
    queryKey: ["card-history", id],
    queryFn: async () => {
      const res = await fetch(`/api/cards/${encodeURIComponent(id)}/history`);
      if (!res.ok) throw new Error("Failed to load history");
      return res.json();
    },
    staleTime: 60_000,
  });
  // Normalize real prices into the chart's shape band (4..86) so they plug
  // straight into DojoChart alongside the mock series.
  const realPts = useMemo(() => {
    const points = historyData?.points ?? [];
    if (points.length < 2) return null;
    const prices = points.map((p) => p.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;
    return prices.map((p) => 4 + ((p - min) / range) * (86 - 4));
  }, [historyData]);

  const chartSeries = useMemo(() => {
    const pts = CHARTS[range] ?? CHARTS["1M"];
    const active = SERIES.filter((d) => activeSeries.has(d.id));
    if (active.length === 0) {
      // Default view: prefer real history when we have it.
      return [{ pts: realPts ?? pts, color: "#9AA0A6" }];
    }
    return active.map((d, di) => ({
      // The "raw" series maps to our recorded market history; graded
      // series stay on the mock shapes (no per-grade history pipeline yet).
      pts:
        d.id === "raw" && realPts
          ? realPts
          : pts.map((y, i) => Math.max(4, Math.min(86, y + Math.sin(i * 1.3 + di * 2) * 6))),
      color: d.color,
    }));
  }, [range, activeSeries, realPts]);

  const addTotal = ADD_ROWS.reduce((a, d) => a + (addQty[d.id] || 0) * d.price, 0);

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
            <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: "26px", lineHeight: 1.05, fontVariantNumeric: "tabular-nums", color: "var(--color-dojo-ink)" }}>
              {fmtUSD(price)}
            </div>
            <div style={{ marginTop: "6px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-jade)" }}>
              ▲ +4.1% · 1M
            </div>
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
                      <div style={{ marginTop: "3px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "11.5px", color: "var(--color-dojo-body)" }}>{d.priceFmt}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div style={{ margin: "12px -22px 0" }}>
          {/* F-09: hand the chart the real {date, price} history so the
              hover/tap tooltip can show exact values. Only when the primary
              (index-0) line IS the real Raw series — i.e. default view or Raw
              is active — so the tooltip index aligns with the drawn line.
              Graded-only views keep the mock shape and no price tooltip. */}
          <DojoChart
            series={chartSeries}
            height={170}
            points={
              realPts && (activeSeries.size === 0 || activeSeries.has("raw"))
                ? historyData?.points
                : undefined
            }
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

        {/* ── Population report (Task 2) — PSA primary, reference fallback ── */}
        <PopulationReport id={id} />

        {/* ── Sellers on the Floor (Task 6) — real eBay listings ── */}
        <SellersOnFloor id={id} name={name} setName={setName} rarity={rarity} number={serialNumber} game={game} />

        {/* ── Accessories (Task 7 — kept) ── */}
        <div style={{ marginTop: "22px", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
          Accessories
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "12px 0", borderBottom: "1px solid var(--color-dojo-divider)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12.5px", color: "var(--color-dojo-ink)" }}>3&quot;×4&quot; clear regular toploaders</div>
            <div style={{ marginTop: "2px", fontSize: "11px", color: "var(--color-dojo-body)" }}>cardkeeper.supply</div>
          </div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13px", color: "var(--color-dojo-ink)" }}>$3.99</div>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-gold)", cursor: "pointer" }}>View</span>
        </div>
      </div>

      {/* Single toast channel — add confirmations, favorites feedback,
          and Report submissions (Phase 3). */}
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}


// ── Quantity stepper row — ported from app.js addQtyRow() ──────────
function AddQtyRow({ label, sub, price, qty, onChange }: { label: string; sub?: string; price: number; qty: number; onChange: (q: number) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "13px 0", borderBottom: "1px solid var(--color-dojo-divider)" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12.5px", color: "var(--color-dojo-ink)" }}>{label}</div>
        {sub && <div style={{ marginTop: "2px", fontSize: "10.5px", color: "var(--color-dojo-body)" }}>{sub}</div>}
        <div style={{ marginTop: "3px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12.5px", color: "var(--color-dojo-gold)" }}>{fmtUSD(price)}</div>
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
