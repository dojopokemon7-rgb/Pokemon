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

import { useState, useMemo, Suspense } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";

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
  { id: "psa10", label: "PSA 10", grade: "10", group: "PSA", priceFmt: "$7.93K", color: "#E9B43B" },
  { id: "psa9", label: "PSA 9", grade: "9", group: "PSA", priceFmt: "$4.01K", color: "#0AC27E" },
  { id: "bgsbl", label: "BGS BL10", grade: "BL10", group: "BGS", priceFmt: "$42K", color: "#2D7FF9" },
  { id: "bgs10", label: "BGS 10", grade: "10", group: "BGS", priceFmt: "$9.77K", color: "#D400FF" },
  { id: "bgs9", label: "BGS 9", grade: "9", group: "BGS", priceFmt: "$5.2K", color: "#EE9A1F" },
];
const GROUPS = ["Raw", "PSA", "BGS"];

const POP = [
  { grader: "PSA", total: 983, cells: [["10", 945], ["9", 28], ["8", 4], ["7", 3]] },
  { grader: "BGS", total: 468, cells: [["BL10", 94], ["10", 367], ["9.5", 5], ["9", 2]] },
];

const ADD_ROWS = [
  { id: "raw", section: "raw" as const, label: "Foil", price: 14224.45 },
  { id: "psa10", section: "graded" as const, label: "PSA 10 (GEM - MT)", variant: "Foil", pop: "Pop: 3583", price: 7929.63 },
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
// (price-history can show up to 3 grade lines at once). ────────────
function DojoChart({ series, height = 170 }: { series: { pts: number[]; color: string }[]; height?: number }) {
  const H = height, W = 330, P = 6;
  const gridLines = [0.25, 0.5, 0.75].map((f) => P + f * (H - P * 2));
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
      {gridLines.map((y, i) => (
        <line key={i} x1={P} y1={y} x2={W - P} y2={y} stroke="rgba(255,255,255,.07)" strokeWidth={1} />
      ))}
      {series.map((s, si) => {
        const n = s.pts.length;
        const step = (W - P * 2) / (n - 1);
        const coords = s.pts.map((y, i) => [+(P + i * step).toFixed(1), +(P + (y / 90) * (H - P * 2)).toFixed(1)] as const);
        const pointsStr = coords.map(([x, y]) => `${x},${y}`).join(" ");
        const areaStr = `${P},${H - P} ${pointsStr} ${W - P},${H - P}`;
        return (
          <g key={si}>
            <polygon points={areaStr} fill={s.color} opacity={series.length > 1 ? 0.1 : 0.14} />
            <polyline points={pointsStr} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
          </g>
        );
      })}
    </svg>
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
  const price = priceParam > 0 ? priceParam : 246;

  const [flipped, setFlipped] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [starred, setStarred] = useState(false);
  const [wantToBuy, setWantToBuy] = useState(false);
  const [activeSeries, setActiveSeries] = useState<Set<string>>(new Set(["raw"]));
  const [range, setRange] = useState<string>("1M");
  const [addQty, setAddQty] = useState<Record<string, number>>({ raw: 0, psa10: 1 });
  const [popGrader, setPopGrader] = useState("PSA");

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

  const chartSeries = useMemo(() => {
    const pts = CHARTS[range] ?? CHARTS["1M"];
    const active = SERIES.filter((d) => activeSeries.has(d.id));
    if (active.length === 0) {
      return [{ pts, color: "#9AA0A6" }];
    }
    return active.map((d, di) => ({
      pts: pts.map((y, i) => Math.max(4, Math.min(86, y + Math.sin(i * 1.3 + di * 2) * 6))),
      color: d.color,
    }));
  }, [range, activeSeries]);

  const addTotal = ADD_ROWS.reduce((a, d) => a + (addQty[d.id] || 0) * d.price, 0);
  const pop = POP.find((p) => p.grader === popGrader) ?? POP[0];

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
                <div key={l} className="row" onClick={() => setMenuOpen(false)} style={{ fontSize: "12.5px" }}>
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
            onClick={() => setStarred((v) => !v)}
            title="Track this card"
            style={{
              flex: "none", width: "34px", height: "34px", fontSize: "16px",
              border: "1px solid " + (starred ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"),
              background: starred ? "var(--color-dojo-gold)" : "var(--color-dojo-app)",
              color: starred ? "#0D0D0D" : "var(--color-dojo-body)",
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", transition: "all 150ms",
            }}
          >
            {starred ? "★" : "☆"}
          </button>
        </div>
        <div style={{ marginTop: "8px", fontSize: "12.5px", color: "var(--color-dojo-body)" }}>
          {setName ? <>Trading Card Game · <span style={{ color: "var(--color-dojo-gold)" }}>{setName}</span></> : "Trading Card Game"}
        </div>
        <div style={{ marginTop: "3px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
          ID · {id}
        </div>

        <div style={{ marginTop: "16px", display: "flex", alignItems: "flex-end", gap: "12px" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: "26px", lineHeight: 1.05, fontVariantNumeric: "tabular-nums", color: "var(--color-dojo-ink)" }}>
              {fmtUSD(price)}
            </div>
            <div style={{ marginTop: "6px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "#00A86B" }}>
              ▲ +4.1% · 1M
            </div>
          </div>
          <button
            onClick={() => setWantToBuy((v) => !v)}
            style={{
              flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center",
              height: "38px", padding: "0 18px",
              border: wantToBuy ? "1.5px solid var(--color-dojo-gold)" : "1.5px solid var(--color-dojo-stroke)",
              background: wantToBuy ? "rgba(233,180,59,.1)" : "transparent",
              color: wantToBuy ? "var(--color-dojo-gold)" : "var(--color-dojo-faint)",
              cursor: "pointer", transition: "all 150ms", whiteSpace: "nowrap",
              fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "10.5px", letterSpacing: "0.14em",
            }}
          >
            {wantToBuy ? "✓ WANT TO BUY" : "WANT TO BUY"}
          </button>
        </div>

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
          <DojoChart series={chartSeries} height={170} />
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
          <div style={{ marginTop: "14px", textAlign: "right", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-gold)", cursor: "pointer" }}>
            + Add a graded card
          </div>
        </div>

        {/* ── Population report ── */}
        <div style={{ marginTop: "22px", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
          Population report
        </div>
        <div style={{ marginTop: "12px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "14px 15px 6px" }}>
          <div style={{ display: "flex", gap: "10px" }}>
            {POP.map((p) => (
              <button
                key={p.grader}
                onClick={() => setPopGrader(p.grader)}
                style={{
                  display: "flex", flexDirection: "column", gap: "2px",
                  border: `1.5px solid ${popGrader === p.grader ? "rgba(255,255,255,.55)" : "var(--color-dojo-stroke)"}`,
                  padding: "8px 14px", cursor: "pointer",
                  color: popGrader === p.grader ? "var(--color-dojo-ink)" : "var(--color-dojo-faint)",
                  background: "transparent",
                }}
              >
                <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "13px" }}>{p.grader}</span>
                <span style={{ fontSize: "11px", color: "var(--color-dojo-body)" }}>{p.total} total</span>
              </button>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", columnGap: "10px", marginTop: "10px" }}>
            {pop.cells.map(([g, n]) => (
              <div key={g} style={{ padding: "10px 0", borderBottom: "1px solid var(--color-dojo-divider)" }}>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "13.5px", color: "var(--color-dojo-ink)" }}>{g}</div>
                <div style={{ marginTop: "4px", fontFamily: "var(--font-display)", fontWeight: 400, fontSize: "13px", color: "var(--color-dojo-faint)" }}>{n}</div>
              </div>
            ))}
          </div>
        </div>

        <button className="dojo-btn dojo-btn-outline" style={{ marginTop: "22px", height: "44px" }}>
          SOLD LIST
        </button>

        {/* ── Accessories ── */}
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
