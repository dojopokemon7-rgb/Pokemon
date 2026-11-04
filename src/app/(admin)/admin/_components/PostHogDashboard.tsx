"use client";

/**
 * PostHogDashboard — in-app PostHog product analytics for the admin.
 *
 * Fetches GET /api/admin/analytics (server holds the PostHog key; the browser
 * never sees it). Range + environment selectors. Honest states (RULE 2):
 * "Analytics not configured" / "PostHog unavailable" / "—" for null metrics.
 * Admin panel = Tailwind utilities allowed (AGENTS.md §10).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  AnalyticsResult,
  AnalyticsRange,
  AnalyticsEnvironment,
} from "@/lib/services/posthog-query.service";

const CARD_STYLE: React.CSSProperties = {
  background: "var(--color-dojo-card)",
  border: "1px solid var(--color-dojo-stroke)",
  padding: "20px",
};
const RANGES: AnalyticsRange[] = ["24h", "7d", "30d"];
const ENVS: AnalyticsEnvironment[] = ["production", "staging", "all"];

const fmt = (n: number | null, prefix = "") =>
  n === null ? "—" : `${prefix}${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

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

/** A simple two-column label/count table with an empty state. */
function CountTable({
  rows,
  head,
  empty = "No data in this range.",
}: {
  rows: { label: string; count: number }[];
  head: string;
  empty?: string;
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
                <td className="py-1" style={{ wordBreak: "break-word" }}>{r.label}</td>
                <td className="py-1 text-right">{fmt(r.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Ranked card table: card id + count (+ value when present). */
function CardTable({
  rows,
  countHead,
  showValue = false,
  empty = "No data in this range.",
}: {
  rows: { cardId: string; count: number; valueUsd: number | null }[];
  countHead: string;
  showValue?: boolean;
  empty?: string;
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
                <td className="py-1" style={{ wordBreak: "break-word" }}>{r.cardId}</td>
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
    body = (
      <>
        {/* ── OVERVIEW ─────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="Unique visitors" value={fmt(m.uniqueVisitors)} />
          <Stat label="Pageviews" value={fmt(m.pageviews)} />
          <Stat label="Signups" value={fmt(m.signups)} />
          <Stat label="Logins" value={fmt(m.logins)} />
          <Stat label="Cards added" value={fmt(m.cardsAdded)} />
          <Stat label="Cards added value (USD)" value={fmt(m.cardsAddedValueUsd, "$")} />
          <Stat label="Searches" value={fmt(m.searches)} />
          <Stat label="Zero-result searches" value={fmt(m.zeroResultSearches)} />
          <Stat label="Wishlist adds" value={fmt(m.wishlistAdds)} />
          <Stat label="Scans started" value={fmt(m.scansStarted)} />
          <Stat label="Scans succeeded" value={fmt(m.scansSucceeded)} />
          <Stat label="Errors ($exception)" value={fmt(m.errors)} />
        </div>

        {/* ── 1. RECENT ACTIVITY ───────────────────────────────────── */}
        <SectionHeading>Recent activity</SectionHeading>
        <div className="dojo-faint" style={{ fontSize: "11px", marginBottom: "8px" }}>
          Latest {d.recentActivity.length} business events, newest first.
        </div>
        <div style={{ ...CARD_STYLE, overflowX: "auto" }}>
          {d.recentActivity.length === 0 ? (
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
                {d.recentActivity.map((r, i) => (
                  <tr key={`${r.time}-${r.event}-${i}`}>
                    <td className="py-1 pr-3" style={{ whiteSpace: "nowrap" }}>{fmtTime(r.time)}</td>
                    <td className="py-1 pr-3">{r.email ?? "anonymous"}</td>
                    <td className="py-1 pr-3" style={{ whiteSpace: "nowrap" }}>{eventLabel(r.event)}</td>
                    <td className="py-1 pr-3" style={{ wordBreak: "break-word" }}>{r.detail ?? "—"}</td>
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

        {/* ── 2. SEARCH & DISCOVERY ────────────────────────────────── */}
        <SectionHeading>Search &amp; discovery</SectionHeading>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <Heading>Top search terms</Heading>
            <CountTable rows={d.search.topTerms} head="Query" empty="No searches in this range." />
          </div>
          <div>
            <Heading>Top zero-result searches (unmet demand)</Heading>
            <CountTable rows={d.search.zeroResult} head="Query" empty="No zero-result searches." />
          </div>
          <div>
            <Heading>Most-viewed cards</Heading>
            <CardTable rows={d.search.mostViewedCards} countHead="Views" empty="No card views." />
          </div>
          <div>
            <Heading>Filters applied</Heading>
            <CountTable rows={d.search.filterTypes} head="Filter" empty="No filters applied." />
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
            <CardTable rows={d.wishlist.mostWishlisted} countHead="Adds" empty="No wishlist adds." />
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
            <CountTable rows={d.scanner.failReasons} head="Reason" empty="No scan failures." />
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
            <CountTable rows={d.auth.signupsByMethod} head="Method" empty="No signups in this range." />
          </div>
          <div>
            <Heading>Logins by method</Heading>
            <CountTable rows={d.auth.loginsByMethod} head="Method" empty="No logins in this range." />
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
    </section>
  );
}
