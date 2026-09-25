"use client";

/**
 * Screen 06 — Portfolio (/portfolio)
 *
 * Shows the authenticated user's real cards with Collectr-style portfolio features:
 *   - Search bar ("search my portfolio") + filter icon.
 *   - Portfolio summary: Market Value, Total Paid, Realized Profit, Unrealized Profit.
 *   - Status filter: Active cards (default), Sold cards, All cards, Want to buy, High value tracker.
 *   - Automatic card consolidation: If the same card is added multiple times, it displays
 *     as a single tile with consolidated Quantity (e.g. Qty: 2) instead of duplicate rows.
 *   - Mark cards as SOLD with customizable Selling Price, Quantity sold, and Date.
 *   - Realized Gain/Loss tracking for all sold cards.
 *   - Revert / Unsell option to return cards to active collection.
 *   - Grid/list toggle, bulk selection mode for deletion.
 */

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { CardImage, cardInitials } from "@/components/CardImage";
import { Toast } from "@/components/Toast";

// ── Real collection item shape ──
interface CollectionItem {
  id: string;
  cardId: string;
  quantity: number;
  isFoil: boolean;
  condition: string | null;
  purchasePrice: number | null;
  collectionId?: string | null;
  isSold?: boolean;
  soldPrice?: number | null;
  soldAt?: string | null;
  addedAt: string;
  allIds?: string[];
  card: {
    id: string;
    externalId?: string;
    name: string;
    number: string;
    rarity: string | null;
    imageUrl: string | null;
    marketPrice: number | null;
    set: { name: string } | null;
  };
}

interface CollectionApiResponse {
  items: CollectionItem[];
}

interface CollectionMeta {
  id: string;
  name: string;
}

function fmt(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

// ── Icons ──────────────────────────────────────────────────────────
function SearchIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}
function FilterIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  );
}
function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect width="6" height="6" fill="currentColor" />
      <rect x="8" width="6" height="6" fill="currentColor" />
      <rect y="8" width="6" height="6" fill="currentColor" />
      <rect x="8" y="8" width="6" height="6" fill="currentColor" />
    </svg>
  );
}
function ListIcon() {
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
      <rect width="14" height="2" fill="currentColor" />
      <rect y="5" width="14" height="2" fill="currentColor" />
      <rect y="10" width="14" height="2" fill="currentColor" />
    </svg>
  );
}

// ── Delta tag ──
function GainLossTag({ item }: { item: CollectionItem }) {
  if (item.isSold) {
    if (item.soldPrice == null || item.purchasePrice == null) return null;
    const diff = item.soldPrice - item.purchasePrice;
    const pct = item.purchasePrice > 0 ? (diff / item.purchasePrice) * 100 : 0;
    const up = diff >= 0;
    return (
      <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9px", letterSpacing: "0.14em", textTransform: "uppercase", color: up ? "var(--color-dojo-jade)" : "var(--color-dojo-vermilion)" }}>
        {up ? "▲" : "▼"} {up ? "+" : ""}{pct.toFixed(1)}% Realized
      </span>
    );
  }

  if (item.purchasePrice == null || item.card.marketPrice == null) return null;
  const diff = item.card.marketPrice - item.purchasePrice;
  const pct = item.purchasePrice > 0 ? (diff / item.purchasePrice) * 100 : 0;
  const up = diff >= 0;
  return (
    <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9px", letterSpacing: "0.14em", textTransform: "uppercase", color: up ? "var(--color-dojo-jade)" : "var(--color-dojo-vermilion)" }}>
      {up ? "▲" : "▼"} {up ? "+" : ""}{pct.toFixed(1)}%
    </span>
  );
}

// A card is "graded" if its free-text condition names a grading company.
const GRADED_RE = /\b(psa|bgs|cgc|sgc|beckett)\b/i;
const isGraded = (c: string | null | undefined) => !!c && GRADED_RE.test(c);

/** Sub-line like "Obsidian Flames · PSA 10" / "Base Set · Raw · Foil". */
function subLine(item: CollectionItem): string {
  const parts: string[] = [];
  const setName = item.card.set?.name;
  if (setName && setName.toLowerCase() !== "unknown set") parts.push(setName);
  parts.push(isGraded(item.condition) ? (item.condition as string) : "Raw");
  if (item.isFoil) parts.push("Foil");
  return parts.join(" · ");
}

function detailHref(item: CollectionItem): string {
  const cardIdentifier = item.card.externalId || item.cardId;
  const game = /^(OP|ST|EB|PRB)\d{2}-\d{3}$/i.test(cardIdentifier) ? "onepiece" : "pokemon";
  const params = new URLSearchParams({
    name: item.card.name,
    game,
    ...(item.card.set?.name ? { set: item.card.set.name } : {}),
    ...(item.card.imageUrl ? { img: item.card.imageUrl } : {}),
    ...(item.card.marketPrice ? { price: String(item.card.marketPrice) } : {}),
    ...(item.card.number ? { number: item.card.number } : {}),
    ...(item.card.rarity ? { rarity: item.card.rarity } : {}),
  });
  return `/search/${cardIdentifier}?${params.toString()}`;
}

