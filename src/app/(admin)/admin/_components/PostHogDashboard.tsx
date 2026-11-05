"use client";

/**
 * PostHogDashboard — in-app PostHog product analytics for the admin.
 *
 * Fetches GET /api/admin/analytics (server holds the PostHog key; the browser
 * never sees it). Range + environment selectors. Honest states (RULE 2):
 * "Analytics not configured" / "PostHog unavailable" / "—" for null metrics.
 * Admin panel = Tailwind utilities allowed (AGENTS.md §10).
 *
 * WHO / WHAT BEHIND EVERY COUNT: the overview count cards are clickable. Clicking
 * one drills the Recent-activity feed down to just the rows behind that number
 * (via the `event` filter param → the server re-queries the TRUE rows for that
 * metric, not just whatever the default feed held) and scrolls to the feed. An
 * active-filter chip + the feed heading reflect the current drill-down, with a
 * one-click "Show all". Unique Visitors drills into the DISTINCT persons behind
 * the number (identified by email + an honest "anonymous (N)" remainder). Card
 * ids everywhere lead with the human-readable card NAME (id kept as a tooltip).
 *
 * PER-FEATURE DETAIL ROWS use the SAME feed reveal: clicking a label row in Top
 * search terms / Top zero-result searches / Filters applied / Scanner failure
 * reasons / Signups|Logins by method reveals the underlying events (who + when)
 * in the SAME feed via the `dimension`+`value` params (allowlisted dimension →
 * constant HogQL predicate; value placeholder-bound). Card lists (most-added/
 * -viewed/-wishlisted) keep the card popover. Pure ratio / by-game / funnel
 * rows stay static (no honest per-person drill). Only ONE reveal shows at once.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type {
  AnalyticsResult,
  AnalyticsRange,
  AnalyticsEnvironment,
  AnalyticsEventFilter,
  AnalyticsDimension,
  FilteredFeedResult,
  DimensionFeedResult,
  DistinctPersonsResult,
  ActivityRow,
  RetentionResult,
  SignupCohortsResult,
  SignupAttributionResult,
} from "@/lib/services/posthog-query.service";
import { CardActivityPopover } from "./CardActivityPopover";

const CARD_STYLE: React.CSSProperties = {
  background: "var(--color-dojo-card)",
  border: "1px solid var(--color-dojo-stroke)",
  padding: "20px",
};
const RANGES: AnalyticsRange[] = ["24h", "7d", "30d"];
const ENVS: AnalyticsEnvironment[] = ["production", "staging", "all"];

const fmt = (n: number | null, prefix = "") =>
  n === null ? "—" : `${prefix}${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** Percent cell: "42.5%" or an honest "—" for null (never a fabricated 0%). */
const fmtPct = (n: number | null) => (n === null ? "—" : `${n}%`);

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

// Friendly labels for raw event names in the activity feed (manager-oriented).
const EVENT_LABELS: Record<string, string> = {
  signup_started: "Signup started",
  signup_completed: "Signup completed",
  onboarding_completed: "Onboarding completed",
  login_completed: "Login",
  password_reset_requested: "Password reset requested",
  first_card_added: "First card added",
  portfolio_viewed: "Portfolio viewed",
  card_added: "Card added",
  card_removed: "Card removed",
  portfolio_chart_viewed: "Chart viewed",
  search_performed: "Search",
  card_viewed: "Card viewed",
  filter_applied: "Filter applied",
  wishlist_added: "Wishlist add",
  scan_started: "Scan started",
  scan_succeeded: "Scan succeeded",
  scan_failed: "Scan failed",
  $exception: "Error",
};
const eventLabel = (e: string) => EVENT_LABELS[e] ?? e;

/** Value cell: "$12.34" (+ " · ₹1,000" when a real INR value is present). */
const fmtValue = (usd: number | null, inr: number | null) => {
  if (usd === null && inr === null) return "—";
  const parts: string[] = [];
  if (usd !== null) parts.push(fmt(usd, "$"));
  if (inr !== null) parts.push(fmt(inr, "₹"));
  return parts.join(" · ") || "—";
};

// ── Count-card drill-down wiring ───────────────────────────────────────────
// A drill-down filter is either one of the server's allowlisted event filters
// or the special "persons" view behind Unique Visitors. `null` = show all.
type Drill = AnalyticsEventFilter | "persons" | null;

// Human labels for the active-filter chip + feed heading, per drill value.
const DRILL_LABELS: Record<AnalyticsEventFilter | "persons", string> = {
  persons: "Unique visitors",
  signup_completed: "Signups",
  login_completed: "Logins",
  card_added: "Cards added",
  search_performed: "Searches",
  zero_result: "Zero-result searches",
  wishlist_added: "Wishlist adds",
  scan_started: "Scans started",
  scan_succeeded: "Scans succeeded",
  $exception: "Errors",
};

// Per-feature DETAIL-ROW drill-down: clicking a label row in a per-feature list
// reveals the events behind it in the SAME feed (the ONE consistent label-row
// interaction). `value` is the row's label (the dynamic query/filter/method);
// `label` is the human heading for the chip + feed title.
type DimDrill = { dimension: AnalyticsDimension; value: string; label: string } | null;

