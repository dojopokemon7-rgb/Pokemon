"use client";

/**
 * Screen 08 — Search (Multi-Select, List View)
 *
 * Allows users to select multiple cards via checkboxes and add them to their collection.
 * - Sticky top summary: "{selectedCount} selected" + total market value
 * - Fixed bottom action bar: count, Clear, destination collection picker
 *   (default Main) and an explicit Add button (POST with onExisting:"skip").
 * - "Set details" (secondary) still routes to /collection/add.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useState, useMemo, Suspense } from "react";
import { setPendingCollectionCards } from "@/lib/utils/pending-collection";
import { isMainCollectionName } from "@/lib/utils/main-collection";

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
  // No forced "charizard" default: when reached from the Explore
  // landing there's no query, so we show the trending catalog instead
  // of pretending the user searched for Charizard.
  const initialQ = searchParams.get("q")?.trim() ?? "";
  const hasQuery = initialQ.length > 0;
  const game = searchParams.get("game") ?? "pokemon";

  const { data, isFetching } = useQuery<SearchApiResponse>({
    queryKey: ["card-multi", game, initialQ],
    queryFn: async () => {
      // With a query → search results. Without → the trending catalog,
      // normalized to the same { cards: [...] } shape the list expects.
      if (hasQuery) {
        const res = await fetch(
          `/api/cards/search?game=${game}&query=${encodeURIComponent(initialQ)}`
        );
        if (!res.ok) return { cards: [] };
        return res.json();
      }
      const res = await fetch(`/api/cards/trending?game=${game}&limit=50&sort=trending`);
      if (!res.ok) return { cards: [] };
      const json = await res.json();
      // Trending returns `setImage` for the set name and `externalId`;
      // map to the CardResult shape (id must be the externalId so the
      // add payload reuses the seeded card, matching the search grid).
      const cards: CardResult[] = (json.cards ?? []).map((c: {
        externalId?: string; id: string; name: string; setImage?: string;
        imageUrl?: string | null; price?: number | null;
      }) => ({
        id: c.externalId ?? c.id,
        name: c.name,
        setName: c.setImage ?? undefined,
        imageUrl: c.imageUrl ?? undefined,
        marketPrice: c.price ?? undefined,
      }));
      return { cards };
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

  // SELECTION order (Set keeps insertion order), one card per externalId —
  // the server stamps strictly-decreasing addedAt in this order.
  const selectedCards = useMemo(() => {
    const byId = new Map<string, CardResult>();
    for (const c of cards) if (!byId.has(c.id)) byId.set(c.id, c);
    return [...selectedIds].flatMap((id) => (byId.has(id) ? [byId.get(id) as CardResult] : []));
  }, [cards, selectedIds]);

  // Destination picker: ONLY real named /api/collections rows (the nameless
  // "__uncat__" pseudo-entry is dropped). Main first; when the user has no Main
  // yet, a "" option stands in for it and the server creates it on first add.
  const queryClient = useQueryClient();
  const { data: collections = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["collections"],
    queryFn: async () => {
      const res = await fetch("/api/collections", { credentials: "include" });
      if (!res.ok) return [];
      return (await res.json()).data ?? [];
    },
  });
  const destOptions = useMemo(() => {
    const named = collections.filter((c) => typeof c.name === "string" && c.name);
    const main = named.find((c) => isMainCollectionName(c.name));
    const rest = named.filter((c) => c !== main);
    return [main ?? { id: "", name: "Main" }, ...rest];
  }, [collections]);
  const [destOverride, setDestOverride] = useState<string | null>(null);
  const destId = destOverride ?? destOptions[0].id;

  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedTotal = useMemo(
    () =>
      selectedCards.reduce(
        (sum, c) => sum + (c.marketPrice ?? c.price ?? 0),
        0
      ),
    [selectedCards]
  );

  const toPayload = (c: CardResult) => ({
    externalId: c.id,
    name: c.name,
    setName: c.setName ?? c.set ?? undefined,
    imageUrl: c.imageUrl ?? c.image ?? undefined,
    marketPrice: c.marketPrice ?? c.price ?? null,
    quantity: 1,
    isFoil: false,
  });

  async function handleAddNow() {
    if (selectedCards.length === 0 || adding) return;
    setAdding(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/users/me/collection", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(destId ? { collectionId: destId } : {}),
          onExisting: "skip",
          cards: selectedCards.map(toPayload),
        }),
      });
      const json = await res.json().catch(() => ({}));
      const added = json.added ?? 0;
      const alreadyPresent = json.alreadyPresent ?? 0;
      if (!res.ok || added + alreadyPresent === 0) {
        // Selection is RETAINED so the user can retry.
        throw new Error(json.message ?? json.error ?? "Could not add these cards.");
      }
      queryClient.invalidateQueries({ queryKey: ["collection"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio-collection"] });
      queryClient.invalidateQueries({ queryKey: ["collections"] });
      setStatus(`${added} added, ${alreadyPresent} already in collection, ${json.invalid ?? 0} invalid`);
      // Keep only the items that failed selected; clear the rest.
      const failed = (json.results ?? []).filter((r: { ok: boolean }) => !r.ok).map((r: { externalId: string }) => r.externalId);
      setSelectedIds(new Set(failed));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setAdding(false);
    }
  }

  const handleAdd = () => {
    if (selectedIds.size === 0) return;
    setPendingCollectionCards(selectedCards.map(toPayload));
    router.push("/collection/add");
  };

  return (
    <div style={{ padding: "16px 22px 90px", minHeight: "100dvh" }}>
      {/* ── Top Header ── */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
        <Link
          href={hasQuery ? `/search?q=${encodeURIComponent(initialQ)}&game=${game}` : `/search?game=${game}`}
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

      {/* Result of the last Add (always mounted so screen readers announce it). */}
      <div role="status" aria-live="polite" style={{ fontSize: "12px", color: "var(--color-dojo-mint)", marginBottom: status ? "12px" : 0 }}>
        {status}
      </div>
      {error && (
        <div role="alert" style={{ border: "1px solid var(--color-dojo-vermilion)", padding: "10px 12px", marginBottom: "12px", fontSize: "12px", color: "var(--color-dojo-vermilion)" }}>
          {error}
        </div>
      )}

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
          cards.map((card, idx) => {
            const isSelected = selectedIds.has(card.id);
            const price = card.marketPrice ?? card.price ?? 0;
            const setName = card.setName ?? card.set ?? "";
            const initials = getInitials(card.name);
            const imgSrc = card.imageUrl ?? card.image;

            return (
              <div
                key={`${card.id}-${idx}`}
                role="checkbox"
                aria-checked={isSelected}
                aria-label={`Select ${card.name}`}
                tabIndex={0}
                onClick={() => toggleSelect(card.id)}
                onKeyDown={(e) => {
                  if (e.key === " " || e.key === "Enter") {
                    e.preventDefault();
                    toggleSelect(card.id);
                  }
                }}
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
                        stroke="var(--color-dojo-app)"
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

      {/* ── Fixed Bottom Selection Bar ──
          Only rendered once at least one card is selected — previously
          this bar was always mounted at 40% opacity, so the bottom of
          the list sat behind a dark translucent strip even when nothing
          was selected (Phase 1 QA: multi-selection screen overlay).
          Solid card background + z-index below the shell's nav (50). */}
      {selectedIds.size > 0 && (
        <div
          style={{
            position: "fixed",
            bottom: "70px",
            left: 0,
            right: 0,
            padding: "0 22px",
            zIndex: 45,
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
              animation: "dojo-fade-up 200ms ease-out both",
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

            <div style={{ marginLeft: "auto", display: "flex", flexDirection: "column", gap: "8px", alignItems: "flex-end" }}>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-dojo-gold)", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase" }}
                >
                  Clear
                </button>
                <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "10px", color: "var(--color-dojo-faint)" }}>
                  <span>Add to</span>
                  <select
                    aria-label="Destination collection"
                    value={destId}
                    onChange={(e) => setDestOverride(e.target.value)}
                    className="dojo-input"
                    style={{ height: "32px", maxWidth: "130px", fontSize: "12px" }}
                  >
                    {destOptions.map((c) => (
                      <option key={c.id || "main"} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <button
                  type="button"
                  onClick={handleAdd}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-dojo-body)", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase" }}
                >
                  Set details
                </button>
                <button
                  type="button"
                  onClick={handleAddNow}
                  disabled={adding || selectedIds.size === 0}
                  className="dojo-btn dojo-btn-primary"
                  style={{ padding: "10px 16px", fontSize: "11px", width: "auto" }}
                >
                  {adding ? "Adding…" : `Add ${selectedIds.size} card${selectedIds.size !== 1 ? "s" : ""}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
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
