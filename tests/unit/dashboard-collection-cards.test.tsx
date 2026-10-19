import { it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

/**
 * QA D8 — the Home dashboard must surface each collection as its OWN card tile
 * on the DEFAULT view (owner decision Option 2+3), not only as thin rows inside
 * the non-default "Collections" tab. Client's words: "Dashboard doesn't show
 * multiple collections as separate cards."
 *
 * This pins the regression directly: with ≥2 collections, the default view (NO
 * tab click) renders ≥2 tiles queryable by data-testid="collection-card", each
 * showing its name + value, and each tile is a keyboard-operable button with an
 * accessible name. The tiles reuse the existing collOptions aggregation, so the
 * values here come straight from the seeded lots (no recompute in the test).
 *
 * jsdom has NO layout engine, so the responsive column count (2 cols phone → 3
 * cols ≥768px via .dojo-coll-grid) and horizontal layout are NOT verified here
 * — that is manual/visual only, exactly as shell-collapse-toggle documents.
 *
 * DashboardClient imports only next/link (not next/navigation) and HeaderLeftSlot
 * safely no-ops without its provider, so no navigation/header-slot mock is needed.
 */

import DashboardClient, {
  type CollectionItem,
} from "@/app/(dashboard)/dashboard/_components/DashboardClient";

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// One owned lot filed under a named collection, priced so each collection has a
// distinct marketValue the tile can display.
function lot(id: string, collectionId: string, marketPrice: number): CollectionItem {
  return {
    id,
    cardId: `card-${id}`,
    quantity: 1,
    isFoil: false,
    purchasePrice: null,
    collectionId,
    isSold: false,
    card: {
      id: `card-${id}`,
      externalId: `base1-${id}`,
      name: `Card ${id}`,
      imageUrl: null,
      marketPrice,
      weeklyChangePct: null,
      set: { name: "Base Set" },
    },
  };
}

afterEach(() => {
  // no global mocks to restore
});

it("renders one card tile per collection on the default view (D8)", () => {
  const collections = [
    { id: "coll-a", name: "Charizard Vault" },
    { id: "coll-b", name: "Trainer Gallery" },
  ];
  const initialItems: CollectionItem[] = [
    lot("1", "coll-a", 100),
    lot("2", "coll-b", 50),
  ];

  render(
    createElement(DashboardClient, {
      firstName: "Ash",
      initialItems,
      collections,
    }),
    { wrapper: wrapper(makeClient()) }
  );

  // Default view (no tab click): ≥2 tiles → pins "multiple collections → multiple cards".
  const tiles = screen.getAllByTestId("collection-card");
  expect(tiles.length).toBeGreaterThanOrEqual(2);

  // Each collection name + value is present WITHIN its own tile (the name also
  // appears in the focus pills elsewhere, so scope the assertion to the tiles).
  const byName = (n: string) => tiles.find((t) => t.textContent?.includes(n));
  const vault = byName("Charizard Vault");
  const gallery = byName("Trainer Gallery");
  expect(vault).toBeTruthy();
  expect(gallery).toBeTruthy();

  // Values come straight from the seeded lots via the existing aggregation.
  expect(vault!.textContent).toContain("$100.00");
  expect(gallery!.textContent).toContain("$50.00");
});

it("each tile is an accessible, keyboard-operable button", () => {
  const collections = [{ id: "coll-a", name: "Charizard Vault" }];
  const initialItems: CollectionItem[] = [lot("1", "coll-a", 100)];

  render(
    createElement(DashboardClient, {
      firstName: "Ash",
      initialItems,
      collections,
    }),
    { wrapper: wrapper(makeClient()) }
  );

  // Accessible name present (buttons are natively keyboard-operable).
  const btn = screen.getByRole("button", { name: /View Charizard Vault collection/ });
  expect(btn.tagName).toBe("BUTTON");
});
