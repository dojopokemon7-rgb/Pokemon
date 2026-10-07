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
import { isMainCollectionName } from "@/lib/utils/main-collection";

// Minimal shape every caller can satisfy (explore tile, search result, or the
// card-detail header). externalId is the catalog id sent to the collection API.
// A single graded price entry for the card (company + grade + its live price).
export interface GradedPriceEntry {
  company: string; // "PSA" | "CGC" | "BGS" | …
  grade: string;   // "10" | "9.5" | …
  price: number | null;
}

// Minimal shape every caller can satisfy (explore tile, search result, or the
// card-detail header). externalId is the catalog id sent to the collection API.
export interface AddableCard {
  externalId: string;
  name: string;
  setName?: string | null;
  imageUrl?: string | null;
  /** Raw Near-Mint market price (the "Raw" grader's live value). */
  marketPrice?: number | null;
  /** EVERY stored graded price for THIS card (PSA/CGC/BGS/… each grade). Drives
   *  the single Grader dropdown + the live price shown per selection. */
  gradedPrices?: GradedPriceEntry[];
}

/** Server max per add (AddCardSchema quantity ≤ 999). */
const MAX_QTY = 999;

const KNOWN_GRADERS = ["PSA", "BGS", "CGC", "SGC", "TAG", "ACE", "AGS"] as const;

// PSA-style grade label by numeric grade (used for every company's grades).
const GRADE_LABEL: Record<string, string> = {
  "10": "Gem Mint 10", "9.5": "9.5", "9": "Mint 9", "8.5": "8.5", "8": "NM-MT 8",
  "7.5": "7.5", "7": "NM 7", "6": "EX-MT 6", "5.5": "5.5", "5": "EX 5",
  "4": "VG-EX 4", "3": "VG 3", "2": "Good 2", "1.5": "Fair 1.5", "1": "Poor 1",
};

