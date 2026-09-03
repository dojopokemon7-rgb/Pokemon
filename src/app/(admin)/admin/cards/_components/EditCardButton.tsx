"use client";

/**
 * Edit-card button + modal.
 *
 * Renders a small "Edit" trigger in the row and opens a modal with
 * inputs for Market Price and Image URL. Uses React Query for the
 * PATCH mutation; on success it shows a transient toast, refreshes
 * the server component, and closes the modal.
 *
 * Empty strings are converted to `null` before sending — that maps
 * cleanly to Prisma's optional/nullable columns.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";

interface Card {
  id: string;
  name: string;
  marketPrice: number | null;
  imageUrl: string | null;
}

interface UpdatePayload {
  marketPrice?: number | null;
  imageUrl?: string | null;
}

async function patchCard(id: string, body: UpdatePayload): Promise<void> {
  const res = await fetch(`/api/admin/cards/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(data.message ?? `Update failed (${res.status})`);
  }
}

export function EditCardButton({ card }: { card: Card }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="dojo-btn dojo-btn-outline-sm"
        onClick={() => setOpen(true)}
      >
        Edit
      </button>
      {open ? <EditCardModal card={card} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function EditCardModal({
  card,
  onClose,
}: {
  card: Card;
  onClose: () => void;
}) {
  const router = useRouter();
  const [price, setPrice] = useState(
    card.marketPrice != null ? String(card.marketPrice) : ""
  );
  const [imageUrl, setImageUrl] = useState(card.imageUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstInputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const mutation = useMutation({
    mutationFn: (body: UpdatePayload) => patchCard(card.id, body),
    onSuccess: () => {
      setToast("Saved");
      // Refresh the server component so the table reflects the new values.
      router.refresh();
      // Small delay so the toast is visible before the modal closes.
      window.setTimeout(onClose, 700);
    },
    onError: (e: unknown) => {
      setError(e instanceof Error ? e.message : "Update failed");
    },
  });

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const body: UpdatePayload = {};

    const trimmedPrice = price.trim();
    if (trimmedPrice === "") {
      if (card.marketPrice != null) body.marketPrice = null;
    } else {
      const parsed = Number(trimmedPrice);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setError("Enter a valid non-negative number for price.");
        return;
      }
      if (parsed !== card.marketPrice) body.marketPrice = parsed;
    }

    const trimmedImage = imageUrl.trim();
    if (trimmedImage === "") {
      if (card.imageUrl != null) body.imageUrl = null;
    } else {
      try {
        new URL(trimmedImage);
      } catch {
        setError("Image URL must be a valid absolute URL.");
        return;
      }
      if (trimmedImage !== card.imageUrl) body.imageUrl = trimmedImage;
    }

    if (Object.keys(body).length === 0) {
      setError("Nothing to change.");
      return;
    }

    mutation.mutate(body);
  }

  return (
    <>
      <div
        className="dojo-scrim"
        onClick={onClose}
        role="presentation"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-card-title"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "min(480px, calc(100vw - 32px))",
          background: "var(--color-dojo-card)",
          border: "1px solid var(--color-dojo-stroke)",
          zIndex: 90,
          padding: "24px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <h2
            id="edit-card-title"
            className="dojo-heading"
            style={{ fontSize: "20px" }}
          >
            Edit card
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="dojo-link"
            style={{ fontSize: "12px" }}
          >
            ✕
          </button>
        </div>
        <div className="dojo-faint" style={{ marginTop: "4px" }}>
          {card.name}
        </div>

        <form onSubmit={handleSave} style={{ marginTop: "20px" }}>
          <div className="dojo-input-wrap" style={{ marginBottom: "14px" }}>
            <label className="dojo-label" htmlFor="edit-card-price">
              Market Price (USD)
            </label>
            <input
              id="edit-card-price"
              ref={firstInputRef}
              type="number"
              step="0.01"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="dojo-input"
              placeholder="e.g. 1240.00"
              disabled={mutation.isPending}
            />
          </div>

          <div className="dojo-input-wrap" style={{ marginBottom: "6px" }}>
            <label className="dojo-label" htmlFor="edit-card-image">
              Image URL
            </label>
            <input
              id="edit-card-image"
              type="url"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              className="dojo-input"
              placeholder="https://…"
              disabled={mutation.isPending}
            />
          </div>

          {error ? (
            <div className="dojo-error" style={{ marginTop: "10px" }}>
              {error}
            </div>
          ) : null}

          <div
            style={{
              display: "flex",
              gap: "10px",
              marginTop: "22px",
              justifyContent: "flex-end",
            }}
          >
            <button
              type="button"
              onClick={onClose}
              className="dojo-btn dojo-btn-outline-sm"
              disabled={mutation.isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="dojo-btn dojo-btn-primary"
              style={{ width: "auto", padding: "13px 22px" }}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>

      {toast ? (
        <div
          role="status"
          style={{
            position: "fixed",
            bottom: "24px",
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--color-dojo-raised)",
            border: "1px solid var(--color-dojo-gold)",
            color: "var(--color-dojo-gold)",
            padding: "10px 18px",
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: "11px",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            zIndex: 100,
          }}
        >
          {toast}
        </div>
      ) : null}
    </>
  );
}
