"use client";

/**
 * Add to Collection (/collection/add)
 *
 * Reads the cards queued by /search or /search/multi (see
 * src/lib/utils/pending-collection.ts) and actually persists them via
 * POST /api/users/me/collection. Previously this route was a static
 * "Batch Collection Import Flow coming in Week 3" placeholder — there
 * was no code path anywhere in the app that could turn a search
 * result into a real UserCollection row, which is why the Portfolio
 * and Dashboard "your cards" sections could never show anything real.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
  getPendingCollectionCards,
  clearPendingCollectionCards,
  type PendingCollectionCard,
} from "@/lib/utils/pending-collection";

interface AddCollectionResult {
  added: number;
  total: number;
  results: Array<{ externalId: string; ok: boolean; error?: string }>;
}

function fmtUSD(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

export default function CollectionAddPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [cards, setCards] = useState<PendingCollectionCard[] | null>(null);

  // Read the queued cards on mount (don't clear yet — React Strict Mode
  // calls useEffect twice in dev, so clearing on read would lose the data).
  useEffect(() => {
    setCards(getPendingCollectionCards());
  }, []);

  const totalValue = (cards ?? []).reduce(
    (sum, c) => sum + (c.marketPrice ?? 0) * c.quantity,
    0
  );

  const mutation = useMutation<AddCollectionResult, Error>({
    mutationFn: async () => {
      if (!cards || cards.length === 0) {
        throw new Error("No cards to add.");
      }
      const res = await fetch("/api/users/me/collection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cards }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.message ?? "Failed to add cards to your collection.");
      }
      return json;
    },
    onSuccess: () => {
      // Clear the pending cards now that they've been added
      clearPendingCollectionCards();
      // The dashboard and portfolio both read live collection data —
      // invalidate so they refetch and show the newly added cards
      // immediately instead of on next navigation.
      queryClient.invalidateQueries({ queryKey: ["collection"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio-collection"] });
    },
  });

  // Nothing queued (direct nav, refresh, or already submitted) — bounce
  // to search rather than showing an empty confirmation screen.
  if (cards !== null && cards.length === 0 && !mutation.isSuccess) {
    return (
      <div style={{ padding: "24px 22px", color: "var(--color-dojo-ink)" }}>
        <p className="dojo-heading" style={{ fontSize: "22px", marginBottom: "10px" }}>
          nothing to add
        </p>
        <p style={{ color: "var(--color-dojo-body)", fontSize: "13px", marginBottom: "24px" }}>
          your selection expired or was already added. head back to search to pick cards.
        </p>
        <Link href="/search" className="dojo-btn dojo-btn-primary" style={{ textDecoration: "none", display: "inline-flex" }}>
          BACK TO SEARCH
        </Link>
      </div>
    );
  }

  return (
    <div style={{ padding: "24px 22px 32px", color: "var(--color-dojo-ink)" }}>
      <button
        onClick={() => router.back()}
        disabled={mutation.isPending}
        style={{
          background: "none",
          border: "none",
          color: "var(--color-dojo-gold)",
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: "12px",
          cursor: "pointer",
          marginBottom: "20px",
          padding: 0,
        }}
      >
        ‹ Back
      </button>

      {mutation.isSuccess ? (
        // ── Success state ──
        <>
          <p className="dojo-heading" style={{ fontSize: "24px", marginBottom: "8px" }}>
            added to your collection
          </p>
          <p style={{ color: "var(--color-dojo-body)", fontSize: "14px", marginBottom: "24px" }}>
            {mutation.data.added} of {mutation.data.total} card
            {mutation.data.total !== 1 ? "s" : ""} added successfully.
          </p>
          {mutation.data.added < mutation.data.total && (
            <div style={{ background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-vermilion)", padding: "14px 16px", marginBottom: "20px" }}>
              <p style={{ fontSize: "12px", color: "var(--color-dojo-body)", margin: 0 }}>
                {mutation.data.total - mutation.data.added} card
                {mutation.data.total - mutation.data.added !== 1 ? "s" : ""} could not be added. You can try adding them again from search.
              </p>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <Link href="/portfolio" className="dojo-btn dojo-btn-primary" style={{ textDecoration: "none" }}>
              VIEW PORTFOLIO
            </Link>
            <Link href="/dashboard" className="dojo-btn dojo-btn-outline" style={{ textDecoration: "none" }}>
              GO TO DASHBOARD
            </Link>
          </div>
        </>
      ) : (
        // ── Review / confirm state ──
        <>
          <h1 className="dojo-heading" style={{ fontSize: "24px", marginBottom: "8px" }}>
            add to your collection
          </h1>
          <p style={{ color: "var(--color-dojo-body)", fontSize: "14px", marginBottom: "20px" }}>
            {cards === null
              ? "loading your selection…"
              : `adding ${cards.length} card${cards.length !== 1 ? "s" : ""} to your portfolio.`}
          </p>

          {cards && cards.length > 0 && (
            <>
              <div style={{ display: "flex", flexDirection: "column", marginBottom: "16px" }}>
                {cards.map((c) => (
                  <div
                    key={`${c.externalId}-${c.isFoil}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "12px",
                      padding: "11px 0",
                      borderBottom: "1px solid var(--color-dojo-divider)",
                    }}
                  >
                    <div
                      style={{
                        width: "36px",
                        height: "50px",
                        flex: "none",
                        background: "var(--color-dojo-raised)",
                        border: "1px solid var(--color-dojo-stroke)",
                        overflow: "hidden",
                      }}
                    >
                      {c.imageUrl && (
                        <img
                          src={c.imageUrl}
                          alt={c.name}
                          style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                      )}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13px", color: "var(--color-dojo-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {c.name}
                      </div>
                      {c.setName && (
                        <div style={{ marginTop: "2px", fontSize: "11px", color: "var(--color-dojo-body)" }}>
                          {c.setName}
                        </div>
                      )}
                    </div>
                    <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13px", fontVariantNumeric: "tabular-nums", color: c.marketPrice != null ? "var(--color-dojo-ink)" : "var(--color-dojo-faint)" }}>
                      {c.marketPrice != null ? fmtUSD(c.marketPrice) : "—"}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ display: "flex", alignItems: "center", padding: "12px 0", borderTop: "1px solid var(--color-dojo-stroke)", marginBottom: "24px" }}>
                <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontStretch: "112%", fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
                  Estimated total
                </span>
                <span style={{ marginLeft: "auto", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "16px", fontVariantNumeric: "tabular-nums", color: "var(--color-dojo-gold)" }}>
                  {fmtUSD(totalValue)}
                </span>
              </div>
            </>
          )}

          {mutation.isError && (
            <div style={{ background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-vermilion)", padding: "14px 16px", marginBottom: "20px" }}>
              <p className="dojo-error" style={{ margin: 0 }}>{mutation.error.message}</p>
            </div>
          )}

          <button
            onClick={() => mutation.mutate()}
            disabled={!cards || cards.length === 0 || mutation.isPending}
            className="dojo-btn dojo-btn-primary"
          >
            {mutation.isPending ? "ADDING…" : "ADD TO PORTFOLIO"}
          </button>
        </>
      )}
    </div>
  );
}
