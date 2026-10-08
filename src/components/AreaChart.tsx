"use client";

/**
 * AreaChart — FAITHFUL TypeScript port of the design-system component
 * `dojo-design/dojo-design-system/components/feedback/AreaChart.jsx`.
 *
 * This is a DIRECT port, not a re-interpretation: gradient-fill area, three
 * horizontal gridlines at [0.25, 0.5, 0.75], a DASHED vertical hover guide,
 * r=4 circle markers with a card-surface ring, a no-shadow / no-blur / square
 * tooltip, an x-axis label row and (multi-series) a legend row, with the exact
 * viewBox 0 0 560 h and scaleCoords math (min = Math.min(0, …)).
 *
 * The design file's abstract tokens (--accent, --jade-500, …) are mapped to
 * the app's --color-dojo-* equivalents below. The only non-1:1 mapping is
 * --amber-500 → --color-dojo-gold: the app has no separate amber token, so the
 * single-gold substitution is intentional (see SERIES_PALETTE). --font-body in
 * the design maps to the app's body font var, which globals.css @theme names
 * --font-body (→ var(--font-ubuntu-sans), …).
 *
 * NeoPOP discipline (AGENTS.md rule 10): NO blur, NO glow, NO soft box-shadow —
 * the tooltip is a 1px --color-dojo-stroke border on --color-dojo-raised with
 * square corners and no shadow, exactly as the source.
 */

import { useState, useMemo } from "react";
import { formatCurrency, formatCurrencyCompact } from "@/lib/utils/format";

// Value at a Y gridline drawn fraction `f` from the TOP. scaleCoords maps
// y = h - ((v - min)/range)*h, so a gridline at y = h*f sits at
// VALUE = max - f*(max - min): f=0 → max (top), f=1 → min (bottom). The
// Y-axis labels (showYAxis) print these so the plot reads against real values.
export function valueAtFraction(f: number, max: number, min: number): number {
  return max - f * (max - min);
}

// Y-axis gridline fractions from the top: edges (0 = max, 1 = min) plus the
// three interior gridlines the chart already draws.
const Y_AXIS_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];

// Types ported verbatim from the design system's AreaChart.d.ts (same folder
// as AreaChart.jsx). Exported so the two app chart sites type their props.
export interface AreaChartDatum {
  [key: string]: string | number;
}
export interface AreaChartSeries {
  /** Key in each datum for this series' value. */
  valueKey: string;
  /** Legend/tooltip label. Defaults to valueKey. */
  label?: string;
  /** Explicit color override; otherwise auto-assigned from the brand palette. */
  color?: string;
}
export interface AreaChartProps {
  /** Array of data points, e.g. [{ label: "Jan", value: 186 }]. */
  data: AreaChartDatum[];
  /** Key in each datum used for the x-axis label. Default "label". */
  labelKey?: string;
  /** Key in each datum used for the plotted value (single-series mode). Default "value". */
  valueKey?: string;
  /** Multiple series to plot together — each gets its own color; overrides valueKey/trendColor. */
  series?: AreaChartSeries[];
  /** Line/fill color override for single-series mode. Defaults to trend color (green rising / red dipping). */
  color?: string;
  /** In single-series mode, color the line/fill green when the series rises overall and red when it dips. Default true. */
  trendColor?: boolean;
  /** Chart height in px. Default 220. */
  height?: number;
  /** Show horizontal gridlines. Default true. */
  showGrid?: boolean;
  /**
   * Accessible name for the chart. When set, the chart's outer container is
   * exposed as role="img" with this label, so screen readers announce the
   * otherwise-nameless <svg> (regression fix: the design-system port dropped
   * the old role="img"/aria-label). Optional — unlabeled charts render as
   * before (no role), so existing call sites are unaffected.
   */
  ariaLabel?: string;
  /**
   * Show numeric value labels on the horizontal gridlines (compact USD).
   * Default true — additive, so existing call sites get labels automatically.
   * Set false for non-currency COUNT axes (e.g. admin analytics) where a
   * "$…K" label would misrepresent the data.
   */
  showYAxis?: boolean;
}

