/**
 * Batch add instrumentation shared by the bulk-add flows (multi-select search,
 * /collection/add). The single-card AddCardSheet tracks inline. Fires ONLY for
 * cards the server reports as really added (ok && !alreadyPresent) — never for
 * skipped/failed rows — and first_card_added only when the server says this
 * request made the user's first-ever card (`firstCard`).
 *
 * These flows add RAW copies (no grader picker), so value_usd is the card's
 * stored market price x quantity, omitted when the card has no price.
 */
import { track } from "./track";
import { cardBaseProps } from "./card-event-props";

export interface AddedItem {
  externalId: string;
  quantity: number;
  marketPrice?: number | null;
}

export interface AddResponse {
  firstCard?: boolean;
  results?: { externalId: string; ok: boolean; alreadyPresent?: boolean }[];
}

export function trackCardsAdded(items: readonly AddedItem[], resp: AddResponse): void {
  const added = new Set(
    (resp.results ?? []).filter((r) => r.ok && !r.alreadyPresent).map((r) => r.externalId)
  );
  let firstDone = false;
  for (const it of items) {
    if (!added.has(it.externalId)) continue;
    const base = cardBaseProps(it.externalId);
    track("card_added", {
      card_id: it.externalId,
      ...base,
      condition: "raw",
      quantity: it.quantity,
      value_usd: it.marketPrice != null ? it.marketPrice * it.quantity : undefined,
    });
    if (resp.firstCard === true && !firstDone) {
      firstDone = true;
      track("first_card_added", base);
    }
  }
}
