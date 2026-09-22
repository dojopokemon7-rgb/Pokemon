"use client";

/**
 * WantList (F-07) — the reusable Want List body.
 *
 * Three intent tabs (Want to Buy / Sell / Trade). Each tab lists the user's
 * WantListItem rows for that intent (React Query, keyed by intent). Items
 * can be moved to another tab (atomic PATCH of `intent`) or removed.
 *
 * Extracted from the /wantlist route so the same UI can render both there
 * and inside the Portfolio page's "Want List" group without duplicating the
 * fetch/move/remove logic. The route wraps this with a page heading; the
 * portfolio group renders it bare (`heading={false}`).
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CardImage, cardInitials } from "@/components/CardImage";

type Intent = "BUY" | "SELL" | "TRADE";

interface WantItem {
  id: string;
  cardId: string;
  intent: Intent;
  /** Resolved from the Card catalog by externalId (null if not found). */
  name: string | null;
  imageUrl: string | null;
}

const TABS: { intent: Intent; label: string }[] = [
  { intent: "BUY", label: "Want to Buy" },
  { intent: "SELL", label: "Want to Sell" },
  { intent: "TRADE", label: "Want to Trade" },
];

async function fetchItems(intent: Intent): Promise<WantItem[]> {
  const res = await fetch(`/api/want-list?intent=${intent}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load want list");
  const json = await res.json();
  return json.data as WantItem[];
}

const linkBtn: React.CSSProperties = {
  background: "none", border: "none", cursor: "pointer", padding: 0,
  fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px",
  letterSpacing: "0.14em", textTransform: "uppercase",
};

export function WantList({ heading = true }: { heading?: boolean }) {
  const qc = useQueryClient();
  const [active, setActive] = useState<Intent>("BUY");
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["want-list", active],
    queryFn: () => fetchItems(active),
  });

  async function refreshAll() {
    // Both source and destination tabs change on a move.
    await qc.invalidateQueries({ queryKey: ["want-list"] });
  }

  async function move(id: string, intent: Intent) {
    setBusy(true);
    try {
      await fetch(`/api/want-list/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ intent }),
      });
      setMenuOpenId(null);
      await refreshAll();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/want-list/${id}`, { method: "DELETE", credentials: "include" });
      await refreshAll();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ color: "var(--color-dojo-ink)" }}>
      {heading && (
        <h1 className="dojo-heading" style={{ fontSize: "22px", margin: "0 0 14px" }}>Want List</h1>
      )}

      {/* Tabs */}
      <div role="tablist" aria-label="Want list intents" style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
        {TABS.map((t) => {
          const on = active === t.intent;
          return (
            <button
              key={t.intent}
              role="tab"
              aria-selected={on}
              onClick={() => { setActive(t.intent); setMenuOpenId(null); }}
              style={{
                padding: "8px 12px",
                fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "11px",
                letterSpacing: "0.08em",
                border: `1px solid ${on ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"}`,
                background: on ? "rgba(233,180,59,.1)" : "transparent",
                color: on ? "var(--color-dojo-gold)" : "var(--color-dojo-faint)",
                cursor: "pointer",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {isLoading && <p className="dojo-body">Loading…</p>}
      {!isLoading && items.length === 0 && (
        <p className="dojo-body">Nothing in this list yet.</p>
      )}

      {items.map((item) => (
        <div
          key={item.id}
          data-testid="wantlist-item"
          style={{ display: "flex", alignItems: "center", gap: "10px", padding: "13px 0", borderBottom: "1px solid var(--color-dojo-divider)", position: "relative" }}
        >
          <div style={{ width: "34px", flex: "none" }}>
            <CardImage
              src={item.imageUrl}
              alt={item.name ?? item.cardId}
              initials={cardInitials(item.name ?? item.cardId)}
              aspectRatio="660 / 921"
              initialsSize="11px"
              style={{ background: "var(--color-dojo-raised)", border: "none" }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13px", color: "var(--color-dojo-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {item.name ?? item.cardId}
            </div>
            {/* Show the external id as a secondary line only when we have a
                resolved name above it (otherwise it'd duplicate the title). */}
            {item.name && (
              <div style={{ marginTop: "2px", fontSize: "10px", color: "var(--color-dojo-faint)" }}>
                {item.cardId}
              </div>
            )}
          </div>

          {/* Move → menu of the OTHER two intents. */}
          <div style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => setMenuOpenId(menuOpenId === item.id ? null : item.id)}
              style={{ ...linkBtn, color: "var(--color-dojo-gold)" }}
            >
              Move
            </button>
            {menuOpenId === item.id && (
              <div role="menu" style={{ position: "absolute", right: 0, top: "100%", zIndex: 10, background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", minWidth: "150px" }}>
                {TABS.filter((t) => t.intent !== item.intent).map((t) => (
                  <button
                    key={t.intent}
                    role="menuitem"
                    disabled={busy}
                    onClick={() => move(item.id, t.intent)}
                    style={{ ...linkBtn, display: "block", width: "100%", textAlign: "left", padding: "10px 12px", color: "var(--color-dojo-ink)" }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={() => remove(item.id)}
            style={{ ...linkBtn, color: "var(--color-dojo-vermilion)" }}
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}
