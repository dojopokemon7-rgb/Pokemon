"use client";

/**
 * Compare Collections (F-22) — side-by-side stats on the /you page.
 *
 * Reuses the pure `compareCollections` util (which itself builds on the
 * F-11 aggregator) so the numbers match the dashboard. Fewer than two
 * collections → a prompt to add one; otherwise two selectors drive a
 * side-by-side Total Value / Card Count view.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  compareCollections,
  canCompare,
  NEEDS_MORE_COLLECTIONS_MESSAGE,
  type ComparableItem,
} from "@/lib/utils/compare-collections";

interface Collection {
  id: string;
  name: string;
}

interface CollectionItem {
  quantity: number;
  purchasePrice: number | null;
  collectionId: string | null;
  card: { marketPrice: number | null };
}

async function fetchCollections(): Promise<Collection[]> {
  const res = await fetch("/api/collections", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load collections");
  return (await res.json()).data as Collection[];
}

async function fetchItems(): Promise<ComparableItem[]> {
  const res = await fetch("/api/users/me/collection", { credentials: "include" });
  if (!res.ok) return [];
  const { items } = (await res.json()) as { items: CollectionItem[] };
  return (items ?? []).map((i) => ({
    quantity: i.quantity,
    purchasePrice: i.purchasePrice,
    collectionId: i.collectionId ?? null,
    card: { marketPrice: i.card?.marketPrice ?? null },
  }));
}

const sectionHeading: React.CSSProperties = {
  marginTop: "22px",
  fontFamily: "var(--font-display)",
  fontWeight: 800,
  fontSize: "11px",
  letterSpacing: "0.18em",
  textTransform: "uppercase",
  color: "var(--color-dojo-body)",
};

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

function StatCard({ title, value, count }: { title: string; value: number; count: number }) {
  return (
    <div
      data-testid="compare-side"
      style={{
        flex: 1,
        minWidth: 0,
        border: "1px solid var(--color-dojo-divider)",
        padding: "14px",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12px",
          color: "var(--color-dojo-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}
      >
        {title}
      </div>
      <div style={{ marginTop: "10px", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "20px", color: "var(--color-dojo-gold)", fontVariantNumeric: "tabular-nums" }}>
        {usd(value)}
      </div>
      <div style={{ marginTop: "2px", fontSize: "11px", color: "var(--color-dojo-faint)", fontVariantNumeric: "tabular-nums" }}>
        {count} card{count !== 1 ? "s" : ""}
      </div>
    </div>
  );
}

export function CompareCollectionsSection() {
  const { data: collections = [], isLoading } = useQuery({
    queryKey: ["collections"],
    queryFn: fetchCollections,
  });
  const { data: items = [] } = useQuery({
    queryKey: ["collection-items-compare"],
    queryFn: fetchItems,
  });

  const [idA, setIdA] = useState("");
  const [idB, setIdB] = useState("");

  const nameOf = (id: string) => collections.find((c) => c.id === id)?.name ?? id;

  return (
    <div>
      <div style={sectionHeading}>Compare Collections</div>

      {isLoading ? (
        <p className="dojo-body" style={{ marginTop: "8px" }}>Loading…</p>
      ) : !canCompare(collections.length) ? (
        <p data-testid="compare-needs-more" className="dojo-body" style={{ marginTop: "8px" }}>
          {NEEDS_MORE_COLLECTIONS_MESSAGE}
        </p>
      ) : (
        <>
          <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <label className="dojo-label" htmlFor="compare-a">Collection A</label>
              <select
                id="compare-a"
                aria-label="Collection A"
                className="dojo-input"
                value={idA}
                onChange={(e) => setIdA(e.target.value)}
              >
                <option value="">Select…</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <label className="dojo-label" htmlFor="compare-b">Collection B</label>
              <select
                id="compare-b"
                aria-label="Collection B"
                className="dojo-input"
                value={idB}
                onChange={(e) => setIdB(e.target.value)}
              >
                <option value="">Select…</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          </div>

          {idA && idB && (() => {
            const { a, b } = compareCollections(items, idA, idB);
            return (
              <div data-testid="compare-results" style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
                <StatCard title={nameOf(idA)} value={a.totalValue} count={a.cardCount} />
                <StatCard title={nameOf(idB)} value={b.totalValue} count={b.cardCount} />
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}
