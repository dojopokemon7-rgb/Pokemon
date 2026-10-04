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

it("hides ADD TO COLLECTION when every selected quantity is 0", async () => {
  // Give the raw row a REAL price so the OLD dollar gate would have SHOWN the
  // button on price alone — proving the new gate keys on quantity: with every
  // quantity cleared to 0 the button must be absent.
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

  // The button is present initially (addQty psa10 = 1). Zero every quantity by
  // clicking each stepper's decrement control (the AddQtyRow "−" button) a few
  // times, which drops addQtyTotal to 0 and must hide the button.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /ADD TO COLLECTION/i })).toBeTruthy()
  );
  // Decrement controls render the U+2212 minus; clamp at 0 so repeated clicks
  // are safe. Click each a couple times to guarantee every qty reaches 0.
  const decs = screen.getAllByText("\u2212").filter((el) => el.tagName === "BUTTON");
  expect(decs.length).toBeGreaterThan(0);
  for (const d of decs) {
    fireEvent.click(d);
    fireEvent.click(d);
  }

  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /ADD TO COLLECTION/i })).toBeNull()
  );
});
