/**
 * ExternalAnalyticsLinks — admin card linking out to the PostHog dashboard
 * (the deep product analytics / session replay that SaaS tool hosts,
 * complementing the first-party <AnalyticsDetail/> panel).
 *
 * Server-safe: reads only NEXT_PUBLIC_* env (public client keys, fine to read in
 * a server component — no "use client"). Admin panel = Tailwind utilities allowed
 * (AGENTS.md §10); matches AnalyticsDetail's CARD_STYLE / SectionHeading.
 *
 * Links open in a new tab (rel="noopener noreferrer"). When the PostHog key is
 * unset, we render a muted "Configure analytics keys to enable" state instead of
 * a broken link (RULE 2 — no fake/placeholder destinations).
 */

const CARD_STYLE: React.CSSProperties = {
  background: "var(--color-dojo-card)",
  border: "1px solid var(--color-dojo-stroke)",
  padding: "24px",
};

function posthogUrl(): string | null {
  // Prefer an exact project dashboard URL when the operator provides one.
  const explicit = process.env.NEXT_PUBLIC_POSTHOG_DASHBOARD_URL;
  if (explicit && explicit.trim() !== "") return explicit;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;
  if (host && host.trim() !== "") return host;
  return null;
}

function ProviderRow({
  name,
  note,
  url,
}: {
  name: string;
  note: string;
  url: string | null;
}) {
  return (
    <article style={CARD_STYLE}>
      <div
        className="dojo-step-label"
        style={{ fontSize: "10px", color: "var(--color-dojo-body)" }}
      >
        {name}
      </div>
      <div className="dojo-faint" style={{ marginTop: "6px" }}>
        {note}
      </div>
      <div style={{ marginTop: "16px" }}>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="dojo-btn dojo-btn-outline-sm"
            style={{ display: "inline-flex" }}
          >
            Open dashboard ↗
          </a>
        ) : (
          <div className="dojo-faint">Configure analytics keys to enable</div>
        )}
      </div>
    </article>
  );
}

export function ExternalAnalyticsLinks() {
  return (
    <section>
      <div
        className="dojo-step-label"
        style={{
          fontSize: "10px",
          marginBottom: "12px",
          color: "var(--color-dojo-body)",
        }}
      >
        External Analytics
      </div>
      <div className="grid grid-cols-1 gap-4">
        <ProviderRow
          name="PostHog"
          note="Product analytics, funnels, and event explorer"
          url={posthogUrl()}
        />

      </div>
    </section>
  );
}