// Design-token → app-token map (verified against src/app/globals.css @theme):
//   --accent         → --color-dojo-gold        (#E9B43B)
//   --jade-500       → --color-dojo-jade        (#0AC27E)
//   --verm-500       → --color-dojo-vermilion   (#EF4423)
//   --amber-500      → --color-dojo-gold        (no separate amber token — use gold)
//   --stroke-card    → --color-dojo-stroke
//   --stroke-strong  → --color-dojo-stroke-strong
//   --surface-card   → --color-dojo-card
//   --surface-raised → --color-dojo-raised
//   --text-faint     → --color-dojo-faint
//   --text-heading   → --color-dojo-ink
//   --font-body      → --font-body
const ACCENT = "var(--color-dojo-gold)";
const JADE = "var(--color-dojo-jade)";
const VERM = "var(--color-dojo-vermilion)";
const STROKE_CARD = "var(--color-dojo-stroke)";
const STROKE_STRONG = "var(--color-dojo-stroke-strong)";
const SURFACE_CARD = "var(--color-dojo-card)";
const SURFACE_RAISED = "var(--color-dojo-raised)";
const TEXT_FAINT = "var(--color-dojo-faint)";
const TEXT_HEADING = "var(--color-dojo-ink)";
const FONT_BODY = "var(--font-body)";

// SERIES_PALETTE mirrors the design file. --amber-500 collapses to gold (no
// amber token in this app); the two trailing hex values are design-literal.
const SERIES_PALETTE = [ACCENT, JADE, VERM, ACCENT, "#D400FF", "#2D7FF9"];

function scaleCoords(
  values: number[],
  w: number,
  h: number,
  max: number,
  min: number
): [number, number][] {
  const n = values.length;
  const range = max - min || 1;
  // n===1 would divide by zero → NaN; place a lone point mid-axis.
  if (n === 1) return [[w / 2, h - ((values[0] - min) / range) * h]];
  return values.map((v, i) => [(i / (n - 1)) * w, h - ((v - min) / range) * h]);
}

