"use client";

/**
 * Collections management (F-10) — lives in the /you settings page.
 *
 * Lists the user's named collections and supports create / rename /
 * privacy+tag settings / delete against the /api/collections endpoints.
 * State is React Query so mutations refetch the list automatically.
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

type TypeTag = "POKEMON" | "ONE_PIECE" | "MIXED";

interface Collection {
  id: string;
  name: string;
  isPrivate: boolean;
  typeTag: TypeTag;
}

const TYPE_OPTIONS: TypeTag[] = ["POKEMON", "ONE_PIECE", "MIXED"];

async function fetchCollections(): Promise<Collection[]> {
  const res = await fetch("/api/collections", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load collections");
  const json = await res.json();
  return json.data as Collection[];
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

const linkBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  padding: 0,
  fontFamily: "var(--font-display)",
  fontWeight: 700,
  fontSize: "10px",
  letterSpacing: "0.14em",
  textTransform: "uppercase",
};

interface FormValues {
  name: string;
  isPrivate: boolean;
  typeTag: TypeTag;
}

function CollectionForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  busy,
}: {
  initial: FormValues;
  submitLabel: string;
  onSubmit: (v: FormValues) => void;
  onCancel?: () => void;
  busy: boolean;
}) {
  const [name, setName] = useState(initial.name);
  const [isPrivate, setIsPrivate] = useState(initial.isPrivate);
  const [typeTag, setTypeTag] = useState<TypeTag>(initial.typeTag);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "12px 0" }}>
      <label className="dojo-label" htmlFor="collection-name">Name</label>
      <input
        id="collection-name"
        className="dojo-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Collection name"
      />

      <fieldset style={{ border: "none", padding: 0, margin: 0, display: "flex", gap: "16px" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-dojo-ink)" }}>
          <input
            type="radio"
            name="privacy"
            checked={isPrivate}
            onChange={() => setIsPrivate(true)}
          />
          Private
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-dojo-ink)" }}>
          <input
            type="radio"
            name="privacy"
            checked={!isPrivate}
            onChange={() => setIsPrivate(false)}
          />
          Public
        </label>
      </fieldset>

      <label className="dojo-label" htmlFor="collection-type">Type</label>
      <select
        id="collection-type"
        className="dojo-input"
        value={typeTag}
        onChange={(e) => setTypeTag(e.target.value as TypeTag)}
      >
        {TYPE_OPTIONS.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>

      <div style={{ display: "flex", gap: "10px" }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => onSubmit({ name, isPrivate, typeTag })}
          style={{ ...linkBtn, color: "var(--color-dojo-gold)" }}
        >
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} style={{ ...linkBtn, color: "var(--color-dojo-faint)" }}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

export function CollectionsSection() {
  const qc = useQueryClient();
  const { data: collections = [], isLoading } = useQuery({
    queryKey: ["collections"],
    queryFn: fetchCollections,
  });

  const [adding, setAdding] = useState(false);
  // Which row is expanded (shows the Delete option), and which collection
  // has the delete-confirmation modal open.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ["collections"] });
  }

  async function handleCreate(v: FormValues) {
    setBusy(true);
    try {
      await fetch("/api/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(v),
      });
      setAdding(false);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/collections/${id}`, { method: "DELETE", credentials: "include" });
      setPendingDelete(null);
      setExpandedId(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  // Row-level PUBLIC/PRIVATE toggle — a partial PATCH of just `isPrivate`.
  // No-op when already in the requested state so the pills don't refetch
  // needlessly.
  async function handleSetPrivacy(id: string, isPrivate: boolean) {
    setBusy(true);
    try {
      await fetch(`/api/collections/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ isPrivate }),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ ...sectionHeading, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>Collections</span>
        {/* Visible bordered "+ Add" button (was a tiny gold text link that
            was easy to miss). Hidden while the add form is already open. */}
        {!adding && (
          <button
            type="button"
            aria-label="Add collection"
            onClick={() => { setAdding(true); setExpandedId(null); }}
            style={{
              display: "inline-flex", alignItems: "center", gap: "6px",
              padding: "6px 12px", cursor: "pointer",
              border: "1px solid var(--color-dojo-gold)", background: "rgba(233,180,59,0.08)",
              color: "var(--color-dojo-gold)",
              fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "10px",
              letterSpacing: "0.14em", textTransform: "uppercase",
            }}
          >
            <span aria-hidden="true" style={{ fontSize: "13px", lineHeight: 1 }}>+</span>
            Add Collection
          </button>
        )}
      </div>

      {adding && (
        <CollectionForm
          initial={{ name: "", isPrivate: true, typeTag: "MIXED" }}
          submitLabel="Create"
          busy={busy}
          onSubmit={handleCreate}
          onCancel={() => setAdding(false)}
        />
      )}

      {isLoading && (
        <p className="dojo-body" style={{ marginTop: "8px" }}>Loading collections…</p>
      )}

      {!isLoading && collections.length === 0 && !adding && (
        <div style={{ marginTop: "10px", textAlign: "center", padding: "24px 16px", border: "1px dashed var(--color-dojo-stroke)", background: "var(--color-dojo-card)" }}>
          <p className="dojo-body" style={{ margin: "0 0 12px" }}>
            No collections yet. Group your cards into named collections.
          </p>
          <button
            type="button"
            onClick={() => { setAdding(true); setExpandedId(null); }}
            className="dojo-btn dojo-btn-primary"
            style={{ width: "auto", height: "40px", padding: "0 20px", margin: "0 auto" }}
          >
            + Add Collection
          </button>
        </div>
      )}

      {collections.map((c) => {
        const expanded = expandedId === c.id;
        return (
          <div key={c.id} data-testid="collection-row" style={{ borderBottom: "1px solid var(--color-dojo-divider)" }}>
            {/* Row — click anywhere (except the pills) to expand the Delete
                panel. Only name + caption + PUBLIC/PRIVATE pills show here. */}
            <div
              role="button"
              tabIndex={0}
              aria-expanded={expanded}
              aria-label={`${c.name} — expand for options`}
              onClick={() => setExpandedId(expanded ? null : c.id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpandedId(expanded ? null : c.id); } }}
              style={{ display: "flex", alignItems: "center", gap: "10px", padding: "13px 0", cursor: "pointer" }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13.5px", color: "var(--color-dojo-ink)" }}>
                  {c.name}
                </div>
                <div style={{ marginTop: "3px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
                  {c.isPrivate ? "Only you" : "Visible to everyone"}
                </div>
              </div>

              {/* PUBLIC / PRIVATE pills — stop propagation so toggling privacy
                  doesn't also expand/collapse the row. */}
              <div style={{ display: "flex", flex: "none", border: "1px solid var(--color-dojo-stroke)" }}>
                {([
                  { label: "Public", value: false },
                  { label: "Private", value: true },
                ] as const).map((opt) => {
                  const active = c.isPrivate === opt.value;
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      disabled={busy}
                      aria-pressed={active}
                      aria-label={`Set ${opt.label.toLowerCase()}`}
                      onClick={(e) => { e.stopPropagation(); if (!active) handleSetPrivacy(c.id, opt.value); }}
                      style={{
                        padding: "6px 12px", cursor: active ? "default" : "pointer", border: "none",
                        background: active ? "var(--color-dojo-gold)" : "var(--color-dojo-card)",
                        color: active ? "var(--color-dojo-app)" : "var(--color-dojo-faint)",
                        fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "8.5px",
                        letterSpacing: "0.14em", textTransform: "uppercase",
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Expanded panel — single Delete action. */}
            {expanded && (
              <div style={{ padding: "0 0 13px", display: "flex" }}>
                <button
                  type="button"
                  onClick={() => setPendingDelete({ id: c.id, name: c.name })}
                  style={{ ...linkBtn, color: "var(--color-dojo-vermilion)" }}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* Double-confirm delete modal (Task 3). */}
      {pendingDelete && (
        <>
          <div onClick={() => !busy && setPendingDelete(null)} style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(0,0,0,0.6)" }} />
          <div role="dialog" aria-modal="true" aria-label="Confirm delete collection" style={{ position: "fixed", inset: 0, zIndex: 91, display: "flex", alignItems: "center", justifyContent: "center", padding: "22px", pointerEvents: "none" }}>
            <div style={{ pointerEvents: "auto", width: "100%", maxWidth: "340px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "20px" }}>
              <h2 className="dojo-heading" style={{ fontSize: "18px", margin: "0 0 10px" }}>Delete collection?</h2>
              <p className="dojo-body" style={{ margin: "0 0 18px", fontSize: "13px", lineHeight: 1.5 }}>
                Are you sure you want to delete &ldquo;{pendingDelete.name}&rdquo;? This cannot be undone.
              </p>
              <div style={{ display: "flex", gap: "10px" }}>
                <button type="button" disabled={busy} onClick={() => setPendingDelete(null)}
                  className="dojo-btn dojo-btn-outline" style={{ flex: 1, width: "auto", height: "44px" }}>
                  Cancel
                </button>
                <button type="button" disabled={busy} onClick={() => handleDelete(pendingDelete.id)}
                  style={{ flex: 1, height: "44px", cursor: "pointer", border: "1px solid var(--color-dojo-vermilion)", background: "var(--color-dojo-vermilion)", color: "#fff", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px", letterSpacing: "0.14em", textTransform: "uppercase" }}>
                  {busy ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
