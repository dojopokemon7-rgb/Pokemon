"use client";

/**
 * Screen 08 — Search (Multi-Select, List View)
 *
 * Allows users to select multiple cards via checkboxes and add them to their collection.
 * - Sticky top summary: "{selectedCount} selected" + total market value
 * - Fixed bottom action bar: "ADD TO COLLECTION →" button
 * - Redirects to /collection/add when clicked
 */

import { useQuery } from "@tanstack/react-query";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useState, useMemo, Suspense } from "react";
import { setPendingCollectionCards } from "@/lib/utils/pending-collection";

interface CardResult {
  id: string;
  name: string;
  set?: string;
  setName?: string;
  imageUrl?: string;
  image?: string;
  marketPrice?: number;
  price?: number;
}

interface SearchApiResponse {
  cards: CardResult[];
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function SearchMultiInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialQ = searchParams.get("q") ?? "charizard";
  const game = searchParams.get("game") ?? "pokemon";

  const { data, isFetching } = useQuery<SearchApiResponse>({
    queryKey: ["card-search", game, initialQ],
    queryFn: async () => {
      const res = await fetch(
        `/api/cards/search?game=${game}&query=${encodeURIComponent(initialQ)}`
      );
      if (!res.ok) return { cards: [] };
      return res.json();
    },
  });

  const cards = data?.cards ?? [];