// Build a SMOOTH SVG path through the points (Catmull-Rom → cubic bezier) so a
// dense history line reads as a curve, not a jagged polyline. Falls back to a
// straight "M L" path for < 3 points. `k` is the smoothing tension (0.2 keeps
// it close to the data — no overshoot that would misrepresent prices).
function smoothLinePath(pts: [number, number][]): string {
  if (pts.length < 3) {
    return pts.map((c, i) => `${i === 0 ? "M" : "L"} ${c[0].toFixed(1)} ${c[1].toFixed(1)}`).join(" ");
  }
  const k = 0.2;
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + ((p2[0] - p0[0]) * k);
    const c1y = p1[1] + ((p2[1] - p0[1]) * k);
    const c2x = p2[0] - ((p3[0] - p1[0]) * k);
    const c2y = p2[1] - ((p3[1] - p1[1]) * k);
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

export function AreaChart({
  data,
  labelKey = "label",
  valueKey = "value",
  series,
  color,
  height = 220,
  showGrid = true,
  trendColor = true,
  ariaLabel,
  showYAxis = true,
}: AreaChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const w = 560;
  const h = height;
  const multi = Array.isArray(series) && series.length > 0;
  const keys = multi ? (series as AreaChartSeries[]).map((s) => s.valueKey) : [valueKey];
  const allValues = keys.flatMap((k) => data.map((d) => d[k] as number));
  const max = Math.max(...allValues);
  const min = Math.min(0, Math.min(...allValues));

  // Y-axis labels: additive overlay on the existing gridlines. Guard the
  // degenerate cases — <2 points or a flat/non-finite range would print a
  // column of identical (misleading) numbers or divide by zero — and render
  // nothing then, matching the chart's honest-flat-baseline behavior.
  const showYLabels =
    showYAxis &&
    data.length >= 2 &&
    Number.isFinite(max) &&
    Number.isFinite(min) &&
    max !== min;
  const yLabels = showYLabels
    ? Y_AXIS_FRACTIONS.map((f) => ({ f, text: formatCurrencyCompact(valueAtFraction(f, max, min)) }))
    : [];

  const gidBase = useMemo(() => "ac-" + Math.random().toString(36).slice(2, 9), []);

  // X-axis ticks: one label per data point is unreadable at scale (120 history
  // points → a smear of overlapping "Jul Jul Aug…" that doesn't line up with the
  // data). Subsample to at most MAX_TICKS evenly-spaced labels (first + last
  // always shown) so the axis is legible and the labels actually sit under the
  // points they name. Collapse consecutive duplicate labels to blank so a run of
  // same-month points doesn't repeat the month.
  const MAX_TICKS = 6;
  const tickIdx = useMemo(() => {
    const n = data.length;
    if (n <= MAX_TICKS) return data.map((_, i) => i);
    const step = (n - 1) / (MAX_TICKS - 1);
    return Array.from({ length: MAX_TICKS }, (_, k) => Math.round(k * step));
  }, [data]);
  const axisTicks = useMemo(() => {
    let prev = "";
    return tickIdx.map((i) => {
      const raw = String(data[i]?.[labelKey] ?? "");
      const label = raw === prev ? "" : raw;
      prev = raw;
      return { pct: data.length > 1 ? (i / (data.length - 1)) * 100 : 0, label };
    });
  }, [tickIdx, data, labelKey]);

  if (multi) {
    const seriesData = (series as AreaChartSeries[]).map((s, si) => ({
      ...s,
      color: s.color || SERIES_PALETTE[si % SERIES_PALETTE.length],
      coords: scaleCoords(
        data.map((d) => d[s.valueKey] as number),
        w,
        h,
        max,
        min
      ),
    }));
    return (
      <div
        style={{ width: "100%", maxWidth: w, fontFamily: FONT_BODY }}
        role={ariaLabel ? "img" : undefined}
        aria-label={ariaLabel}
      >
        <div style={{ position: "relative" }}>
          <svg
            viewBox={`0 0 ${w} ${h}`}
            width="100%"
            height={h}
            style={{ display: "block", overflow: "visible" }}
            onMouseLeave={() => setHover(null)}
          >
            <defs>
              {seriesData.map((s, si) => (
                <linearGradient key={si} id={`${gidBase}-${si}`} x1="0" y1="0" x2="0" y2="1">
                  {/* Multi-series: a faint fill so OVERLAPPING collection areas
                      don't stack into one solid blob — the distinct colored
                      LINES stay readable. Single-series keeps the fuller 0.3
                      fill (its own gradient below). */}
                  <stop offset="0%" stopColor={s.color} stopOpacity="0.12" />
                  <stop offset="100%" stopColor={s.color} stopOpacity="0" />
                </linearGradient>
              ))}
            </defs>
            {showGrid &&
              [0.25, 0.5, 0.75].map((f, i) => (
                <line key={i} x1={0} x2={w} y1={h * f} y2={h * f} stroke={STROKE_CARD} strokeWidth={1} />
              ))}
            {seriesData.map((s, si) => {
              const line = smoothLinePath(s.coords);
              const area = `${line} L ${w} ${h} L 0 ${h} Z`;
              return (
                <g key={si}>
                  <path d={area} fill={`url(#${gidBase}-${si})`} />
                  <path d={line} fill="none" stroke={s.color} strokeWidth={2} />
                </g>
              );
            })}
            {data.map((_, i) => (
              // Point selection: onMouseEnter drives desktop hover; the added
              // pointer/focus/click handlers let a mobile tap() (which has no
              // hover semantics) and keyboard focus select the same point.
              <rect
                key={i}
                x={(i / (data.length - 1)) * w - w / data.length / 2}
                y={0}
                width={w / data.length}
                height={h}
                fill="transparent"
                tabIndex={0}
                onMouseEnter={() => setHover(i)}
                onPointerDown={() => setHover(i)}
                onClick={() => setHover(i)}
                onFocus={() => setHover(i)}
                style={{ cursor: "crosshair" }}
              />
            ))}
            {hover !== null && (
              <line
                x1={seriesData[0].coords[hover][0]}
                x2={seriesData[0].coords[hover][0]}
                y1={0}
                y2={h}
                stroke={STROKE_STRONG}
                strokeWidth={1}
                strokeDasharray="3 3"
              />
            )}
            {hover !== null &&
              seriesData.map((s, si) => (
                <circle
                  key={si}
                  cx={s.coords[hover][0]}
                  cy={s.coords[hover][1]}
                  r={4}
                  fill={s.color}
                  stroke={SURFACE_CARD}
                  strokeWidth={2}
                />
              ))}
          </svg>
          {hover !== null && (
            <div
              data-testid="chart-tooltip"
              style={{
                position: "absolute",
                left: `${(seriesData[0].coords[hover][0] / w) * 100}%`,
                top: 0,
                transform:
                  seriesData[0].coords[hover][0] > w * 0.7
                    ? "translate(-100%, -8px)"
                    : "translate(8px, -8px)",
                background: SURFACE_RAISED,
                border: `1px solid ${STROKE_CARD}`,
                padding: "8px 12px",
                pointerEvents: "none",
                whiteSpace: "nowrap",
              }}
            >
              <div style={{ fontSize: 10, color: TEXT_FAINT, textTransform: "uppercase" }}>
                {data[hover][labelKey]}
              </div>
              {seriesData.map((s, si) => (
                <div
                  key={si}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 13,
                    color: TEXT_HEADING,
                    marginTop: 2,
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.color }} />
                  {s.label || s.valueKey}: {formatCurrency(data[hover][s.valueKey] as number)}
                </div>
              ))}
            </div>
          )}
          {yLabels.map(({ f, text }) => (
            <span
              key={f}
              style={{
                position: "absolute",
                left: 0,
                top: `${f * 100}%`,
                transform: "translateY(-50%)",
                fontSize: 11,
                color: TEXT_FAINT,
                whiteSpace: "nowrap",
                pointerEvents: "none",
              }}
            >
              {text}
            </span>
          ))}
        </div>
        <div style={{ position: "relative", height: 14, marginTop: 8 }}>
          {axisTicks.map((t, i) => (
            <span
              key={i}
              style={{
                position: "absolute",
                left: `${t.pct}%`,
                transform:
                  i === 0 ? "translateX(0)" : i === axisTicks.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
                fontSize: 11,
                color: TEXT_FAINT,
                whiteSpace: "nowrap",
              }}
            >
              {t.label}
            </span>
          ))}
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 12 }}>
          {seriesData.map((s, si) => (
            <div
              key={si}
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: TEXT_FAINT }}
            >
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.color }} />
              {s.label || s.valueKey}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const values = data.map((d) => d[valueKey] as number);
  const coords = scaleCoords(values, w, h, max, min);
  const rising = values[values.length - 1] >= values[0];
  const trendCol = color || (trendColor ? (rising ? JADE : VERM) : ACCENT);
  const line = smoothLinePath(coords);
  const area = `${line} L ${w} ${h} L 0 ${h} Z`;

  return (
    <div
      style={{ width: "100%", maxWidth: w, fontFamily: FONT_BODY }}
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
    >
      <div style={{ position: "relative" }}>
        <svg
          viewBox={`0 0 ${w} ${h}`}
          width="100%"
          height={h}
          style={{ display: "block", overflow: "visible" }}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={gidBase} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={trendCol} stopOpacity="0.35" />
              <stop offset="100%" stopColor={trendCol} stopOpacity="0" />
            </linearGradient>
          </defs>
          {showGrid &&
            [0.25, 0.5, 0.75].map((f, i) => (
              <line key={i} x1={0} x2={w} y1={h * f} y2={h * f} stroke={STROKE_CARD} strokeWidth={1} />
            ))}
          <path d={area} fill={`url(#${gidBase})`} />
          <path d={line} fill="none" stroke={trendCol} strokeWidth={2} />
          {coords.map((c, i) => (
            // Point selection: onMouseEnter drives desktop hover; the added
            // pointer/focus/click handlers let a mobile tap() (which has no
            // hover semantics) and keyboard focus select the same point.
            <rect
              key={i}
              x={c[0] - w / coords.length / 2}
              y={0}
              width={w / coords.length}
              height={h}
              fill="transparent"
              tabIndex={0}
              onMouseEnter={() => setHover(i)}
              onPointerDown={() => setHover(i)}
              onClick={() => setHover(i)}
              onFocus={() => setHover(i)}
              style={{ cursor: "crosshair" }}
            />
          ))}
          {hover !== null && (
            <>
              <line
                x1={coords[hover][0]}
                x2={coords[hover][0]}
                y1={0}
                y2={h}
                stroke={STROKE_STRONG}
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              <circle
                cx={coords[hover][0]}
                cy={coords[hover][1]}
                r={4}
                fill={trendCol}
                stroke={SURFACE_CARD}
                strokeWidth={2}
              />
            </>
          )}
        </svg>
        {hover !== null && (
          <div
            data-testid="chart-tooltip"
            style={{
              position: "absolute",
              left: `${(coords[hover][0] / w) * 100}%`,
              top: 0,
              transform:
                coords[hover][0] > w * 0.7 ? "translate(-100%, -8px)" : "translate(8px, -8px)",
              background: SURFACE_RAISED,
              border: `1px solid ${STROKE_CARD}`,
              padding: "8px 12px",
              pointerEvents: "none",
              whiteSpace: "nowrap",
            }}
          >
            <div style={{ fontSize: 10, color: TEXT_FAINT, textTransform: "uppercase" }}>
              {data[hover][labelKey]}
            </div>
            <div style={{ fontSize: 16, fontWeight: 800, fontStretch: "87%", color: TEXT_HEADING }}>
              {formatCurrency(data[hover][valueKey] as number)}
            </div>
          </div>
        )}
        {yLabels.map(({ f, text }) => (
          <span
            key={f}
            style={{
              position: "absolute",
              left: 0,
              top: `${f * 100}%`,
              transform: "translateY(-50%)",
              fontSize: 11,
              color: TEXT_FAINT,
              whiteSpace: "nowrap",
              pointerEvents: "none",
            }}
          >
            {text}
          </span>
        ))}
      </div>
      <div style={{ position: "relative", height: 14, marginTop: 8 }}>
        {axisTicks.map((t, i) => (
          <span
            key={i}
            style={{
              position: "absolute",
              left: `${t.pct}%`,
              transform:
                i === 0 ? "translateX(0)" : i === axisTicks.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
              fontSize: 11,
              color: TEXT_FAINT,
              whiteSpace: "nowrap",
            }}
          >
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}
