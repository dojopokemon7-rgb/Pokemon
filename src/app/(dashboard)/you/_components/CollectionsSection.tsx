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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
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

  async function handleUpdate(id: string, v: FormValues) {
    setBusy(true);
    try {
      await fetch(`/api/collections/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(v),
      });
      setEditingId(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/collections/${id}`, { method: "DELETE", credentials: "include" });
      setConfirmingId(null);
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
            onClick={() => { setAdding(true); setEditingId(null); }}
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
            onClick={() => { setAdding(true); setEditingId(null); }}
            className="dojo-btn dojo-btn-primary"
            style={{ width: "auto", height: "40px", padding: "0 20px", margin: "0 auto" }}
          >
            + Add Collection
          </button>
        </div>
      )}

      {collections.map((c) =>
        editingId === c.id ? (
          <CollectionForm
            key={c.id}
            initial={{ name: c.name, isPrivate: c.isPrivate, typeTag: c.typeTag }}
            submitLabel="Save"
            busy={busy}
            onSubmit={(v) => handleUpdate(c.id, v)}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <div
            key={c.id}
            data-testid="collection-row"
            style={{ display: "flex", alignItems: "center", gap: "10px", padding: "13px 0", borderBottom: "1px solid var(--color-dojo-divider)" }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13.5px", color: "var(--color-dojo-ink)" }}>
                {c.name}
              </div>
              <div style={{ marginTop: "3px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
                {c.isPrivate ? "Private" : "Public"} · {c.typeTag}
              </div>
            </div>
            <button
              type="button"
              onClick={() => { setEditingId(c.id); setAdding(false); }}
              style={{ ...linkBtn, color: "var(--color-dojo-gold)" }}
            >
              Edit
            </button>
            {confirmingId === c.id ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleDelete(c.id)}
                  style={{ ...linkBtn, color: "var(--color-dojo-vermilion)" }}
                >
                  Confirm Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingId(null)}
                  style={{ ...linkBtn, color: "var(--color-dojo-faint)" }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingId(c.id)}
                style={{ ...linkBtn, color: "var(--color-dojo-vermilion)" }}
              >
                Delete
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
}
