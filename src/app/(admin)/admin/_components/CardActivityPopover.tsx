"use client";

/**
 * CardActivityPopover — lightweight admin drill-down for a single card_id from
 * the analytics dashboard (feed card cells + most-added / most-viewed /
 * most-wishlisted lists). NOT a full card page: it fetches
 * GET /api/admin/analytics/card and shows that card's PostHog aggregate (times
 * viewed / added + qty + summed USD / wishlisted) over the SELECTED
 * range+environment. Honest states (RULE 2): "not configured" / "unavailable" /
 * "—" for null metrics. Admin panel = Tailwind utilities allowed (AGENTS.md §10).
 *
 * The card_id is the catalog externalId (RULE 3). The server binds it into a
 * HogQL `{card_id}` placeholder (never interpolated). Row-capped + ~90s cached
 * in the service.
 */
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  CardActivityResult,
  AnalyticsRange,
  AnalyticsEnvironment,
} from "@/lib/services/posthog-query.service";

const fmt = (n: number | null | undefined, prefix = "") =>
  n === null || n === undefined
    ? "—"
    : `${prefix}${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        border: "1px solid var(--color-dojo-stroke)",
        padding: "12px 14px",
      }}
    >
      <div className="dojo-step-label" style={{ fontSize: "9px" }}>
        {label}
      </div>
      <div className="dojo-heading" style={{ fontSize: "20px", marginTop: "6px" }}>
        {value}
      </div>
    </div>
  );
}

export function CardActivityPopover({
  cardId,
  range,
  environment,
  onClose,
}: {
  cardId: string;
  range: AnalyticsRange;
  environment: AnalyticsEnvironment;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus the close button on open; Escape closes.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  const { data, isLoading, isError } = useQuery<CardActivityResult>({
    queryKey: ["admin-card-activity", cardId, range, environment],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/analytics/card?cardId=${encodeURIComponent(cardId)}&range=${range}&environment=${environment}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`card analytics ${res.status}`);
      return (await res.json()) as CardActivityResult;
    },
    staleTime: 60_000,
  });

  let body: React.ReactNode;
  if (isLoading) {
    body = <div className="dojo-faint">Loading card analytics…</div>;
  } else if (isError || !data || data.status === "unavailable") {
    body = <div className="dojo-faint">PostHog unavailable. Try again shortly.</div>;
  } else if (data.status === "not_configured") {
    body = <div className="dojo-faint">Analytics not configured.</div>;
  } else {
    const a = data.activity;
    body = (
      <div className="grid grid-cols-2 gap-3">
        <Metric label="Times viewed" value={fmt(a.viewed)} />
        <Metric label="Times added" value={fmt(a.added)} />
        <Metric label="Quantity added" value={fmt(a.addedQuantity)} />
        <Metric label="Added value (USD)" value={fmt(a.addedValueUsd, "$")} />
        <Metric label="Times wishlisted" value={fmt(a.wishlisted)} />
      </div>
    );
  }

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 90,
          background: "rgba(0,0,0,0.6)",
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Card analytics for ${cardId}`}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 91,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "22px",
          pointerEvents: "none",
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            pointerEvents: "auto",
            width: "100%",
            maxWidth: "420px",
            background: "var(--color-dojo-card)",
            border: "1px solid var(--color-dojo-stroke)",
            padding: "18px 20px 22px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "12px",
              marginBottom: "14px",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="dojo-step-label" style={{ fontSize: "9px" }}>
                Card analytics · {range} · {environment}
              </div>
              <h2
                className="dojo-heading"
                style={{ fontSize: "18px", margin: "4px 0 0", wordBreak: "break-word" }}
              >
                {cardId}
              </h2>
            </div>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close"
              title="Close"
              style={{
                flex: "none",
                width: "34px",
                height: "34px",
                border: "1px solid var(--color-dojo-stroke)",
                background: "var(--color-dojo-app)",
                color: "var(--color-dojo-ink)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="square"
                aria-hidden="true"
              >
                <line x1="3" y1="3" x2="13" y2="13" />
                <line x1="13" y1="3" x2="3" y2="13" />
              </svg>
            </button>
          </div>
          {body}
        </div>
      </div>
    </>
  );
}