// ── Selection checkbox overlay (shown in Select mode) ──
function SelectCheckbox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        position: "absolute", top: "8px", left: "8px", zIndex: 2,
        width: "24px", height: "24px",
        border: "1px solid " + (checked ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"),
        background: checked ? "var(--color-dojo-gold)" : "rgba(13,13,13,0.7)",
        color: "var(--color-dojo-app)", display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: "14px", fontWeight: 900, lineHeight: 1,
      }}
    >
      {checked ? "✓" : ""}
    </span>
  );
}

// ── Collectr "Mark as Sold" Modal ──
interface SellModalProps {
  item: CollectionItem;
  onClose: () => void;
  onConfirm: (data: { soldPrice: number; quantity: number; soldAt: string }) => void;
  isPending: boolean;
}

function SellModal({ item, onClose, onConfirm, isPending }: SellModalProps) {
  const [qty, setQty] = useState<number>(1);
  const [price, setPrice] = useState<string>(String(item.card.marketPrice ?? item.purchasePrice ?? 0));
  const [date, setDate] = useState<string>(new Date().toISOString().split("T")[0]);

  const numPrice = parseFloat(price) || 0;
  const cost = item.purchasePrice ?? 0;
  const realizedPerItem = numPrice - cost;
  const totalRealized = realizedPerItem * qty;
  const pct = cost > 0 ? (realizedPerItem / cost) * 100 : 0;
  const up = totalRealized >= 0;

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(0,0,0,0.7)" }} />
      <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, zIndex: 91, display: "flex", alignItems: "center", justifyContent: "center", padding: "18px" }}>
        <div style={{ width: "100%", maxWidth: "380px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
            <div style={{ width: "48px", flex: "none" }}>
              <CardImage src={item.card.imageUrl} alt={item.card.name} initials={cardInitials(item.card.name)} aspectRatio="660 / 921" />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 className="dojo-heading" style={{ fontSize: "16px", margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                Mark as Sold
              </h2>
              <div style={{ fontSize: "12px", color: "var(--color-dojo-ink)", fontWeight: 700, marginTop: "2px" }}>
                {item.card.name}
              </div>
              <div style={{ fontSize: "10.5px", color: "var(--color-dojo-body)" }}>
                {subLine(item)}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            {/* Quantity */}
            <div>
              <label style={{ display: "block", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-body)", marginBottom: "6px" }}>
                Quantity Sold (Max: {item.quantity})
              </label>
              <input
                type="number"
                min={1}
                max={item.quantity}
                value={qty}
                onChange={(e) => setQty(Math.min(item.quantity, Math.max(1, parseInt(e.target.value) || 1)))}
                style={{ width: "100%", padding: "10px 12px", background: "var(--color-dojo-app)", border: "1px solid var(--color-dojo-stroke)", color: "var(--color-dojo-ink)", fontSize: "14px", fontFamily: "var(--font-display)", fontWeight: 700 }}
              />
            </div>

            {/* Selling Price */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                <label style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
                  Selling Price ($ per card)
                </label>
                {item.card.marketPrice != null && (
                  <span style={{ fontSize: "10px", color: "var(--color-dojo-gold)", cursor: "pointer" }} onClick={() => setPrice(String(item.card.marketPrice))}>
                    Market: {fmt(item.card.marketPrice)}
                  </span>
                )}
              </div>
              <input
                type="number"
                step="0.01"
                min={0}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0.00"
                style={{ width: "100%", padding: "10px 12px", background: "var(--color-dojo-app)", border: "1px solid var(--color-dojo-stroke)", color: "var(--color-dojo-ink)", fontSize: "14px", fontFamily: "var(--font-display)", fontWeight: 700 }}
              />
            </div>

            {/* Date Sold */}
            <div>
              <label style={{ display: "block", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-body)", marginBottom: "6px" }}>
                Sale Date
              </label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                style={{ width: "100%", padding: "10px 12px", background: "var(--color-dojo-app)", border: "1px solid var(--color-dojo-stroke)", color: "var(--color-dojo-ink)", fontSize: "13px" }}
              />
            </div>

            {/* Realized Profit preview */}
            <div style={{ padding: "10px 12px", background: "var(--color-dojo-app)", border: "1px solid var(--color-dojo-divider)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontFamily: "var(--font-display)", fontSize: "11px", fontWeight: 700, color: "var(--color-dojo-body)" }}>
                Realized Profit/Loss:
              </span>
              <span style={{ fontFamily: "var(--font-display)", fontSize: "13px", fontWeight: 800, color: up ? "var(--color-dojo-jade)" : "var(--color-dojo-vermilion)" }}>
                {up ? "+" : ""}{fmt(totalRealized)} ({up ? "+" : ""}{pct.toFixed(1)}%)
              </span>
            </div>

            {/* Action buttons */}
            <div style={{ display: "flex", gap: "10px", marginTop: "6px" }}>
              <button
                type="button"
                onClick={onClose}
                disabled={isPending}
                className="dojo-btn dojo-btn-outline"
                style={{ flex: 1, height: "42px" }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isPending || numPrice <= 0}
                onClick={() => onConfirm({ soldPrice: numPrice, quantity: qty, soldAt: date })}
                className="dojo-btn dojo-btn-primary"
                style={{ flex: 1, height: "42px" }}
              >
                {isPending ? "Saving..." : "Confirm Sale"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Card tile — grid view ──────────────────────────────────────────
function CardGrid({
  item, selectMode, selected, onToggleSelect, onWantToSell, onMarkAsSold, onRevertSold, owned,
}: {
  item: CollectionItem;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onWantToSell: (item: CollectionItem) => void;
  onMarkAsSold: (item: CollectionItem) => void;
  onRevertSold: (id: string) => void;
  owned: boolean;
}) {
  const price = item.isSold ? item.soldPrice : item.card.marketPrice;
  const inner = (
    <>
      {selectMode && <SelectCheckbox checked={selected} />}
      <div style={{ position: "relative" }}>
        <CardImage src={item.card.imageUrl} alt={item.card.name} initials={cardInitials(item.card.name)} style={{ background: "var(--color-dojo-raised)", border: "none" }} />
        {item.isSold && (
          <span style={{ position: "absolute", top: "6px", right: "6px", background: "var(--color-dojo-vermilion)", color: "#fff", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "9px", padding: "2px 6px", letterSpacing: "0.1em", textTransform: "uppercase" }}>
            SOLD
          </span>
        )}
      </div>
      <div style={{ marginTop: "9px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12.5px", lineHeight: 1.3, minHeight: "32px", color: "var(--color-dojo-ink)" }}>
        {item.card.name}
      </div>
      <div style={{ marginTop: "4px", fontSize: "10.5px", color: "var(--color-dojo-body)" }}>{subLine(item)}</div>
      <div style={{ display: "flex", alignItems: "baseline", marginTop: "9px", gap: "8px" }}>
        <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13.5px", fontVariantNumeric: "tabular-nums", color: price != null ? "var(--color-dojo-ink)" : "var(--color-dojo-faint)" }}>
          {price != null ? fmt(price) : "—"}
        </span>
        <span style={{ marginLeft: "auto" }}><GainLossTag item={item} /></span>
      </div>
      <div style={{ marginTop: "5px", fontSize: "11px", color: "var(--color-dojo-faint)" }}>
        Qty: {item.quantity}
      </div>
    </>
  );

  const box: React.CSSProperties = {
    position: "relative", background: "var(--color-dojo-card)",
    border: "1px solid " + (selected ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"),
    padding: "11px", textDecoration: "none", display: "block", cursor: "pointer",
  };

  if (selectMode) {
    return (
      <div className="dojo-card-tile" style={box} role="button" tabIndex={0}
        onClick={() => onToggleSelect(item.id)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleSelect(item.id); } }}
        aria-pressed={selected}
      >
        {inner}
      </div>
    );
  }

  return (
    <div style={box}>
      <Link href={detailHref(item)} className="dojo-card-tile" style={{ textDecoration: "none", display: "block" }}>{inner}</Link>
      {owned && !item.isSold && (
        <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onMarkAsSold(item); }}
            style={{
              flex: 1, padding: "7px 0", cursor: "pointer",
              border: "1px solid var(--color-dojo-gold)", background: "rgba(233,180,59,0.08)",
              color: "var(--color-dojo-gold)", fontFamily: "var(--font-display)", fontWeight: 800,
              fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase",
            }}
          >
            Mark Sold
          </button>
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onWantToSell(item); }}
            style={{
              flex: 1, padding: "7px 0", cursor: "pointer",
              border: "1px solid var(--color-dojo-stroke)", background: "transparent",
              color: "var(--color-dojo-faint)", fontFamily: "var(--font-display)", fontWeight: 800,
              fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase",
            }}
          >
            Want Sell
          </button>
        </div>
      )}
      {owned && item.isSold && (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRevertSold(item.id); }}
          style={{
            marginTop: "8px", width: "100%", padding: "7px 0", cursor: "pointer",
            border: "1px solid var(--color-dojo-stroke)", background: "transparent",
            color: "var(--color-dojo-faint)", fontFamily: "var(--font-display)", fontWeight: 800,
            fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase",
          }}
        >
          Revert to Active
        </button>
      )}
    </div>
  );
}

// ── Card row — list view ───────────────────────────────────────────
function CardRow({
  item, selectMode, selected, onToggleSelect, onWantToSell, onMarkAsSold, onRevertSold, owned,
}: {
  item: CollectionItem;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onWantToSell: (item: CollectionItem) => void;
  onMarkAsSold: (item: CollectionItem) => void;
  onRevertSold: (id: string) => void;
  owned: boolean;
}) {
  const price = item.isSold ? item.soldPrice : item.card.marketPrice;
  const inner = (
    <>
      {selectMode && (
        <span aria-hidden="true" style={{ flex: "none", width: "22px", height: "22px", border: "1px solid " + (selected ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"), background: selected ? "var(--color-dojo-gold)" : "transparent", color: "var(--color-dojo-app)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "13px", fontWeight: 900 }}>
          {selected ? "✓" : ""}
        </span>
      )}
      <div style={{ width: "40px", flex: "none", position: "relative" }}>
        <CardImage src={item.card.imageUrl} alt={item.card.name} initials={cardInitials(item.card.name)} aspectRatio="660 / 921" initialsSize="12px" style={{ background: "var(--color-dojo-raised)", border: "none" }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "12px" }}>
          <div style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13.5px", color: "var(--color-dojo-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {item.card.name}
            {item.isSold && (
              <span style={{ marginLeft: "8px", background: "var(--color-dojo-vermilion)", color: "#fff", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "8.5px", padding: "1px 5px", letterSpacing: "0.1em", textTransform: "uppercase" }}>
                SOLD
              </span>
            )}
          </div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "14px", fontVariantNumeric: "tabular-nums", color: price != null ? "var(--color-dojo-ink)" : "var(--color-dojo-faint)" }}>
            {price != null ? fmt(price) : "—"}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "6px" }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: "11px", color: "var(--color-dojo-body)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{subLine(item)}</div>
          <GainLossTag item={item} />
        </div>
        <div style={{ marginTop: "6px", fontSize: "11px", color: "var(--color-dojo-faint)" }}>
          Qty: {item.quantity}
        </div>
      </div>
    </>
  );

  const box: React.CSSProperties = {
    position: "relative", background: "var(--color-dojo-card)",
    border: "1px solid " + (selected ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"),
    padding: "12px 13px", marginBottom: "10px", display: "flex", gap: "12px", alignItems: "center", textDecoration: "none",
  };

  if (selectMode) {
    return (
      <div className="dojo-card-tile" style={box} role="button" tabIndex={0}
        onClick={() => onToggleSelect(item.id)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleSelect(item.id); } }}
        aria-pressed={selected}
      >
        {inner}
      </div>
    );
  }

  return (
    <div style={box}>
      <Link href={detailHref(item)} className="dojo-card-tile" style={{ flex: 1, minWidth: 0, display: "flex", gap: "12px", alignItems: "center", textDecoration: "none" }}>{inner}</Link>
      {owned && !item.isSold && (
        <div style={{ display: "flex", gap: "6px", flex: "none" }}>
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onMarkAsSold(item); }}
            style={{
              padding: "7px 10px", cursor: "pointer", whiteSpace: "nowrap",
              border: "1px solid var(--color-dojo-gold)", background: "rgba(233,180,59,0.08)",
              color: "var(--color-dojo-gold)", fontFamily: "var(--font-display)", fontWeight: 800,
              fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase",
            }}
          >
            Mark Sold
          </button>
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onWantToSell(item); }}
            style={{
              padding: "7px 10px", cursor: "pointer", whiteSpace: "nowrap",
              border: "1px solid var(--color-dojo-stroke)", background: "transparent",
              color: "var(--color-dojo-faint)", fontFamily: "var(--font-display)", fontWeight: 800,
              fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase",
            }}
          >
            Want Sell
          </button>
        </div>
      )}
      {owned && item.isSold && (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRevertSold(item.id); }}
          style={{
            flex: "none", padding: "7px 10px", cursor: "pointer", whiteSpace: "nowrap",
            border: "1px solid var(--color-dojo-stroke)", background: "transparent",
            color: "var(--color-dojo-faint)", fontFamily: "var(--font-display)", fontWeight: 800,
            fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase",
          }}
        >
          Revert
        </button>
      )}
    </div>
  );
}

const dropdownBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: "6px", padding: "6px 10px", cursor: "pointer",
  border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)", color: "var(--color-dojo-ink)",
  fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "9.5px", letterSpacing: "0.12em", textTransform: "uppercase", whiteSpace: "nowrap",
};
const activePill: React.CSSProperties = {
  border: "1px solid var(--color-dojo-gold)",
  background: "var(--color-dojo-gold)",
  color: "var(--color-dojo-app)",
};

type CardType = "active" | "sold" | "all" | "want-to-buy" | "high-value";
const CARD_TYPE_OPTIONS: { id: CardType; label: string }[] = [
  { id: "active", label: "Active cards" },
  { id: "sold", label: "Sold cards" },
  { id: "all", label: "All cards" },
  { id: "want-to-buy", label: "Want to buy" },
  { id: "high-value", label: "High value tracker" },
];
const HIGH_VALUE_THRESHOLD = 100;

export default function PortfolioPage() {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">("list");
  const [cardType, setCardType] = useState<CardType>("active");
  const [typeOpen, setTypeOpen] = useState(false);
  const [selectedColl, setSelectedColl] = useState<string>("all");
  const [collOpen, setCollOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [sellModalItem, setSellModalItem] = useState<CollectionItem | null>(null);
  const queryClient = useQueryClient();

  const wantToSell = useMutation({
    mutationFn: async (cardId: string) => {
      const res = await fetch("/api/want-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ cardId, intent: "SELL" }),
      });
      if (!res.ok) throw new Error("Could not add to Want to Sell.");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["want-list"] });
      setToast("Added to Want to Sell");
    },
    onError: (err: Error) => setToast(err.message),
  });

  const markAsSold = useMutation({
    mutationFn: async ({ id, soldPrice, soldQuantity, soldAt }: { id: string; soldPrice: number; soldQuantity: number; soldAt?: string }) => {
      const res = await fetch(`/api/users/me/collection/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ isSold: true, soldPrice, soldQuantity, soldAt }),
      });
      if (!res.ok) throw new Error("Could not mark card as sold.");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["portfolio-collection"] });
      queryClient.invalidateQueries({ queryKey: ["collection"] });
      setToast("Card marked as sold!");
    },
    onError: (err: Error) => setToast(err.message),
  });

  const revertSold = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/users/me/collection/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ isSold: false }),
      });
      if (!res.ok) throw new Error("Could not revert sale.");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["portfolio-collection"] });
      queryClient.invalidateQueries({ queryKey: ["collection"] });
      setToast("Card returned to active collection");
    },
    onError: (err: Error) => setToast(err.message),
  });

  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia("(min-width: 640px)").matches) {
      setView("grid");
    }
  }, []);

  const { data, isLoading, isError } = useQuery<CollectionApiResponse>({
    queryKey: ["portfolio-collection"],
    queryFn: async () => {
      const res = await fetch("/api/users/me/collection");
      if (!res.ok) throw new Error("Failed to load collection");
      return res.json();
    },
  });

  const { data: collMeta } = useQuery<CollectionMeta[]>({
    queryKey: ["collections"],
    queryFn: async () => {
      const res = await fetch("/api/collections", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load collections");
      const json = await res.json();
      return json.data as CollectionMeta[];
    },
  });

  const { data: wantData } = useQuery<{ data: { id: string; cardId: string; name: string | null; imageUrl: string | null; marketPrice: number | null; setName: string | null }[] }>({
    queryKey: ["want-list", "BUY"],
    queryFn: async () => {
      const res = await fetch("/api/want-list?intent=BUY", { credentials: "include" });
      if (!res.ok) return { data: [] };
      return res.json();
    },
    enabled: cardType === "want-to-buy",
  });

  const bulkDelete = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => fetch(`/api/users/me/collection/${id}`, { method: "DELETE" }))
      );
      const failed = results.filter((r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok));
      if (failed.length) throw new Error(`${failed.length} of ${ids.length} deletes failed`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["portfolio-collection"] });
      queryClient.invalidateQueries({ queryKey: ["collection"] });
      setSelectedIds(new Set());
      setSelectMode(false);
      setConfirmOpen(false);
    },
  });

  const rawItems = data?.items ?? [];

  // Deduplicate / consolidate identical cards so if the same card is added twice,
  // it shows as Qty: 2 and does not list it again as a duplicate row!
  const consolidatedItems = useMemo(() => {
    const map = new Map<string, CollectionItem & { allIds: string[] }>();
    for (const item of rawItems) {
      const cardKey = item.card.name.trim().toLowerCase();
      const setKey = (item.card.set?.name ?? "").trim().toLowerCase();
      const condKey = isGraded(item.condition) ? (item.condition ?? "").trim().toLowerCase() : "raw";
      const foilKey = item.isFoil ? "foil" : "regular";
      const soldKey = item.isSold ? `sold-${item.soldPrice ?? 0}` : "active";
      const collKey = item.collectionId ?? "__uncat__";
      const key = `${cardKey}::${setKey}::${foilKey}::${condKey}::${soldKey}::${collKey}`;

      const existing = map.get(key);
      if (existing) {
        existing.quantity += item.quantity;
        existing.allIds.push(item.id);
        if (item.purchasePrice != null && existing.purchasePrice != null) {
          existing.purchasePrice = (existing.purchasePrice + item.purchasePrice) / 2;
        } else if (item.purchasePrice != null) {
          existing.purchasePrice = item.purchasePrice;
        }
      } else {
        map.set(key, { ...item, allIds: [item.id] });
      }
    }
    return Array.from(map.values());
  }, [rawItems]);

  const collOptions = useMemo(() => {
    const opts = [{ id: "all", name: "All collections" }];
    for (const c of collMeta ?? []) opts.push({ id: c.id, name: c.name });
    opts.push({ id: "__uncat__", name: "Uncategorized" });
    return opts;
  }, [collMeta]);

  const wantAsItems: CollectionItem[] = useMemo(
    () =>
      (wantData?.data ?? []).map((w) => ({
        id: `want-${w.id}`,
        cardId: w.cardId,
        quantity: 1,
        isFoil: false,
        condition: null,
        purchasePrice: null,
        collectionId: null,
        addedAt: "",
        card: {
          id: w.cardId,
          name: w.name ?? w.cardId,
          number: "",
          rarity: null,
          imageUrl: w.imageUrl,
          marketPrice: w.marketPrice,
          set: w.setName ? { name: w.setName } : null,
        },
      })),
    [wantData]
  );

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (cardType === "want-to-buy") {
      return wantAsItems.filter((i) => !q || i.card.name.toLowerCase().includes(q));
    }
    return consolidatedItems.filter((i) => {
      if (q && !i.card.name.toLowerCase().includes(q)) return false;
      if (cardType === "active" && i.isSold) return false;
      if (cardType === "sold" && !i.isSold) return false;
      if (cardType === "high-value" && (i.card.marketPrice ?? 0) < HIGH_VALUE_THRESHOLD) return false;
      if (selectedColl !== "all" && (i.collectionId ?? "__uncat__") !== selectedColl) return false;
      return true;
    });
  }, [consolidatedItems, wantAsItems, query, cardType, selectedColl]);

  // Overall Portfolio Stats (Collectr feature)
  const portfolioStats = useMemo(() => {
    let marketValue = 0;
    let paid = 0;
    let realized = 0;

    for (const item of rawItems) {
      if (item.isSold) {
        realized += ((item.soldPrice ?? 0) - (item.purchasePrice ?? 0)) * item.quantity;
      } else {
        marketValue += (item.card.marketPrice ?? 0) * item.quantity;
        paid += (item.purchasePrice ?? 0) * item.quantity;
      }
    }

    const unrealized = marketValue - paid;
    return { marketValue, paid, realized, unrealized };
  }, [rawItems]);

  const totalValue = useMemo(() => {
    if (cardType === "sold") {
      return filteredItems.reduce((a, i) => a + (i.soldPrice ?? 0) * i.quantity, 0);
    }
    return filteredItems.reduce((a, i) => a + (i.card.marketPrice ?? 0) * i.quantity, 0);
  }, [filteredItems, cardType]);

  const typeLabel = CARD_TYPE_OPTIONS.find((o) => o.id === cardType)!.label;
  const collLabel = collOptions.find((o) => o.id === selectedColl)?.name ?? "All collections";
  const canSelect = cardType !== "want-to-buy";

  const toggleSelectId = (id: string) => {
    const item = consolidatedItems.find((i) => i.id === id);
    const idsToToggle = item?.allIds ?? [id];
    setSelectedIds((prev) => {
      const n = new Set(prev);
      const isSelected = n.has(id);
      for (const i of idsToToggle) {
        if (isSelected) n.delete(i);
        else n.add(i);
      }
      return n;
    });
  };

  return (
    <div style={{ padding: "6px 22px 24px" }}>
      {/* ── Search bar + filter icon ── */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "16px" }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: "10px", border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)", padding: "12px 13px", color: "var(--color-dojo-ink)" }}>
          <span style={{ display: "flex", color: "var(--color-dojo-body)" }}><SearchIcon /></span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search my portfolio"
            aria-label="Search my portfolio"
            style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", fontSize: "13.5px", color: "var(--color-dojo-ink)" }}
          />
        </div>
        <button
          type="button"
          aria-label="Filters"
          title="Filters"
          onClick={() => setTypeOpen((v) => !v)}
          style={{ flex: "none", width: "44px", height: "44px", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)", color: "var(--color-dojo-body)" }}
        >
          <FilterIcon />
        </button>
      </div>

      {/* ── Total value + filter dropdowns ── */}
      <div style={{ marginTop: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontStretch: "112%", fontSize: "10px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
            {cardType === "sold" ? "Total Sold Value" : "Total value"}
          </span>

          {/* Dropdown 1 — card type/intent */}
          <div style={{ position: "relative" }}>
            <button type="button" data-testid="card-type-filter" aria-haspopup="listbox" aria-expanded={typeOpen}
              onClick={() => { setTypeOpen((v) => !v); setCollOpen(false); }}
              style={{ ...dropdownBtn, ...(cardType !== "active" ? activePill : null) }}
            >
              {typeLabel}<span aria-hidden="true" style={{ fontSize: "8px", opacity: 0.7 }}>▾</span>
            </button>
            {typeOpen && (
              <>
                <div onClick={() => setTypeOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
                <div role="listbox" aria-label="Filter by card type" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 61, minWidth: "210px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", boxShadow: "0 10px 30px rgba(0,0,0,0.5)" }}>
                  {CARD_TYPE_OPTIONS.map((o) => {
                    const on = cardType === o.id;
                    return (
                      <button key={o.id} type="button" role="option" aria-selected={on}
                        onClick={() => { setCardType(o.id); setTypeOpen(false); setSelectMode(false); setSelectedIds(new Set()); }}
                        style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 14px", cursor: "pointer", background: on ? "rgba(233,180,59,0.08)" : "none", border: "none", borderBottom: "1px solid var(--color-dojo-divider)", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12px", color: on ? "var(--color-dojo-gold)" : "var(--color-dojo-ink)" }}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* Dropdown 2 — Collections */}
          <div style={{ position: "relative" }}>
            <button type="button" data-testid="collection-filter" aria-haspopup="listbox" aria-expanded={collOpen}
              disabled={cardType === "want-to-buy"}
              onClick={() => { setCollOpen((v) => !v); setTypeOpen(false); }}
              style={{ ...dropdownBtn, ...(selectedColl !== "all" ? activePill : null), ...(cardType === "want-to-buy" ? { opacity: 0.4, cursor: "not-allowed" } : null) }}
            >
              {collLabel}<span aria-hidden="true" style={{ fontSize: "8px", opacity: 0.7 }}>▾</span>
            </button>
            {collOpen && cardType !== "want-to-buy" && (
              <>
                <div onClick={() => setCollOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
                <div role="listbox" aria-label="Filter by collection" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 61, minWidth: "200px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", boxShadow: "0 10px 30px rgba(0,0,0,0.5)" }}>
                  {collOptions.map((o) => {
                    const on = selectedColl === o.id;
                    return (
                      <button key={o.id} type="button" role="option" aria-selected={on}
                        onClick={() => { setSelectedColl(o.id); setCollOpen(false); }}
                        style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 14px", cursor: "pointer", background: on ? "rgba(233,180,59,0.08)" : "none", border: "none", borderBottom: "1px solid var(--color-dojo-divider)", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12px", color: on ? "var(--color-dojo-gold)" : "var(--color-dojo-ink)" }}
                      >
                        {o.name}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>

        <div style={{ marginTop: "6px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "32px", lineHeight: 1.05, fontVariantNumeric: "tabular-nums", color: "var(--color-dojo-ink)" }}>
          {isLoading ? "—" : fmt(totalValue)}
        </div>

        {/* Collectr Portfolio Metrics (Paid, Realized, Unrealized) */}
        <div style={{ display: "flex", gap: "14px", marginTop: "10px", paddingTop: "10px", borderTop: "1px solid var(--color-dojo-divider)", flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
            Paid <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12px", color: "var(--color-dojo-ink)" }}>{fmt(portfolioStats.paid)}</span>
          </span>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
            Realized <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12px", color: portfolioStats.realized >= 0 ? "var(--color-dojo-jade)" : "var(--color-dojo-vermilion)" }}>{portfolioStats.realized >= 0 ? "+" : ""}{fmt(portfolioStats.realized)}</span>
          </span>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
            Unrealized <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12px", color: portfolioStats.unrealized >= 0 ? "var(--color-dojo-jade)" : "var(--color-dojo-vermilion)" }}>{portfolioStats.unrealized >= 0 ? "+" : ""}{fmt(portfolioStats.unrealized)}</span>
          </span>
        </div>
      </div>

      {/* ── List header: view name · item count · Select · view toggle ── */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", margin: "20px 0 12px" }}>
        <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
          {typeLabel}
        </span>
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
          {filteredItems.length} item{filteredItems.length !== 1 ? "s" : ""}
        </span>

        {canSelect && (
          <button
            type="button"
            onClick={() => { setSelectMode((v) => !v); setSelectedIds(new Set()); }}
            style={{ ...dropdownBtn, background: selectMode ? "var(--color-dojo-gold)" : "var(--color-dojo-card)", color: selectMode ? "var(--color-dojo-app)" : "var(--color-dojo-ink)", border: "1px solid " + (selectMode ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)") }}
          >
            {selectMode ? "Cancel" : "Select"}
          </button>
        )}

        <div style={{ display: "flex" }}>
          <button onClick={() => setView("list")} aria-label="List view"
            style={{ width: "32px", height: "32px", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", border: "none", padding: 0, background: view === "list" ? "var(--color-dojo-gold)" : "transparent", color: view === "list" ? "var(--color-dojo-app)" : "var(--color-dojo-faint)", boxShadow: view === "list" ? "none" : "inset 0 0 0 1px var(--color-dojo-stroke)" }}>
            <ListIcon />
          </button>
          <button onClick={() => setView("grid")} aria-label="Grid view"
            style={{ width: "32px", height: "32px", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", border: "none", padding: 0, background: view === "grid" ? "var(--color-dojo-gold)" : "transparent", color: view === "grid" ? "var(--color-dojo-app)" : "var(--color-dojo-faint)", boxShadow: view === "grid" ? "none" : "inset 0 0 0 1px var(--color-dojo-stroke)" }}>
            <GridIcon />
          </button>
        </div>
      </div>

      {/* ── Bulk delete bar ── */}
      {selectMode && selectedIds.size > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px", padding: "10px 13px", border: "1px solid var(--color-dojo-gold)", background: "rgba(233,180,59,0.08)" }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "11px", color: "var(--color-dojo-ink)" }}>
            {selectedIds.size} selected
          </span>
          <button type="button" onClick={() => setConfirmOpen(true)}
            style={{ marginLeft: "auto", padding: "8px 16px", cursor: "pointer", border: "1px solid var(--color-dojo-vermilion)", background: "var(--color-dojo-vermilion)", color: "#fff", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase" }}>
            Delete Selected
          </button>
        </div>
      )}

      {/* ── Content ── */}
      {isLoading ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} style={{ background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "11px" }}>
              <div style={{ width: "100%", aspectRatio: "660 / 921", background: "var(--color-dojo-raised)", animation: "dojo-pulse 1.5s ease-in-out infinite" }} />
            </div>
          ))}
        </div>
      ) : isError ? (
        <div style={{ border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)", padding: "30px 22px", textAlign: "center" }}>
          <p className="dojo-heading" style={{ fontSize: "20px", margin: 0 }}>couldn&apos;t load your portfolio</p>
          <p className="dojo-body" style={{ marginTop: "8px", marginBottom: 0 }}>check your connection and try again.</p>
        </div>
      ) : filteredItems.length === 0 ? (
        <div style={{ border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)", padding: "30px 22px", textAlign: "center" }}>
          <p className="dojo-heading" style={{ fontSize: "20px", margin: 0 }}>
            {rawItems.length === 0 ? "nothing here yet" : "no matches"}
          </p>
          <p className="dojo-body" style={{ marginTop: "8px", marginBottom: rawItems.length === 0 ? "18px" : 0 }}>
            {rawItems.length === 0 ? "add a card from search or the scanner to start your portfolio." : "no cards match these filters."}
          </p>
          {rawItems.length === 0 && (
            <Link href="/search" className="dojo-btn dojo-btn-primary" style={{ textDecoration: "none", display: "inline-flex", width: "auto", padding: "12px 22px" }}>
              SEARCH CARDS
            </Link>
          )}
        </div>
      ) : view === "grid" ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          {filteredItems.map((item) => (
            <CardGrid
              key={item.id}
              item={item}
              selectMode={selectMode}
              selected={item.allIds ? item.allIds.some((id) => selectedIds.has(id)) : selectedIds.has(item.id)}
              onToggleSelect={toggleSelectId}
              onWantToSell={(i) => wantToSell.mutate(i.cardId)}
              onMarkAsSold={(i) => setSellModalItem(i)}
              onRevertSold={(id) => revertSold.mutate(id)}
              owned={canSelect}
            />
          ))}
        </div>
      ) : (
        <div>
          {filteredItems.map((item) => (
            <CardRow
              key={item.id}
              item={item}
              selectMode={selectMode}
              selected={item.allIds ? item.allIds.some((id) => selectedIds.has(id)) : selectedIds.has(item.id)}
              onToggleSelect={toggleSelectId}
              onWantToSell={(i) => wantToSell.mutate(i.cardId)}
              onMarkAsSold={(i) => setSellModalItem(i)}
              onRevertSold={(id) => revertSold.mutate(id)}
              owned={canSelect}
            />
          ))}
        </div>
      )}

      {/* ── Collectr Mark as Sold Modal ── */}
      {sellModalItem && (
        <SellModal
          item={sellModalItem}
          isPending={markAsSold.isPending}
          onClose={() => setSellModalItem(null)}
          onConfirm={async ({ soldPrice, quantity, soldAt }) => {
            await markAsSold.mutateAsync({
              id: sellModalItem.id,
              soldPrice,
              soldQuantity: quantity,
              soldAt,
            });
            setSellModalItem(null);
          }}
        />
      )}

      {/* ── Double-confirm delete modal ── */}
      {confirmOpen && (
        <>
          <div onClick={() => !bulkDelete.isPending && setConfirmOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(0,0,0,0.6)" }} />
          <div role="dialog" aria-modal="true" aria-label="Confirm delete" style={{ position: "fixed", inset: 0, zIndex: 91, display: "flex", alignItems: "center", justifyContent: "center", padding: "22px", pointerEvents: "none" }}>
            <div style={{ pointerEvents: "auto", width: "100%", maxWidth: "340px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "20px" }}>
              <h2 className="dojo-heading" style={{ fontSize: "18px", margin: "0 0 10px" }}>Delete cards?</h2>
              <p className="dojo-body" style={{ margin: "0 0 18px", fontSize: "13px", lineHeight: 1.5 }}>
                Are you sure you want to delete {selectedIds.size} card{selectedIds.size !== 1 ? "s" : ""}? This cannot be undone.
              </p>
              {bulkDelete.isError && (
                <p style={{ margin: "0 0 12px", fontSize: "12px", color: "var(--color-dojo-vermilion)" }}>Some deletes failed. Please try again.</p>
              )}
              <div style={{ display: "flex", gap: "10px" }}>
                <button type="button" disabled={bulkDelete.isPending} onClick={() => setConfirmOpen(false)}
                  className="dojo-btn dojo-btn-outline" style={{ flex: 1, width: "auto", height: "44px" }}>
                  Cancel
                </button>
                <button type="button" disabled={bulkDelete.isPending} onClick={() => bulkDelete.mutate([...selectedIds])}
                  style={{ flex: 1, height: "44px", cursor: "pointer", border: "1px solid var(--color-dojo-vermilion)", background: "var(--color-dojo-vermilion)", color: "#fff", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px", letterSpacing: "0.14em", textTransform: "uppercase" }}>
                  {bulkDelete.isPending ? "Deleting…" : "Yes, Delete"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}
