"use client";

/**
 * AddCardSheet — shared "add a card to your portfolio" bottom sheet.
 *
 * Extracted from search/page.tsx so the EXPLORE grid AND the card-detail page
 * use the SAME add flow (one source of truth): RAW/PSA grader toggle, a
 * condition dropdown (RAW: Near mint / Lightly played / … ; PSA: Gem Mint 10 /
 * …), collection picker, quantity, and an optional price-paid field.
 *
 * The caller passes a minimal `AddableCard` (externalId + display fields); the
 * sheet owns all add state + the POST to /api/users/me/collection and reports
 * success via onAdded. `initialCondition` ("PSA 10") pre-opens the PSA form.
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CardImage, cardInitials } from "@/components/CardImage";
import { DojoSelect } from "@/components/DojoSelect";

// Minimal shape every caller can satisfy (explore tile, search result, or the
// card-detail header). externalId is the catalog id sent to the collection API.
export interface AddableCard {
  externalId: string;
  name: string;
  setName?: string | null;
  imageUrl?: string | null;
  marketPrice?: number | null;
}

const GRADERS = ["PSA", "BGS", "CGC", "SGC"] as const;

// Raw (ungraded) condition options — full names per design, short code stored.
const RAW_CONDITIONS: { label: string; value: string }[] = [
  { label: "Near mint", value: "NM" },
  { label: "Lightly played", value: "LP" },
  { label: "Moderately played", value: "MP" },
  { label: "Heavily played", value: "HP" },
  { label: "Damaged", value: "DMG" },
];

// PSA numeric-grade options; value carries the grade so we persist "PSA <grade>".
const PSA_CONDITIONS: { label: string; value: string }[] = [
  { label: "Gem Mint 10", value: "Grade 10" },
  { label: "Mint 9", value: "Grade 9" },
  { label: "NM-MT 8", value: "Grade 8" },
  { label: "EX-MT 6", value: "Grade 6" },
  { label: "EX 5", value: "Grade 5" },
  { label: "VG-EX 4", value: "Grade 4" },
  { label: "VG 3", value: "Grade 3" },
  { label: "Good 2", value: "Grade 2" },
  { label: "Fair 1.5", value: "Grade 1.5" },
  { label: "Poor 1", value: "Grade 1" },
];

/** "PSA 10" / "BGS 9.5" → { grader, grade }; null when it names no company. */
export function parseGraded(
  condition: string | undefined | null
): { grader: (typeof GRADERS)[number]; grade: string } | null {
  if (!condition) return null;
  const grader = GRADERS.find((g) => new RegExp(`\\b${g}\\b`, "i").test(condition));
  if (!grader) return null;
  const grade = condition.match(/\d+(?:\.\d+)?/)?.[0] ?? "";
  return { grader, grade };
}

