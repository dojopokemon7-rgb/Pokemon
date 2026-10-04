import { it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

/**
 * FEAT-001 A2 — the ADD TO COLLECTION button must gate on the selected
 * QUANTITY, not the dollar total. An unpriced card (common via Explore, every
 * row price null → addTotal === 0) can still be added, so the button has to
 * render whenever any quantity > 0. It stays hidden only when every quantity
 * is 0. Pins the fix from `addTotal > 0` → `addQtyTotal > 0`.
 *
 * next/navigation is mocked and fetch is stubbed to return NO price (null) on
 * every card route, so the card renders fully unpriced — the exact Explore
 * case that the old dollar gate wrongly blocked. The initial addQty state is
 * { raw: 0, psa10: 1 } (one graded qty pre-selected), so the gate must show
 * the button purely on quantity.
 */

// Mock next/navigation BEFORE importing the page (hoisted by vitest).
const searchParamsMock = new URLSearchParams(); // no ?price= → unpriced card
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "base1-4" }),
  useSearchParams: () => searchParamsMock,
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));

import CardDetailPage from "@/app/(dashboard)/search/[id]/page";

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shows ADD TO COLLECTION when a quantity > 0 even though every price is null (addTotal === 0)", async () => {
  // Every card route resolves to an unpriced / empty payload — no price
  // anywhere, so the old dollar gate (addTotal > 0) would hide the button.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/graded")) return new Response(JSON.stringify({ price: null }), { status: 200 });
      if (u.includes("/prices")) return new Response(JSON.stringify({ prices: [] }), { status: 200 });
      if (u.includes("/collections")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    })
  );

  render(createElement(CardDetailPage), { wrapper: wrapper(makeClient()) });

  // Initial addQty = { raw: 0, psa10: 1 } → quantity gate is satisfied, dollar
  // gate is not. With the fix the button renders regardless of price.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /ADD TO COLLECTION/i })).toBeTruthy()
  );
});

it("ADD TO COLLECTION opens the shared AddCardSheet (RAW/PSA grader + condition)", async () => {
  // The detail page no longer has inline quantity steppers / graded rows. The
  // always-visible ADD TO COLLECTION button opens the SAME AddCardSheet the
  // Explore grid uses: a RAW/PSA grader toggle and a condition dropdown
  // (Near mint / Lightly played / …). This pins the "reuse explore add flow"
  // change (requests 1 + 2).
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/graded")) return new Response(JSON.stringify({ price: 500 }), { status: 200 });
      if (u.includes("/prices"))
        return new Response(JSON.stringify({ prices: [{ condition: "NM", priceMarket: 100 }] }), { status: 200 });
      if (u.includes("/collections")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    })
  );

  render(createElement(CardDetailPage), { wrapper: wrapper(makeClient()) });

  const addBtn = await screen.findByRole("button", { name: /ADD TO COLLECTION/i });
  fireEvent.click(addBtn);

  // The shared sheet opens with the grader radiogroup + condition select.
  const dialog = await screen.findByRole("dialog", { name: /add card to portfolio/i });
  expect(dialog).toBeTruthy();
  expect(screen.getByRole("radio", { name: /RAW/i })).toBeTruthy();
  expect(screen.getByRole("radio", { name: /PSA/i })).toBeTruthy();
  // Condition select present (RAW conditions: Near mint / Lightly played / …).
  expect(screen.getByTestId("condition-select")).toBeTruthy();
});
