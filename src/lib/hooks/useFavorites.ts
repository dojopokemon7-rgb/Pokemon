"use client";

/**
 * useFavorites — client hook for the server-backed favorites feature.
 *
 * Wraps GET/POST/DELETE /api/users/me/favorites in React Query so the
 * star buttons persist across sessions (previously they were local
 * React state that reset on refresh). Exposes:
 *   - `isFavorite(externalId)` — is this card starred?
 *   - `toggle(card)` — optimistically flip the star and sync the server.
 *
 * The favorites query key is `["favorites"]`; the Favorites view on the
 * portfolio page reads the same key, so starring anywhere updates it.
 */

import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export interface FavoriteCard {
  externalId: string;
  name?: string;
  setName?: string;
  imageUrl?: string;
  marketPrice?: number | null;
}

interface FavoriteRow {
  id: string;
  cardId: string;
  createdAt: string;
  card: {
    id: string;
    externalId: string;
    name: string;
    rarity: string | null;
    imageUrl: string | null;
    imageUrlHi: string | null;
    marketPrice: number | null;
    set: { name: string } | null;
  };
}

interface FavoritesResponse {
  favorites: FavoriteRow[];
}

/** Build a placeholder FavoriteRow for the optimistic cache update. Only
 *  `card.externalId` is read by `favoriteIds`; the rest mirror the card so
 *  the Favorites view renders sensibly until the refetch replaces it. */
function optimisticRow(card: FavoriteCard): FavoriteRow {
  return {
    id: `optimistic-${card.externalId}`,
    cardId: card.externalId,
    createdAt: new Date().toISOString(),
    card: {
      id: card.externalId,
      externalId: card.externalId,
      name: card.name ?? "",
      rarity: null,
      imageUrl: card.imageUrl ?? null,
      imageUrlHi: null,
      marketPrice: card.marketPrice ?? null,
      set: card.setName ? { name: card.setName } : null,
    },
  };
}

export function useFavorites() {
  const queryClient = useQueryClient();

  const { data } = useQuery<FavoritesResponse>({
    queryKey: ["favorites"],
    queryFn: async () => {
      const res = await fetch("/api/users/me/favorites");
      if (!res.ok) return { favorites: [] };
      return res.json();
    },
    staleTime: 30_000,
  });

  const favorites = data?.favorites ?? [];
  // Set of favorited externalIds for O(1) lookups by the star buttons.
  const favoriteIds = new Set(favorites.map((f) => f.card.externalId));

  const mutation = useMutation({
    mutationFn: async ({ card, next }: { card: FavoriteCard; next: boolean }) => {
      const res = await fetch("/api/users/me/favorites", {
        method: next ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          next
            ? {
                externalId: card.externalId,
                name: card.name,
                setName: card.setName,
                imageUrl: card.imageUrl,
                marketPrice: card.marketPrice ?? null,
              }
            : { externalId: card.externalId }
        ),
      });
      if (!res.ok) throw new Error("Favorite request failed");
      return res.json();
    },
    // F-20: optimistic UI. Flip the cached favourites list immediately so
    // `isFavorite` (and the star's aria-pressed) updates before the network
    // resolves, and snapshot the previous list so onError can roll back.
    onMutate: async ({ card, next }) => {
      await queryClient.cancelQueries({ queryKey: ["favorites"] });
      const previous = queryClient.getQueryData<FavoritesResponse>(["favorites"]);

      queryClient.setQueryData<FavoritesResponse>(["favorites"], (old) => {
        const rows = old?.favorites ?? [];
        if (next) {
          if (rows.some((r) => r.card.externalId === card.externalId)) return old ?? { favorites: rows };
          return { favorites: [...rows, optimisticRow(card)] };
        }
        return { favorites: rows.filter((r) => r.card.externalId !== card.externalId) };
      });

      return { previous };
    },
    // Roll back to the snapshot the click started from.
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["favorites"], context.previous);
      }
    },
    // Reconcile with the server once the dust settles (success OR failure).
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["favorites"] });
    },
  });

  const isFavorite = useCallback(
    (externalId: string) => favoriteIds.has(externalId),
    [favoriteIds]
  );

  /** Toggles the favorite and returns the new state (for toast copy). */
  const toggle = useCallback(
    (card: FavoriteCard): boolean => {
      const next = !favoriteIds.has(card.externalId);
      mutation.mutate({ card, next });
      return next;
    },
    [favoriteIds, mutation]
  );

  return { favorites, isFavorite, toggle };
}