/** "PSA 10" / "BGS 9.5" → { grader, grade }; null when it names no company. */
export function parseGraded(
  condition: string | undefined | null
): { grader: string; grade: string } | null {
  if (!condition) return null;
  const grader = KNOWN_GRADERS.find((g) => new RegExp(`\\b${g}\\b`, "i").test(condition));
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
  /** "PSA 10" pre-opens that grader + grade. */
  initialCondition?: string;
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const marketPrice = card.marketPrice ?? null;
  const imgSrc = card.imageUrl ?? undefined;
  const setLabel = card.setName ?? "";
  const showSet = setLabel && setLabel.toLowerCase() !== "unknown set";

  // Build the GRADER list from what the card actually has: "Raw" first (when a
  // raw price exists), then every company present in gradedPrices, uppercased
  // and de-duplicated. graded[company][grade] = live price.
  const graded = card.gradedPrices ?? [];
  const byCompany = new Map<string, Map<string, number | null>>();
  for (const g of graded) {
    const co = (g.company ?? "").toUpperCase();
    if (!co || !g.grade) continue;
    if (!byCompany.has(co)) byCompany.set(co, new Map());
    byCompany.get(co)!.set(g.grade, g.price ?? null);
  }

  // When the caller pre-selects a graded condition (e.g. a search tile passing
  // initialCondition="PSA 10") but has no stored gradedPrices for that grader,
  // seed the grader+grade so it is OFFERED in the dropdown and pre-selected.
  // Its live price stays null → "—" (honest: no stored price here; the Explore
  // tile only knows the raw price). This keeps the grader list card-accurate
  // while still exposing the grader the user intends to add.
  const initParsed = parseGraded(initialCondition);
  if (initParsed) {
    const co = initParsed.grader;
    const gr = initParsed.grade || "10";
    if (!byCompany.has(co)) byCompany.set(co, new Map());
    if (!byCompany.get(co)!.has(gr)) byCompany.get(co)!.set(gr, null);
  }
  const companyOrder = [
    ...KNOWN_GRADERS.filter((c) => byCompany.has(c)),
    ...[...byCompany.keys()].filter((c) => !KNOWN_GRADERS.includes(c as (typeof KNOWN_GRADERS)[number])).sort(),
  ];
  // Grader dropdown options: "Raw" (value "RAW") + each company (value = company).
  // FEAT-004: Raw is ALWAYS first (its live price shows "—" when there is no raw
  // price), so a card with graded prices but a null raw price no longer defaults
  // to PSA 10. The header price for Raw stays null → "—" (never fabricated).
  const graderOptions = [
    { label: "Raw", value: "RAW" },
    ...companyOrder.map((c) => ({ label: c, value: c })),
  ];

  // Grades for a given grader, numeric-desc, as condition dropdown options.
  function gradesFor(graderVal: string): { label: string; value: string }[] {
    if (graderVal === "RAW") return [{ label: "Near mint", value: "NM" }];
    const grades = [...(byCompany.get(graderVal)?.keys() ?? [])].sort((a, b) => parseFloat(b) - parseFloat(a));
    const list = grades.length ? grades : ["10"];
    return list.map((g) => ({ label: GRADE_LABEL[g] ?? g, value: `Grade ${g}` }));
  }

  const parsed = initParsed;
  const initialGrader =
    parsed && byCompany.has(parsed.grader) ? parsed.grader : graderOptions[0].value;
  const [grader, setGrader] = useState<string>(initialGrader);
  const [condition, setCondition] = useState<string>(
    parsed && byCompany.has(parsed.grader) ? `Grade ${parsed.grade}` : gradesFor(initialGrader)[0].value
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

  const conditionOptions = gradesFor(grader);

  const onGraderChange = (g: string) => {
    setGrader(g);
    setCondition(gradesFor(g)[0].value);
  };

  // LIVE price for the current grader + grade selection. Raw → marketPrice;
  // graded → the stored price for that company+grade. Drives the big header
  // price so it updates as you switch grader/grade (not stuck on raw).
  const selectedGrade = condition.match(/\d+(?:\.\d+)?/)?.[0] ?? "";
  const livePrice =
    grader === "RAW" ? marketPrice : byCompany.get(grader)?.get(selectedGrade) ?? null;

  /** Persisted condition: PSA → "PSA <grade>"; RAW → the raw code (e.g. "NM"). */
  function resolveCondition(): string {
    if (grader === "RAW") return condition; // raw grade code (e.g. "NM")
    const grade = condition.match(/\d+(?:\.\d+)?/)?.[0] ?? "10";
    return `${grader} ${grade}`; // "PSA 10", "CGC 9.5", "BGS 10", …
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
                {setLabel} · {grader === "RAW" ? "Raw" : resolveCondition()}
              </div>
            )}
            {/* LIVE price for the selected grader + grade (updates on change). */}
            <div style={{ marginTop: "8px", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "22px", fontVariantNumeric: "tabular-nums", color: livePrice != null ? "var(--color-dojo-gold)" : "var(--color-dojo-faint)" }}>
              {livePrice != null ? fmtUSD(livePrice) : "—"}
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

        {/* GRADER — single dropdown listing every grader this card has
            (Raw + PSA/CGC/BGS/… present in its stored prices). */}
        <div style={{ ...label, marginBottom: "8px" }}>Grader</div>
        <div style={{ marginBottom: "18px" }}>
          <DojoSelect
            ariaLabel="Grader"
            testId="grader-select"
            value={grader}
            options={graderOptions}
            onChange={onGraderChange}
          />
        </div>

        {/* CONDITION — grades available for the selected grader (per-card). */}
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
              // "" = Main (the server files it under the user's Main). A real
              // Main row and the nameless "__uncat__" pseudo-entry are dropped
              // so Main is not listed twice.
              options={[
                { label: "Main", value: "" },
                ...collections
                  .filter((c) => c.name && !isMainCollectionName(c.name))
                  .map((c) => ({ label: c.name, value: c.id })),
              ]}
              onChange={setCollectionId}
            />
          </div>
          <div style={{ flex: "none" }}>
            <div style={{ ...label, marginBottom: "8px" }}>Qty</div>
            <div style={{ display: "flex", alignItems: "center", border: "1px solid var(--color-dojo-stroke)" }}>
              <button type="button" aria-label="Decrease quantity" onClick={() => setQty((q) => Math.max(1, q - 1))}
                style={{ width: "34px", height: "38px", border: "none", background: "transparent", color: "var(--color-dojo-ink)", cursor: "pointer", fontSize: "16px" }}>−</button>
              <div style={{ width: "34px", textAlign: "center", fontFamily: "var(--font-display)", fontWeight: 700, fontVariantNumeric: "tabular-nums", fontSize: "14px", color: "var(--color-dojo-ink)" }}>{qty}</div>
              <button type="button" aria-label="Increase quantity" onClick={() => setQty((q) => Math.min(MAX_QTY, q + 1))}
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
