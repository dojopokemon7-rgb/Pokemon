/**
 * Pending Collection Handoff (sessionStorage)
 *
 * The "add cards to my collection" flow spans two routes:
 *   1. /search (trending grid) or /search/multi (list + checkboxes)
 *      — where a user selects one or more cards.
 *   2. /collection/add — where the actual POST to
 *      /api/users/me/collection happens and the user confirms.
 *
 * Card identity/price/image already lives in the search result the
 * user is looking at; there's no reason to re-fetch it on the next
 * page. sessionStorage is the simplest way to hand that payload off
 * across the client-side navigation without polluting the URL with
 * a potentially large querystring (up to 50 cards).
 *
 * Values are cleared once read by /collection/add — this is a
 * one-shot handoff, not a persistent cart.
 */

const STORAGE_KEY = "dojo:pending-collection-cards";

/**
 * Shape of a single card queued for addition. Mirrors the server's
 * `AddCardSchema` in /api/users/me/collection/route.ts exactly, so the
 * payload can be sent to that endpoint with no transformation.
 */
export interface PendingCollectionCard {
  externalId: string;
  name: string;
  setName?: string;
  imageUrl?: string;
  rarity?: string;
  types?: string[];
  marketPrice?: number | null;
  quantity: number;
  isFoil: boolean;
}

/** Stores the selected cards for /collection/add to pick up. */
export function setPendingCollectionCards(cards: PendingCollectionCard[]): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
  } catch (err) {
    console.warn("[pending-collection] Failed to write sessionStorage:", err);
  }
}

/**
 * Reads the queued cards WITHOUT clearing them.
 * Use this in useEffect to get the cards, and call clearPendingCollectionCards()
 * only after successful submission.
 */
export function getPendingCollectionCards(): PendingCollectionCard[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn("[pending-collection] Failed to read sessionStorage:", err);
    return [];
  }
}

/** Clears the queued cards after they've been used. */
export function clearPendingCollectionCards(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore errors on clear
  }
}

/**
 * Reads and clears the queued cards. Returns an empty array if none exist.
 * @deprecated Use getPendingCollectionCards() + clearPendingCollectionCards() instead
 * to avoid React Strict Mode double-mount issues.
 */
export function takePendingCollectionCards(): PendingCollectionCard[] {
  const cards = getPendingCollectionCards();
  clearPendingCollectionCards();
  return cards;
}