function fmtUSD(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

export function AddCardSheet({
  card,
  onClose,
  onAdded,
  initialCondition,
}: {
  card: AddableCard;
  onClose: () => void;
  onAdded: (message: string) => void;
  /** "PSA 10" pre-opens the PSA form at that grade. */
  initialCondition?: string;
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const parsed = parseGraded(initialCondition);
  const [grader, setGrader] = useState<"RAW" | "PSA">(parsed ? "PSA" : "RAW");
  const [condition, setCondition] = useState<string>(
    parsed ? `Grade ${parsed.grade}` : RAW_CONDITIONS[0].value
  );
  const [collectionId, setCollectionId] = useState<string>("");
  const [qty, setQty] = useState(1);
  const [showPayment, setShowPayment] = useState(false);
  const [pricePaid, setPricePaid] = useState("");

  const { data: collections = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["collections"],
    queryFn: async () => {
      const res = await fetch("/api/collections", { credentials: "include" });
      if (!res.ok) return [];
      return (await res.json()).data ?? [];
    },
  });

  const marketPrice = card.marketPrice ?? null;
  const imgSrc = card.imageUrl ?? undefined;
  const setLabel = card.setName ?? "";
  const showSet = setLabel && setLabel.toLowerCase() !== "unknown set";

  const conditionOptions = grader === "PSA" ? PSA_CONDITIONS : RAW_CONDITIONS;

  const onGraderChange = (g: "RAW" | "PSA") => {
    setGrader(g);
    setCondition(g === "PSA" ? PSA_CONDITIONS[0].value : RAW_CONDITIONS[0].value);
  };

  /** Persisted condition: PSA → "PSA <grade>"; RAW → the raw code (e.g. "NM"). */
  function resolveCondition(): string {
    if (grader === "PSA") {
      const grade = condition.match(/\d+(?:\.\d+)?/)?.[0] ?? "10";
      return `PSA ${grade}`;
    }
    return condition;
  }

  async function handleAdd() {
    setAdding(true);
    setErrMsg(null);
    try {
      const cardPayload: Record<string, unknown> = {
        externalId: card.externalId,
        name: card.name,
        setName: card.setName ?? undefined,
        marketPrice,
        quantity: qty,
        isFoil: false,
        condition: resolveCondition(),
      };
      if (collectionId) cardPayload.collectionId = collectionId;
      const paid = Number.parseFloat(pricePaid);
      if (showPayment && Number.isFinite(paid) && paid > 0) cardPayload.purchasePrice = paid;
      if (imgSrc && typeof imgSrc === "string" && imgSrc.trim().length > 0) {
        cardPayload.imageUrl = imgSrc;
      }

      const res = await fetch("/api/users/me/collection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cards: [cardPayload] }),
      });
      const json = await res.json();
      if (!res.ok || json.added === 0) {
        throw new Error(json?.message ?? "Could not add this card.");
      }
      queryClient.invalidateQueries({ queryKey: ["collection"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio-collection"] });
      queryClient.invalidateQueries({ queryKey: ["collections"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio-history"] });
      onAdded(`Added ${card.name} to your portfolio`);
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : "Something went wrong.");
      setAdding(false);
    }
  }

  const label: React.CSSProperties = { fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "9px", letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--color-dojo-faint)" };

  return (
    <>
      <div
        onClick={adding ? undefined : onClose}
        style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(0,0,0,0.6)", animation: "dojo-fade-in 180ms ease-out both" }}
      />
      <div
        role="dialog"
        aria-label="Add card to portfolio"
        data-testid="graded-add-modal"
        style={{
          position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 91,
          background: "var(--color-dojo-card)",
          borderTop: "1px solid var(--color-dojo-stroke)",
          padding: "10px 22px 26px",
          paddingBottom: "calc(26px + env(safe-area-inset-bottom, 0px))",
          maxHeight: "90vh", overflowY: "auto",
          animation: "dojo-slide-up 220ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
          maxWidth: "480px", marginLeft: "auto", marginRight: "auto",
        }}
      >
        <div aria-hidden="true" style={{ width: "40px", height: "4px", borderRadius: "2px", background: "var(--color-dojo-stroke)", margin: "0 auto 14px" }} />

        <div style={{ display: "flex", alignItems: "center", marginBottom: "16px" }}>
          <span style={label}>Add Card</span>
          <button
            onClick={onClose}
            disabled={adding}
            aria-label="Close"
            style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--color-dojo-body)", cursor: "pointer", display: "flex", padding: 0, opacity: adding ? 0.4 : 1 }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
              <line x1="3" y1="3" x2="15" y2="15" />
              <line x1="15" y1="3" x2="3" y2="15" />
            </svg>
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "flex-start", gap: "12px", marginBottom: "18px" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="dojo-heading" style={{ fontSize: "18px", lineHeight: 1.2 }}>{card.name}</div>
            {showSet && (
              <div style={{ marginTop: "4px", fontSize: "11.5px", color: "var(--color-dojo-body)" }}>
                {setLabel}{grader === "PSA" ? ` · ${resolveCondition()}` : " · Raw"}
              </div>
            )}
            <div style={{ marginTop: "8px", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "22px", fontVariantNumeric: "tabular-nums", color: marketPrice != null ? "var(--color-dojo-gold)" : "var(--color-dojo-faint)" }}>
              {marketPrice != null ? fmtUSD(marketPrice) : "—"}
            </div>
          </div>
          {imgSrc && (
            <div style={{ flex: "none", width: "62px" }}>
              <CardImage src={imgSrc} alt={card.name} initials={cardInitials(card.name)} initialsSize="14px" style={{ background: "var(--color-dojo-raised)", border: "none" }} />
            </div>
          )}
        </div>

        {errMsg && (
          <div style={{ background: "var(--color-dojo-app)", border: "1px solid var(--color-dojo-vermilion)", padding: "10px 12px", marginBottom: "16px" }}>
            <p className="dojo-error" style={{ margin: 0, fontSize: "12px" }}>{errMsg}</p>
          </div>
        )}

        {/* GRADER — RAW / PSA segmented pills */}
        <div style={{ ...label, marginBottom: "8px" }}>Grader</div>
        <div role="radiogroup" aria-label="Grading Company" style={{ display: "flex", border: "1px solid var(--color-dojo-stroke)", marginBottom: "18px" }}>
          {(["RAW", "PSA"] as const).map((g) => {
            const on = grader === g;
            return (
              <button
                key={g}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onGraderChange(g)}
                style={{
                  flex: 1, padding: "11px 0", cursor: "pointer", border: "none",
                  background: on ? "var(--color-dojo-gold)" : "var(--color-dojo-card)",
                  color: on ? "var(--color-dojo-app)" : "var(--color-dojo-faint)",
                  fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px", letterSpacing: "0.14em",
                }}
              >
                {g}
              </button>
            );
          })}
        </div>

        {/* CONDITION — RAW: Near mint / Lightly played / … ; PSA: Gem Mint 10 / … */}
        <div style={{ ...label, marginBottom: "8px" }}>Condition</div>
        <div style={{ marginBottom: "18px" }}>
          <DojoSelect
            ariaLabel="Condition"
            testId="condition-select"
            placeholder="Select condition"
            value={condition}
            options={conditionOptions}
            onChange={setCondition}
          />
        </div>

        {/* COLLECTION + QTY */}
        <div style={{ display: "flex", gap: "12px", marginBottom: "18px" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ ...label, marginBottom: "8px" }}>Collection</div>
            <DojoSelect
              ariaLabel="Collection"
              testId="collection-select"
              value={collectionId}
              options={[{ label: "Main", value: "" }, ...collections.map((c) => ({ label: c.name, value: c.id }))]}
              onChange={setCollectionId}
            />
          </div>
          <div style={{ flex: "none" }}>
            <div style={{ ...label, marginBottom: "8px" }}>Qty</div>
            <div style={{ display: "flex", alignItems: "center", border: "1px solid var(--color-dojo-stroke)" }}>
              <button type="button" aria-label="Decrease quantity" onClick={() => setQty((q) => Math.max(1, q - 1))}
                style={{ width: "34px", height: "38px", border: "none", background: "transparent", color: "var(--color-dojo-ink)", cursor: "pointer", fontSize: "16px" }}>−</button>
              <div style={{ width: "34px", textAlign: "center", fontFamily: "var(--font-display)", fontWeight: 700, fontVariantNumeric: "tabular-nums", fontSize: "14px", color: "var(--color-dojo-ink)" }}>{qty}</div>
              <button type="button" aria-label="Increase quantity" onClick={() => setQty((q) => q + 1)}
                style={{ width: "34px", height: "38px", border: "none", background: "transparent", color: "var(--color-dojo-ink)", cursor: "pointer", fontSize: "16px" }}>+</button>
            </div>
          </div>
        </div>

        {/* RECORD PAYMENT (optional) */}
        <div style={{ display: "flex", alignItems: "center", marginBottom: showPayment ? "8px" : "20px" }}>
          <span style={label}>Record Payment</span>
          <span style={{ marginLeft: "6px", fontSize: "9px", color: "var(--color-dojo-faint)", textTransform: "lowercase", letterSpacing: 0 }}>optional</span>
          {!showPayment && (
            <button type="button" onClick={() => setShowPayment(true)}
              style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-gold)" }}>
              + Add
            </button>
          )}
        </div>
        {showPayment && (
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            placeholder="Price paid (USD)"
            aria-label="Price paid"
            value={pricePaid}
            onChange={(e) => setPricePaid(e.target.value)}
            className="dojo-input"
            style={{ width: "100%", marginBottom: "20px" }}
          />
        )}

        <button
          type="button"
          onClick={handleAdd}
          disabled={adding}
          className="dojo-btn dojo-btn-primary"
          style={{ width: "100%" }}
        >
          {adding ? "ADDING…" : "ADD TO PORTFOLIO"}
        </button>
      </div>
    </>
  );
}
