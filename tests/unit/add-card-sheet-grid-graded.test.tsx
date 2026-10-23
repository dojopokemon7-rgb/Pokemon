import { it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { AddCardSheet, type AddableCard } from "@/components/AddCardSheet";

/**
 * Grid "+" graded parity — the Explore search-grid "+" opens AddCardSheet WITHOUT
 * a `gradedPrices` prop (TrendingCard / CardResult don't carry graded prices).
 * The sheet must then self-fetch GET /api/cards/[id]/prices and offer the card's
 * REAL stored graded graders in the Grader dropdown, exactly like the detail
 * page. A card with no stored graded rows stays Raw-only (RULE 2 — no fabrication).
 *
 * fetch is mocked per-URL: /prices returns the graded rows under test; the
 * /collections call the sheet also makes resolves to an empty list. No network.
 */

// Raw CurrentPrice-shaped rows as GET /api/cards/[id]/prices returns them.
const PRICED_ROWS = [
  { type: "raw", company: null, grade: null, priceMarket: 12, priceLow: null },
  { type: "graded", company: "psa", grade: "10", priceMarket: 500, priceLow: null },
  { type: "graded", company: "cgc", grade: "9.5", priceMarket: 300, priceLow: null },
];

function mockFetch(pricesRows: unknown[]) {
  return vi.fn(async (url: string) => {
    if (typeof url === "string" && url.includes("/prices")) {
      return new Response(JSON.stringify({ prices: pricesRows, weeklyChangePct: null }), { status: 200 });
    }
    // /api/collections and anything else → empty list (same as the other tests).
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  });
}

function mount(card: Partial<AddableCard>, pricesRows: unknown[]) {
  vi.stubGlobal("fetch", mockFetch(pricesRows));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(AddCardSheet, {
        // Grid shape: externalId + display fields, NO gradedPrices prop.
        card: { externalId: "base1-4", name: "Alakazam", ...card },
        onClose: vi.fn(),
        onAdded: vi.fn(),
      })
    )
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Open the grader dropdown and return its listbox element.
async function openGraderMenu() {
  fireEvent.click(screen.getByTestId("grader-select"));
  return screen.getByRole("listbox", { name: "Grader" });
}

it("grid '+' with stored graded prices offers the real graded graders (not Raw-only)", async () => {
  mount({ marketPrice: 12 }, PRICED_ROWS);

  // Default selection is still Raw (Raw is addable immediately, never blocked on
  // the fetch).
  expect(screen.getByTestId("grader-select").textContent).toMatch(/raw/i);

  // Once the self-fetch of /prices resolves, the grader dropdown lists the
  // card's real graders. Open it and assert PSA + CGC options appeared.
  await waitFor(async () => {
    const menu = await openGraderMenu();
    expect(within(menu).getByText("PSA")).toBeTruthy();
  });
  const menu = screen.getByRole("listbox", { name: "Grader" });
  expect(within(menu).getByText("PSA")).toBeTruthy();
  expect(within(menu).getByText("CGC")).toBeTruthy();
  expect(within(menu).getByText("Raw")).toBeTruthy();
});

it("grid '+' with NO graded rows stays Raw-only (no fabricated grader)", async () => {
  const RAW_ONLY = [{ type: "raw", company: null, grade: null, priceMarket: 12, priceLow: null }];
  mount({ marketPrice: 12 }, RAW_ONLY);

  // Let the self-fetch settle, then the grader dropdown must contain ONLY Raw.
  await waitFor(() => {
    // the collections+prices queries have resolved by now
    expect(screen.getByTestId("grader-select").textContent).toMatch(/raw/i);
  });
  const menu = await openGraderMenu();
  const options = within(menu).getAllByRole("option");
  expect(options).toHaveLength(1);
  expect(options[0].textContent).toMatch(/raw/i);
  expect(within(menu).queryByText("PSA")).toBeNull();
  expect(within(menu).queryByText("CGC")).toBeNull();
});