// Feed events whose salient detail IS a card id (so the Detail cell is a
// clickable card drill-down). Mirrors the server's CARD_DETAIL_EVENTS
// (posthog-query.service.ts) — kept as a client-local literal so this client
// component never value-imports the server-only (ioredis) service module.
const CARD_DETAIL_EVENT_SET = new Set<string>([
  "card_added",
  "card_removed",
  "card_viewed",
  "wishlist_added",
  "scan_started",
  "scan_succeeded",
  "scan_failed",
]);

/** Clickable value for a card drill-down: name leads, raw id in the tooltip. */
function CardCell({
  cardId,
  cardName,
  onClick,
}: {
  cardId: string;
  cardName?: string | null;
  onClick: (id: string, name?: string | null) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(cardId, cardName)}
      title={cardName ? `${cardName} (${cardId}) — view card analytics` : `${cardId} — view card analytics`}
      className="dojo-link"
      style={{
        background: "none",
        border: "none",
        padding: 0,
        margin: 0,
        font: "inherit",
        color: "var(--color-dojo-gold)",
        cursor: "pointer",
        textAlign: "left",
        wordBreak: "break-word",
      }}
    >
      {cardName ?? cardId}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <article style={CARD_STYLE}>
      <div className="dojo-step-label" style={{ fontSize: "10px" }}>
        {label}
      </div>
      <div className="dojo-heading" style={{ fontSize: "26px", marginTop: "8px" }}>
        {value}
      </div>
    </article>
  );
}

/**
 * Clickable overview count card — looks and behaves like a button (hover lift,
 * pointer, focus ring, aria-pressed) and drills the feed to the rows behind the
 * number. Keyboard-accessible (real <button>). `active` highlights the current
 * drill-down.
 */
function StatButton({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={`Show the ${label.toLowerCase()} behind this number`}
      style={{
        ...CARD_STYLE,
        textAlign: "left",
        cursor: "pointer",
        width: "100%",
        outline: active ? "2px solid var(--color-dojo-gold)" : undefined,
        outlineOffset: active ? "-2px" : undefined,
      }}
      className="dojo-stat-button"
    >
      <div
        className="dojo-step-label"
        style={{ fontSize: "10px", display: "flex", alignItems: "center", gap: "6px" }}
      >
        {label}
        <span aria-hidden style={{ color: "var(--color-dojo-gold)", fontSize: "11px" }}>↓</span>
      </div>
      <div className="dojo-heading" style={{ fontSize: "26px", marginTop: "8px" }}>
        {value}
      </div>
    </button>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="dojo-step-label"
      style={{ fontSize: "10px", margin: "24px 0 12px", color: "var(--color-dojo-body)" }}
    >
      {children}
    </div>
  );
}

/** Section heading styled larger than the sub-`Heading` for feature blocks. */
function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="dojo-step-label"
      style={{ fontSize: "12px", margin: "32px 0 4px", color: "var(--color-dojo-body)" }}
    >
      {children}
    </div>
  );
}

/**
 * A simple two-column label/count table with an empty state. When `onRowClick`
 * is given, each label becomes an accessible drill button (reveals the events
 * behind that row in the feed); without it the labels stay plain text (used for
 * by-game / ratio tables that have no honest per-person drill).
 */
