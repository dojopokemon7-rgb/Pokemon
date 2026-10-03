"use client";

/**
 * useWantToBuy — client hook for the "Want to Buy" save action.
 *
 * Replaces the removed favorites feature: the star / "track this card"
 * control now adds a card to the user's Want to Buy list instead of a
 * separate favourites list. Backed by the existing want-list API:
 *   - GET    /api/want-list?intent=BUY   → current Buy list
 *   - POST   /api/want-list {cardId,intent:"BUY"} → add
 *   - DELETE /api/want-list/{rowId}      → remove
 *
 * Exposes the same tiny surface the old useFavorites did so callers barely
 * change: `isWanted(externalId)` and `toggle(card) → next`.
 */

import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export interface WantCard {
  externalId: string;
  name?: string;
}

interface WantRow {
  id: string;
  cardId: string; // external card id
  intent: "BUY" | "SELL" | "TRADE";
}

export function useWantToBuy() {
  const queryClient = useQueryClient();

  // Keyed to match the wantlist page / dashboard so adds here surface there.
  const { data } = useQuery<{ data: WantRow[] }>({
    queryKey: ["want-list", "BUY"],
    queryFn: async () => {
      const res = await fetch("/api/want-list?intent=BUY", { credentials: "include" });
      if (!res.ok) return { data: [] };
      return res.json();
    },
  });

  const rows = data?.data ?? [];
  // externalId → want-list row id, so toggle-off knows which row to DELETE.
  const rowByCard = new Map(rows.map((r) => [r.cardId, r.id]));

  // Optimistic cache helpers — the star reflects the tap IMMEDIATELY instead
  // of waiting for POST/DELETE + the family invalidate's refetch (the two
  // sequential round-trips the user reported as "Want to Buy taking too long").
  // onMutate mutates the ["want-list","BUY"] cache that drives `isWanted`,
  // onError reverts to the pre-tap snapshot, onSettled still invalidates the
  // whole family for eventual consistency (ARCHITECTURE.md §7 contract intact).
  const add = useMutation({
    mutationFn: async (externalId: string) => {
      const res = await fetch("/api/want-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ cardId: externalId, intent: "BUY" }),
      });
      if (!res.ok) throw new Error("Want-to-buy add failed");
      return res.json();
    },
    onMutate: async (externalId: string) => {
      await queryClient.cancelQueries({ queryKey: ["want-list"] });
      const previous = queryClient.getQueryData<{ data: WantRow[] }>(["want-list", "BUY"]);
      queryClient.setQueryData<{ data: WantRow[] }>(["want-list", "BUY"], (old) => {
        const existing = old?.data ?? [];
        if (existing.some((r) => r.cardId === externalId)) return old ?? { data: existing };
        // Synthetic optimistic row; the onSettled refetch replaces it with the real id.
        return { data: [...existing, { id: `optimistic-${externalId}`, cardId: externalId, intent: "BUY" }] };
      });
      return { previous };
    },
    onError: (_e, _externalId, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(["want-list", "BUY"], ctx.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["want-list"] }),
  });

  const remove = useMutation({
    mutationFn: async (rowId: string) => {
      const res = await fetch(`/api/want-list/${rowId}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error("Want-to-buy remove failed");
      return res.json();
    },
    onMutate: async (rowId: string) => {
      await queryClient.cancelQueries({ queryKey: ["want-list"] });
      const previous = queryClient.getQueryData<{ data: WantRow[] }>(["want-list", "BUY"]);
      queryClient.setQueryData<{ data: WantRow[] }>(["want-list", "BUY"], (old) => ({
        data: (old?.data ?? []).filter((r) => r.id !== rowId),
      }));
      return { previous };
    },
    onError: (_e, _rowId, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(["want-list", "BUY"], ctx.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["want-list"] }),
  });

  const isWanted = useCallback(
    (externalId: string) => rowByCard.has(externalId),
    [rowByCard]
  );

  /** Toggles Want to Buy for a card; returns the new state (for toast copy). */
  const toggle = useCallback(
    (card: WantCard): boolean => {
      const existingRow = rowByCard.get(card.externalId);
      if (existingRow) {
        remove.mutate(existingRow);
        return false;
      }
      add.mutate(card.externalId);
      return true;
    },
    [rowByCard, add, remove]
  );

  return { isWanted, toggle };
}
