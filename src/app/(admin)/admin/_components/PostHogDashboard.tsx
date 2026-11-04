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
    const maxFunnel = Math.max(1, ...data.funnel.map((f) => f.users ?? 0));
    body = (
      <>
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

        <Heading>Funnel (unique users per step)</Heading>
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
                    {data.daily.map((d) => (
                      <tr key={d.date}>
                        <td className="py-1">{d.date}</td>
                        <td className="py-1 text-right">{fmt(d.pageviews)}</td>
                        <td className="py-1 text-right">{fmt(d.visitors)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
        <div className="dojo-faint" style={{ marginTop: "12px", fontSize: "11px" }}>
          Updated {new Date(data.fetchedAt).toLocaleString()} · cached up to 90s
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