function CountTable({
  rows,
  head,
  empty = "No data in this range.",
  onRowClick,
  rowTitle,
}: {
  rows: { label: string; count: number }[];
  head: string;
  empty?: string;
  onRowClick?: (label: string) => void;
  rowTitle?: (label: string) => string;
}) {
  return (
    <div style={CARD_STYLE}>
      {rows.length === 0 ? (
        <div className="dojo-faint">{empty}</div>
      ) : (
        <table className="w-full dojo-body" style={{ fontSize: "13px" }}>
          <thead>
            <tr className="dojo-faint text-left">
              <th className="py-1 font-normal">{head}</th>
              <th className="py-1 text-right font-normal">Count</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td className="py-1" style={{ wordBreak: "break-word" }}>
                  {onRowClick ? (
                    <button
                      type="button"
                      onClick={() => onRowClick(r.label)}
                      title={rowTitle ? rowTitle(r.label) : `Show who/when behind "${r.label}"`}
                      className="dojo-link"
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        margin: 0,
                        font: "inherit",
                        color: "var(--color-dojo-gold)",
                        cursor: "pointer",
                        textAlign: "left",
                        wordBreak: "break-word",
                      }}
                    >
                      {r.label}
                    </button>
                  ) : (
                    r.label
                  )}
                </td>
                <td className="py-1 text-right">{fmt(r.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Ranked card table: card name (id tooltip) + count (+ value when present). */
function CardTable({
  rows,
  countHead,
  showValue = false,
  empty = "No data in this range.",
  onCardClick,
}: {
  rows: { cardId: string; count: number; valueUsd: number | null; cardName?: string | null }[];
  countHead: string;
  showValue?: boolean;
  empty?: string;
  onCardClick: (cardId: string, cardName?: string | null) => void;
}) {
  return (
    <div style={CARD_STYLE}>
      {rows.length === 0 ? (
        <div className="dojo-faint">{empty}</div>
      ) : (
        <table className="w-full dojo-body" style={{ fontSize: "13px" }}>
          <thead>
            <tr className="dojo-faint text-left">
              <th className="py-1 font-normal">Card</th>
              <th className="py-1 text-right font-normal">{countHead}</th>
              {showValue && <th className="py-1 text-right font-normal">Value (USD)</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.cardId}>
                <td className="py-1" style={{ wordBreak: "break-word" }}>
                  <CardCell cardId={r.cardId} cardName={r.cardName} onClick={onCardClick} />
                </td>
                <td className="py-1 text-right">{fmt(r.count)}</td>
                {showValue && (
                  <td className="py-1 text-right">{fmt(r.valueUsd, "$")}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * D1 / D7 / D30 first-seen retention (audit item 3). Honest "—" per bucket when
 * the cohort is too small/empty; "PostHog unavailable" / "not configured" fold
 * into the empty state. Each bucket is a % of the people old enough to reach it.
 */
function RetentionBlock({ result }: { result: RetentionResult }) {
  if (result.status !== "ok") {
    return (
      <div style={CARD_STYLE}>
        <div className="dojo-faint">
          {result.status === "not_configured" ? "Analytics not configured." : "Retention unavailable."}
        </div>
      </div>
    );
  }
  const cells: { label: string; value: number | null }[] = [
    { label: "D1", value: result.d1 },
    { label: "D7", value: result.d7 },
    { label: "D30", value: result.d30 },
  ];
  return (
    <div style={CARD_STYLE}>
      <div className="dojo-faint" style={{ fontSize: "11px", marginBottom: "12px" }}>
        Of {fmt(result.cohortSize)} people anchored on their first activity, the share active again
        on each later day.
      </div>
      <div className="grid grid-cols-3 gap-4">
        {cells.map((c) => (
          <div key={c.label}>
            <div className="dojo-step-label" style={{ fontSize: "10px" }}>
              {c.label}
            </div>
            <div className="dojo-heading" style={{ fontSize: "22px", marginTop: "6px" }}>
              {fmtPct(c.value)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Weekly signup-cohort retention table (audit item 4): signup week, cohort
 * size, and the % returning in each following week (1-4). "—" for not-yet-
 * observable or empty cells — never a fabricated 0%.
 */
function SignupCohortTable({ result }: { result: SignupCohortsResult }) {
  if (result.status !== "ok") {
    return (
      <div style={CARD_STYLE}>
        <div className="dojo-faint">
          {result.status === "not_configured" ? "Analytics not configured." : "Cohorts unavailable."}
        </div>
      </div>
    );
  }
  if (result.cohorts.length === 0) {
    return (
      <div style={CARD_STYLE}>
        <div className="dojo-faint">No signup cohorts yet.</div>
      </div>
    );
  }
  const weekCount = Math.max(...result.cohorts.map((c) => c.returns.length), 0);
  return (
    <div style={{ ...CARD_STYLE, overflowX: "auto" }}>
      <table className="w-full dojo-body" style={{ fontSize: "13px" }}>
        <thead>
          <tr className="dojo-faint text-left">
            <th className="py-1 pr-3 font-normal">Signup week</th>
            <th className="py-1 pr-3 text-right font-normal">Size</th>
            {Array.from({ length: weekCount }, (_, i) => (
              <th key={i} className="py-1 pr-3 text-right font-normal">
                W{i + 1}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.cohorts.map((c) => (
            <tr key={c.week}>
              <td className="py-1 pr-3" style={{ whiteSpace: "nowrap" }}>{c.week}</td>
              <td className="py-1 pr-3 text-right">{fmt(c.size)}</td>
              {Array.from({ length: weekCount }, (_, i) => (
                <td key={i} className="py-1 pr-3 text-right">
                  {fmtPct(c.returns[i] ?? null)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Signup conversion by initial-touch UTM (audit item 5): three breakdown tables
 * (source / medium / campaign). Missing UTM shows as a "direct / none" row
 * (never blank). Instagram / Comic Con QR / campaign traffic appear via
 * whatever the initial-touch props carry.
 */
function AttributionTables({ result }: { result: SignupAttributionResult }) {
  if (result.status !== "ok") {
    return (
      <div style={CARD_STYLE}>
        <div className="dojo-faint">
          {result.status === "not_configured"
            ? "Analytics not configured."
            : "Attribution unavailable."}
        </div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <div>
        <Heading>Source</Heading>
        <CountTable rows={result.bySource} head="Source" empty="No signups in this range." />
      </div>
      <div>
        <Heading>Medium</Heading>
        <CountTable rows={result.byMedium} head="Medium" empty="No signups in this range." />
      </div>
      <div>
        <Heading>Campaign</Heading>
        <CountTable rows={result.byCampaign} head="Campaign" empty="No signups in this range." />
      </div>
    </div>
  );
}

/** The activity-feed table (shared by the default feed and the drill-down). */
function ActivityTable({
  rows,
  onCardClick,
}: {
  rows: ActivityRow[];
  onCardClick: (cardId: string, cardName?: string | null) => void;
}) {
  return (
    <div style={{ ...CARD_STYLE, overflowX: "auto" }}>
      {rows.length === 0 ? (
        <div className="dojo-faint">No activity in this range.</div>
      ) : (
        <table className="w-full dojo-body" style={{ fontSize: "13px" }}>
          <thead>
            <tr className="dojo-faint text-left">
              <th className="py-1 pr-3 font-normal">Time</th>
              <th className="py-1 pr-3 font-normal">User</th>
              <th className="py-1 pr-3 font-normal">Action</th>
              <th className="py-1 pr-3 font-normal">Detail</th>
              <th className="py-1 pr-3 text-right font-normal">Value</th>
              <th className="py-1 font-normal">Env</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.time}-${r.event}-${i}`}>
                <td className="py-1 pr-3" style={{ whiteSpace: "nowrap" }}>{fmtTime(r.time)}</td>
                <td className="py-1 pr-3">
                  {r.email == null ? (
                    "anonymous"
                  ) : r.userId ? (
                    // Resolved email→user id server-side → drill into the user.
                    // No id (anonymous / deleted) → plain text.
                    <Link href={`/admin/users/${r.userId}`} className="dojo-link">
                      {r.email}
                    </Link>
                  ) : (
                    r.email
                  )}
                </td>
                <td className="py-1 pr-3" style={{ whiteSpace: "nowrap" }}>{eventLabel(r.event)}</td>
                <td className="py-1 pr-3" style={{ wordBreak: "break-word" }}>
                  {r.detail == null ? (
                    "—"
                  ) : CARD_DETAIL_EVENT_SET.has(r.event) ? (
                    <CardCell cardId={r.detail} cardName={r.cardName} onClick={onCardClick} />
                  ) : (
                    r.detail
                  )}
                </td>
                <td className="py-1 pr-3 text-right" style={{ whiteSpace: "nowrap" }}>
                  {fmtValue(r.valueUsd, r.valueInr)}
                </td>
                <td className="py-1">{r.environment ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: T[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex gap-1">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={o === value}
          onClick={() => onChange(o)}
          className={o === value ? "dojo-btn" : "dojo-btn dojo-btn-outline-sm"}
          style={{ padding: "6px 12px", fontSize: "12px" }}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

export function PostHogDashboard() {
  const [range, setRange] = useState<AnalyticsRange>("7d");
  const [environment, setEnvironment] = useState<AnalyticsEnvironment>("production");
  // Active count-card drill-down (null = show the full default feed).
  const [drill, setDrill] = useState<Drill>(null);
  // Active per-feature DETAIL-ROW drill-down (null = none). Mutually exclusive
  // with `drill` — only one reveal shows at a time.
  const [dimDrill, setDimDrill] = useState<DimDrill>(null);
  // Card drill-down popover: the open card, or null.
  const [openCard, setOpenCard] = useState<{ id: string; name?: string | null } | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  // Changing range/env clears any active drill-down (the old filter may not
  // apply to the new window; keeps the view honest and tidy).
  useEffect(() => {
    setDrill(null);
    setDimDrill(null);
  }, [range, environment]);

  const openCardPopover = (id: string, name?: string | null) => setOpenCard({ id, name });

  const scrollToFeed = () =>
    requestAnimationFrame(() => feedRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));

  // Click a count card: set the count-card drill-down (clearing any row drill)
  // and scroll the feed into view.
  const onCountClick = (d: Drill) => {
    setDimDrill(null);
    setDrill(d);
    scrollToFeed();
  };

  // Click a per-feature label row: set the row drill-down (clearing any
  // count-card drill) and scroll to the feed.
  const onDimClick = (dimension: AnalyticsDimension, value: string, label: string) => {
    setDrill(null);
    setDimDrill({ dimension, value, label });
    scrollToFeed();
  };

  const { data, isLoading, isError } = useQuery<AnalyticsResult>({
    queryKey: ["admin-posthog", range, environment],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/analytics?range=${range}&environment=${environment}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`analytics ${res.status}`);
      return (await res.json()) as AnalyticsResult;
    },
    staleTime: 60_000,
  });

  // Drill-down feed (event filter) — only fetched when an event drill is active.
  const eventDrill = drill && drill !== "persons" ? drill : null;
  const feedQuery = useQuery<FilteredFeedResult>({
    queryKey: ["admin-posthog-feed", eventDrill, range, environment],
    enabled: eventDrill !== null,
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/analytics?event=${encodeURIComponent(eventDrill as string)}&range=${range}&environment=${environment}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`feed ${res.status}`);
      return (await res.json()) as FilteredFeedResult;
    },
    staleTime: 60_000,
  });

  // Distinct-persons drill-down — only fetched for the Unique Visitors drill.
  const personsQuery = useQuery<DistinctPersonsResult>({
    queryKey: ["admin-posthog-persons", range, environment],
    enabled: drill === "persons",
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/analytics?view=persons&range=${range}&environment=${environment}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`persons ${res.status}`);
      return (await res.json()) as DistinctPersonsResult;
    },
    staleTime: 60_000,
  });

  // Per-feature DETAIL-ROW drill-down feed — only fetched when a row drill is
  // active. The dynamic `value` is URL-encoded (and bound via a HogQL
  // placeholder server-side, never interpolated into SQL).
  const dimFeedQuery = useQuery<DimensionFeedResult>({
    queryKey: ["admin-posthog-dimfeed", dimDrill?.dimension, dimDrill?.value, range, environment],
    enabled: dimDrill !== null,
    queryFn: async () => {
      const dd = dimDrill as NonNullable<DimDrill>;
      const res = await fetch(
        `/api/admin/analytics?dimension=${encodeURIComponent(dd.dimension)}&value=${encodeURIComponent(dd.value)}&range=${range}&environment=${environment}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`dimfeed ${res.status}`);
      return (await res.json()) as DimensionFeedResult;
    },
    staleTime: 60_000,
  });

  let body: React.ReactNode;
  if (isLoading) {
    body = <div className="dojo-faint">Loading PostHog analytics…</div>;
  } else if (isError || !data || data.status === "unavailable") {
    body = <div className="dojo-faint">PostHog unavailable. Try again shortly.</div>;
  } else if (data.status === "not_configured") {
    body = (
      <div className="dojo-faint">
        Analytics not configured. Set POSTHOG_PERSONAL_API_KEY on the server
        (see docs/ANALYTICS_SETUP.md).
      </div>
    );
  } else {
    const m = data.metrics;
    const d = data.detail;
    const maxFunnel = Math.max(1, ...data.funnel.map((f) => f.users ?? 0));

    // ── The Recent-activity section, honouring the active drill-down ───────
    let feedSection: React.ReactNode;
    if (dimDrill) {
      const r = dimFeedQuery.data;
      const rows = r && r.status === "ok" ? r.rows : [];
      feedSection = (
        <>
          <FilterChip label={dimDrill.label} onClear={() => setDimDrill(null)} />
          <div className="dojo-faint" style={{ fontSize: "11px", margin: "0 0 8px" }}>
            {dimFeedQuery.isLoading
              ? "Loading…"
              : r && r.status !== "ok"
                ? "PostHog unavailable."
                : `${dimDrill.label} — ${rows.length} event${rows.length === 1 ? "" : "s"}, newest first.`}
          </div>
          <ActivityTable rows={rows} onCardClick={openCardPopover} />
        </>
      );
    } else if (drill === "persons") {
      feedSection = (
        <PersonsPanel query={personsQuery} total={m.uniqueVisitors} onClear={() => setDrill(null)} />
      );
    } else if (eventDrill) {
      const label = DRILL_LABELS[eventDrill];
      const r = feedQuery.data;
      const rows = r && r.status === "ok" ? r.rows : [];
      feedSection = (
        <>
          <FilterChip label={label} onClear={() => setDrill(null)} />
          <div className="dojo-faint" style={{ fontSize: "11px", margin: "0 0 8px" }}>
            {feedQuery.isLoading
              ? "Loading…"
              : r && r.status !== "ok"
                ? "PostHog unavailable."
                : `${label} — ${rows.length} event${rows.length === 1 ? "" : "s"}, newest first.`}
          </div>
          <ActivityTable rows={rows} onCardClick={openCardPopover} />
        </>
      );
    } else {
      feedSection = (
        <>
          <div className="dojo-faint" style={{ fontSize: "11px", marginBottom: "8px" }}>
            Latest {d.recentActivity.length} business events, newest first. Click any count
            above to see just the rows behind it.
          </div>
          <ActivityTable rows={d.recentActivity} onCardClick={openCardPopover} />
        </>
      );
    }

    body = (
      <>
        {/* ── OVERVIEW (clickable → drill the feed) ─────────────────── */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatButton label="Unique visitors" value={fmt(m.uniqueVisitors)} active={drill === "persons"} onClick={() => onCountClick("persons")} />
          {/* Pageviews are $pageview (anonymous page loads), not a business
              event — no honest per-row feed, so it stays a plain stat. */}
          <Stat label="Pageviews" value={fmt(m.pageviews)} />
          <StatButton label="Signups" value={fmt(m.signups)} active={drill === "signup_completed"} onClick={() => onCountClick("signup_completed")} />
          <StatButton label="Logins" value={fmt(m.logins)} active={drill === "login_completed"} onClick={() => onCountClick("login_completed")} />
          <StatButton label="Cards added" value={fmt(m.cardsAdded)} active={drill === "card_added"} onClick={() => onCountClick("card_added")} />
          <StatButton label="Cards added value (USD)" value={fmt(m.cardsAddedValueUsd, "$")} active={drill === "card_added"} onClick={() => onCountClick("card_added")} />
          <StatButton label="Searches" value={fmt(m.searches)} active={drill === "search_performed"} onClick={() => onCountClick("search_performed")} />
          <StatButton label="Zero-result searches" value={fmt(m.zeroResultSearches)} active={drill === "zero_result"} onClick={() => onCountClick("zero_result")} />
          <StatButton label="Wishlist adds" value={fmt(m.wishlistAdds)} active={drill === "wishlist_added"} onClick={() => onCountClick("wishlist_added")} />
          <StatButton label="Scans started" value={fmt(m.scansStarted)} active={drill === "scan_started"} onClick={() => onCountClick("scan_started")} />
          <StatButton label="Scans succeeded" value={fmt(m.scansSucceeded)} active={drill === "scan_succeeded"} onClick={() => onCountClick("scan_succeeded")} />
          <StatButton label="Errors ($exception)" value={fmt(m.errors)} active={drill === "$exception"} onClick={() => onCountClick("$exception")} />
        </div>

        {/* ── ACTIVE USERS (distinct PEOPLE, de-duped across sessions) ── */}
        <SectionHeading>Active users (distinct people)</SectionHeading>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="Daily active users" value={fmt(m.dau)} />
          <Stat label="Weekly active users" value={fmt(m.wau)} />
          <article style={CARD_STYLE}>
            <div className="dojo-step-label" style={{ fontSize: "10px" }}>
              Weekly active collectors
            </div>
            <div className="dojo-heading" style={{ fontSize: "26px", marginTop: "8px" }}>
              {fmt(m.weeklyActiveCollectors)}
            </div>
            <div className="dojo-faint" style={{ fontSize: "10px", marginTop: "6px" }}>
              Distinct people who added or removed a card in the last 7 days
            </div>
          </article>
        </div>

        {/* ── RETENTION & SIGNUP ATTRIBUTION (audit items 3-5) ───────── */}
        <SectionHeading>Retention &amp; acquisition</SectionHeading>
        <Heading>Retention (D1 / D7 / D30)</Heading>
        <RetentionBlock result={data.retention} />
        <Heading>Weekly signup cohorts (% returning)</Heading>
        <SignupCohortTable result={data.signupCohorts} />
        <Heading>Signup conversion by acquisition source</Heading>
        <AttributionTables result={data.signupAttribution} />

        {/* ── 1. RECENT ACTIVITY (drill-down target) ───────────────── */}
        <div ref={feedRef}>
          <SectionHeading>Recent activity</SectionHeading>
          {feedSection}
        </div>

        {/* ── 2. SEARCH & DISCOVERY ────────────────────────────────── */}
        <SectionHeading>Search &amp; discovery</SectionHeading>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <Heading>Top search terms</Heading>
            <CountTable
              rows={d.search.topTerms}
              head="Query"
              empty="No searches in this range."
              onRowClick={(label) => onDimClick("search_term", label, `Search “${label}”`)}
              rowTitle={(label) => `Show who searched “${label}” and when`}
            />
          </div>
          <div>
            <Heading>Top zero-result searches (unmet demand)</Heading>
            <CountTable
              rows={d.search.zeroResult}
              head="Query"
              empty="No zero-result searches."
              onRowClick={(label) => onDimClick("zero_result_term", label, `Zero-result “${label}”`)}
              rowTitle={(label) => `Show who hit the dead end for “${label}”`}
            />
          </div>
          <div>
            <Heading>Most-viewed cards</Heading>
            <CardTable rows={d.search.mostViewedCards} countHead="Views" empty="No card views." onCardClick={openCardPopover} />
          </div>
          <div>
            <Heading>Filters applied</Heading>
            <CountTable
              rows={d.search.filterTypes}
              head="Filter"
              empty="No filters applied."
              onRowClick={(label) => onDimClick("filter_type", label, `Filter: ${label}`)}
              rowTitle={(label) => `Show who applied the ${label} filter and when`}
            />
          </div>
          <div>
            <Heading>Searches by game</Heading>
            <CountTable rows={d.search.byGame} head="Game" empty="No searches in this range." />
          </div>
        </div>

        {/* ── 3. PORTFOLIO / COLLECTION ────────────────────────────── */}
        <SectionHeading>Portfolio &amp; collection</SectionHeading>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <Heading>Most-added cards</Heading>
            <CardTable
              rows={d.portfolio.mostAdded}
              countHead="Qty"
              showValue
              empty="No cards added in this range."
              onCardClick={openCardPopover}
            />
          </div>
          <div>
            <Heading>Cards removed</Heading>
            <div style={CARD_STYLE}>
              <div className="dojo-heading" style={{ fontSize: "26px" }}>{fmt(d.portfolio.cardsRemoved)}</div>
            </div>
            <Heading>Raw vs graded</Heading>
            <CountTable rows={d.portfolio.conditionSplit} head="Condition" empty="No adds in this range." />
          </div>
          <div>
            <Heading>Adds by game</Heading>
            <CountTable rows={d.portfolio.byGame} head="Game" empty="No adds in this range." />
          </div>
          <div>
            <Heading>Chart range popularity</Heading>
            <CountTable rows={d.portfolio.chartRanges} head="Range" empty="No chart views." />
          </div>
        </div>

        {/* ── 4. WISHLIST ──────────────────────────────────────────── */}
        <SectionHeading>Wishlist</SectionHeading>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <Heading>Most-wishlisted cards</Heading>
            <CardTable rows={d.wishlist.mostWishlisted} countHead="Adds" empty="No wishlist adds." onCardClick={openCardPopover} />
          </div>
          <div>
            <Heading>Wishlist by game</Heading>
            <CountTable rows={d.wishlist.byGame} head="Game" empty="No wishlist adds." />
          </div>
        </div>

        {/* ── 5. SCANNER ───────────────────────────────────────────── */}
        <SectionHeading>Scanner</SectionHeading>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="Scans started" value={fmt(d.scanner.started)} />
          <Stat label="Succeeded" value={fmt(d.scanner.succeeded)} />
          <Stat label="Failed" value={fmt(d.scanner.failed)} />
          <Stat label="Success rate" value={d.scanner.successRate === null ? "—" : `${d.scanner.successRate}%`} />
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <Heading>Failure reasons</Heading>
            <CountTable
              rows={d.scanner.failReasons}
              head="Reason"
              empty="No scan failures."
              onRowClick={(label) => onDimClick("scan_reason", label, `Scan failure: ${label}`)}
              rowTitle={(label) => `Show who hit the “${label}” scan failure and when`}
            />
          </div>
          <div>
            <Heading>Scans by game</Heading>
            <CountTable rows={d.scanner.byGame} head="Game" empty="No scans in this range." />
          </div>
        </div>

        {/* ── 6. AUTH & ACTIVATION ─────────────────────────────────── */}
        <SectionHeading>Auth &amp; activation</SectionHeading>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="Onboarding completed" value={fmt(d.auth.onboardingCompleted)} />
          <Stat label="Password resets" value={fmt(d.auth.passwordResetRequested)} />
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <Heading>Signups by method</Heading>
            <CountTable
              rows={d.auth.signupsByMethod}
              head="Method"
              empty="No signups in this range."
              onRowClick={(label) => onDimClick("signup_method", label, `Signups · ${label}`)}
              rowTitle={(label) => `Show who signed up via ${label} and when`}
            />
          </div>
          <div>
            <Heading>Logins by method</Heading>
            <CountTable
              rows={d.auth.loginsByMethod}
              head="Method"
              empty="No logins in this range."
              onRowClick={(label) => onDimClick("login_method", label, `Logins · ${label}`)}
              rowTitle={(label) => `Show who logged in via ${label} and when`}
            />
          </div>
        </div>
        <Heading>Activation funnel (unique users per step)</Heading>
        <div style={CARD_STYLE}>
          {data.funnel.map((f) => (
            <div key={f.label} className="mb-3 last:mb-0">
              <div className="flex justify-between dojo-body" style={{ fontSize: "13px" }}>
                <span>{f.label}</span>
                <span>{fmt(f.users)}</span>
              </div>
              <div style={{ background: "var(--color-dojo-stroke)", height: "6px", marginTop: "4px" }}>
                <div
                  style={{
                    width: `${((f.users ?? 0) / maxFunnel) * 100}%`,
                    height: "6px",
                    background: "var(--color-dojo-body)",
                  }}
                />
              </div>
            </div>
          ))}
        </div>

        {/* ── 7. ENGAGEMENT / QUALITY ──────────────────────────────── */}
        <SectionHeading>Engagement &amp; quality</SectionHeading>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="Errors ($exception)" value={fmt(d.engagement.errorCount)} />
        </div>
        <Heading>Recent errors</Heading>
        <div style={{ ...CARD_STYLE, overflowX: "auto" }}>
          {d.engagement.recentErrors.length === 0 ? (
            <div className="dojo-faint">No errors in this range.</div>
          ) : (
            <table className="w-full dojo-body" style={{ fontSize: "13px" }}>
              <thead>
                <tr className="dojo-faint text-left">
                  <th className="py-1 pr-3 font-normal">Time</th>
                  <th className="py-1 pr-3 font-normal">Type</th>
                  <th className="py-1 font-normal">Message</th>
                </tr>
              </thead>
              <tbody>
                {d.engagement.recentErrors.map((e, i) => (
                  <tr key={`${e.time}-${i}`}>
                    <td className="py-1 pr-3" style={{ whiteSpace: "nowrap" }}>{fmtTime(e.time)}</td>
                    <td className="py-1 pr-3">{e.type ?? "—"}</td>
                    <td className="py-1" style={{ wordBreak: "break-word" }}>{e.message ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <Heading>Top events</Heading>
            <div style={CARD_STYLE}>
              {data.topEvents.length === 0 ? (
                <div className="dojo-faint">No events in this range.</div>
              ) : (
                <table className="w-full dojo-body" style={{ fontSize: "13px" }}>
                  <tbody>
                    {data.topEvents.map((e) => (
                      <tr key={e.event}>
                        <td className="py-1">{e.event}</td>
                        <td className="py-1 text-right">{fmt(e.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          <div>
            <Heading>Daily trend</Heading>
            <div style={CARD_STYLE}>
              {data.daily.length === 0 ? (
                <div className="dojo-faint">No data in this range.</div>
              ) : (
                <table className="w-full dojo-body" style={{ fontSize: "13px" }}>
                  <thead>
                    <tr className="dojo-faint text-left">
                      <th className="py-1 font-normal">Day</th>
                      <th className="py-1 text-right font-normal">Pageviews</th>
                      <th className="py-1 text-right font-normal">Visitors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.daily.map((pt) => (
                      <tr key={pt.date}>
                        <td className="py-1">{pt.date}</td>
                        <td className="py-1 text-right">{fmt(pt.pageviews)}</td>
                        <td className="py-1 text-right">{fmt(pt.visitors)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
        <div className="dojo-faint" style={{ marginTop: "12px", fontSize: "11px" }}>
          Updated {new Date(data.fetchedAt).toLocaleString()} · cached up to 90s ·
          deep drill-down, session replay and ad-hoc queries stay in PostHog (link below)
        </div>
      </>
    );
  }

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="dojo-step-label" style={{ fontSize: "10px", color: "var(--color-dojo-body)" }}>
          Product Analytics (PostHog)
        </div>
        <div className="flex flex-wrap gap-4">
          <Segmented label="Range" options={RANGES} value={range} onChange={setRange} />
          <Segmented label="Environment" options={ENVS} value={environment} onChange={setEnvironment} />
        </div>
      </div>
      {body}
      {openCard !== null && (
        <CardActivityPopover
          cardId={openCard.id}
          cardName={openCard.name}
          range={range}
          environment={environment}
          onClose={() => setOpenCard(null)}
        />
      )}
    </section>
  );
}

/** Active-filter chip above the feed with a one-click "Show all". */
function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <div
      className="dojo-body"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "10px",
        border: "1px solid var(--color-dojo-gold)",
        padding: "5px 6px 5px 12px",
        margin: "8px 0",
        fontSize: "12px",
      }}
    >
      <span>
        Filtered to <strong>{label}</strong>
      </span>
      <button
        type="button"
        onClick={onClear}
        className="dojo-btn dojo-btn-outline-sm"
        style={{ padding: "3px 10px", fontSize: "11px" }}
      >
        Show all
      </button>
    </div>
  );
}

/**
 * Unique-Visitors drill-down: the DISTINCT persons behind the number —
 * identified ones by email (linking to their user page) + an honest
 * "anonymous (N)" remainder. Never fabricates an identity.
 */
function PersonsPanel({
  query,
  total,
  onClear,
}: {
  query: { data?: DistinctPersonsResult; isLoading: boolean };
  total: number | null;
  onClear: () => void;
}) {
  const r = query.data;
  const ok = r && r.status === "ok" ? r : null;
  const identified = ok ? ok.identified : [];
  const anonymous = ok ? ok.anonymous : 0;
  // All three are on the SAME person axis (see posthog-query.service) so they
  // reconcile: total = identifiedCount + anonymous. The headline uses the
  // authoritative derived identifiedCount, NOT the (possibly capped) list
  // length — so "8 / 2 / 0" can't reappear. Prefer the result's person-axis
  // total over the prop (which is the metrics card's uniq(distinct_id)).
  const totalPersons = ok ? ok.total : total;
  const identifiedCount = ok ? ok.identifiedCount : 0;
  // The drill-down list can be capped at PERSONS_LIMIT; stay honest about it.
  const capped = identified.length < identifiedCount;
  return (
    <>
      <FilterChip label="Unique visitors" onClear={onClear} />
      <div className="dojo-faint" style={{ fontSize: "11px", margin: "0 0 8px" }}>
        {query.isLoading
          ? "Loading…"
          : r && r.status !== "ok"
            ? "PostHog unavailable."
            : `${fmt(totalPersons)} distinct visitor${totalPersons === 1 ? "" : "s"} · ${identifiedCount} identified · ${anonymous} anonymous`}
      </div>
      <div style={{ ...CARD_STYLE, overflowX: "auto" }}>
        {!query.isLoading && identifiedCount === 0 && anonymous === 0 ? (
          <div className="dojo-faint">No visitors in this range.</div>
        ) : (
          <table className="w-full dojo-body" style={{ fontSize: "13px" }}>
            <thead>
              <tr className="dojo-faint text-left">
                <th className="py-1 font-normal">Visitor</th>
              </tr>
            </thead>
            <tbody>
              {identified.map((p) => (
                <tr key={p.email}>
                  <td className="py-1" style={{ wordBreak: "break-word" }}>
                    {p.userId ? (
                      <Link href={`/admin/users/${p.userId}`} className="dojo-link">
                        {p.email}
                      </Link>
                    ) : (
                      p.email
                    )}
                  </td>
                </tr>
              ))}
              {capped && (
                <tr>
                  <td className="py-1 dojo-faint">
                    showing {identified.length} of {identifiedCount} identified
                  </td>
                </tr>
              )}
              {anonymous > 0 && (
                <tr>
                  <td className="py-1 dojo-faint">anonymous ({anonymous})</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