  // Selected card IDs state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectedCards = useMemo(
    () => cards.filter((c) => selectedIds.has(c.id)),
    [cards, selectedIds]
  );

  const selectedTotal = useMemo(
    () =>
      selectedCards.reduce(
        (sum, c) => sum + (c.marketPrice ?? c.price ?? 0),
        0
      ),
    [selectedCards]
  );

  const handleAdd = () => {
    if (selectedIds.size === 0) return;
    const cardsToAdd = selectedCards.map((c) => ({
      externalId: c.id,
      name: c.name,
      setName: c.setName ?? c.set ?? undefined,
      imageUrl: c.imageUrl ?? c.image ?? undefined,
      marketPrice: c.marketPrice ?? c.price ?? null,
      quantity: 1,
      isFoil: false,
    }));
    setPendingCollectionCards(cardsToAdd);
    router.push("/collection/add");
  };

  return (
    <div style={{ padding: "16px 22px 90px", minHeight: "100dvh" }}>
      {/* ── Top Header ── */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
        <Link
          href={`/search?q=${encodeURIComponent(initialQ)}&game=${game}`}
          style={{
            color: "var(--color-dojo-ink)",
            textDecoration: "none",
            display: "flex",
            alignItems: "center",
            gap: "4px",
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: "12px",
          }}
        >
          ‹ Back to Grid
        </Link>
      </div>

      {/* Query Title & Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: "14px", marginBottom: "16px" }}>
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontStretch: "112%",
            fontSize: "10px",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--color-dojo-faint)",
          }}
        >
          {isFetching ? "Searching..." : `${cards.length} results`}
        </div>

        <button
          onClick={() => {
            if (selectedIds.size === cards.length) {
              setSelectedIds(new Set());
            } else {
              setSelectedIds(new Set(cards.map((c) => c.id)));
            }
          }}
          style={{
            marginLeft: "auto",
            background: "none",
            border: "none",
            color: "var(--color-dojo-gold)",
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: "10px",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            cursor: "pointer",
          }}
        >
          {selectedIds.size === cards.length ? "Deselect All" : "Select All"}
        </button>
      </div>

      {/* List View */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        {isFetching ? (
          <div style={{ padding: "30px 0", textAlign: "center", color: "var(--color-dojo-body)" }}>
            Loading cards...
          </div>
        ) : cards.length === 0 ? (
          <div style={{ padding: "30px 0", textAlign: "center", color: "var(--color-dojo-body)" }}>
            No cards found.
          </div>
        ) : (
          cards.map((card) => {
            const isSelected = selectedIds.has(card.id);
            const price = card.marketPrice ?? card.price ?? 0;
            const setName = card.setName ?? card.set ?? "";
            const initials = getInitials(card.name);
            const imgSrc = card.imageUrl ?? card.image;

            return (
              <div
                key={card.id}
                onClick={() => toggleSelect(card.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "14px",
                  padding: "13px 0",
                  borderBottom: "1px solid var(--color-dojo-divider)",
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                {/* Checkbox — 150ms transition matches the reference's
                    .star/.plus toggle timing (dojo-prototype/styles.css),
                    smoother than the reference's own .check which has no
                    transition at all; chosen deliberately for a better feel,
                    see ANIMATION_SPECS.md. */}
                <div
                  style={{
                    width: "20px",
                    height: "20px",
                    border: isSelected
                      ? "1px solid var(--color-dojo-gold)"
                      : "1px solid var(--color-dojo-stroke)",
                    background: isSelected
                      ? "var(--color-dojo-gold)"
                      : "var(--color-dojo-card)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    transition: "background-color 150ms ease, border-color 150ms ease, transform 150ms ease",
                    transform: isSelected ? "scale(1)" : "scale(0.94)",
                  }}
                >
                  {isSelected && (
                    <svg width="12" height="10" viewBox="0 0 12 10" fill="none" style={{ animation: "dojo-fade-in 120ms ease-out" }}>
                      <path
                        d="M1 5L4.5 8.5L11 1.5"
                        stroke="#0D0D0D"
                        strokeWidth="2"
                        strokeLinecap="square"
                      />
                    </svg>
                  )}
                </div>

                {/* Thumbnail / Initials */}
                <div
                  style={{
                    width: "40px",
                    height: "40px",
                    flex: "none",
                    background: "var(--color-dojo-raised)",
                    border: "1px solid var(--color-dojo-stroke)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: "var(--font-display)",
                    fontWeight: 700,
                    fontSize: "12px",
                    color: "var(--color-dojo-gold)",
                    overflow: "hidden",
                  }}
                >
                  {imgSrc ? (
                    <img
                      src={imgSrc}
                      alt={card.name}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : (
                    initials
                  )}
                </div>

                {/* Name & Set */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: "var(--font-display)",
                      fontWeight: 700,
                      fontSize: "13.5px",
                      lineHeight: 1.3,
                      color: "var(--color-dojo-ink)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {card.name}
                  </div>
                  <div
                    style={{
                      marginTop: "3px",
                      fontSize: "11px",
                      color: "var(--color-dojo-body)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {setName}
                  </div>
                </div>

                {/* Price */}
                <div
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 800,
                    fontSize: "14px",
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--color-dojo-ink)",
                  }}
                >
                  {price > 0
                    ? new Intl.NumberFormat("en-US", {
                        style: "currency",
                        currency: "USD",
                      }).format(price)
                    : "—"}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ── Fixed Bottom Selection Bar ── */}
      <div
        style={{
          position: "fixed",
          bottom: "70px",
          left: 0,
          right: 0,
          padding: "0 22px",
          zIndex: 45,
          pointerEvents: selectedIds.size > 0 ? "auto" : "none",
        }}
      >
        <div
          style={{
            background: "var(--color-dojo-card)",
            border: "1px solid var(--color-dojo-stroke)",
            boxShadow: "4px 4px 0 0 #000",
            padding: "14px 16px",
            display: "flex",
            alignItems: "center",
            gap: "14px",
            opacity: selectedIds.size > 0 ? 1 : 0.4,
            transform: selectedIds.size > 0 ? "translateY(0)" : "translateY(6px)",
            transition: "opacity 0.2s ease, transform 0.2s ease",
          }}
        >
          <div>
            <div
              style={{
                fontFamily: "var(--font-display)",
                fontWeight: 700,
                fontStretch: "112%",
                fontSize: "10px",
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "var(--color-dojo-ink)",
              }}
            >
              {selectedIds.size} selected
            </div>
            <div
              style={{
                marginTop: "3px",
                fontFamily: "var(--font-display)",
                fontWeight: 800,
                fontSize: "14px",
                fontVariantNumeric: "tabular-nums",
                color: "var(--color-dojo-gold)",
              }}
            >
              {new Intl.NumberFormat("en-US", {
                style: "currency",
                currency: "USD",
              }).format(selectedTotal)}
            </div>
          </div>

          <div style={{ marginLeft: "auto" }}>
            <button
              onClick={handleAdd}
              disabled={selectedIds.size === 0}
              className="dojo-btn dojo-btn-primary"
              style={{ padding: "10px 16px", fontSize: "11px", width: "auto" }}
            >
              ADD TO COLLECTION →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function SearchMultiPage() {
  return (
    <Suspense
      fallback={
        <div style={{ padding: "16px 22px", color: "var(--color-dojo-body)" }}>
          Loading...
        </div>
      }
    >
      <SearchMultiInner />
    </Suspense>
  );
}
