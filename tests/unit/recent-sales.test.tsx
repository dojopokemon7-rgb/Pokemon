import { it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";
import { RecentSales } from "@/components/RecentSales";

/**
 * FEAT-003 (Part 4) — Recent Sales renders REAL Scrydex eBay SOLD records
 * (never active listings, never fabricated). Pins AC-19/AC-20/AC-21:
 *   - a non-empty { listings } renders one row per record with the sold date,
 *     the price formatted in the record's currency, a "company grade" label,
 *     and a "View sale" link where a url exists;
 *   - an empty / pending-approval response renders "No recent sales found".
 * fetch is stubbed, so NO live Scrydex /listings call is made.
 */

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

it("renders a sold row with date, formatted price, company+grade label, and View-sale link", async () => {
  const listing = {
    itemId: "ebay_1",
    source: "ebay",
    title: "Charizard",
    price: 7930,
    currency: "USD",
    soldAt: "2026-06-01",
    grade: "10",
    company: "PSA",
    url: "https://example.com/sale",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ listings: [listing] }), { status: 200 }))
  );

  const client = makeClient();
  render(
    createElement(RecentSales, { id: "base1-4", setName: "Base Set", rarity: "Rare" }),
    { wrapper: wrapper(client) }
  );

  // Price formatted in the record currency (USD).
  await waitFor(() => expect(screen.getByText("$7,930.00")).toBeTruthy());
  // "company grade" label appears in the row sub-line.
  expect(screen.getByText(/PSA 10/)).toBeTruthy();
  // The sold date is rendered (locale-formatted from 2026-06-01).
  const soldDate = new Date("2026-06-01").toLocaleDateString();
  expect(screen.getByText(new RegExp(`Sold ${soldDate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))).toBeTruthy();
  // View-sale link points at the record url.
  const link = screen.getByRole("link", { name: /View sale/i });
  expect(link.getAttribute("href")).toBe("https://example.com/sale");
});

it("renders 'No recent sales found' for an empty / pending-approval response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ listings: [], reason: "pending-approval" }), { status: 200 })
    )
  );

  const client = makeClient();
  render(
    createElement(RecentSales, { id: "base1-4", setName: "Base Set", rarity: "Rare" }),
    { wrapper: wrapper(client) }
  );

  await waitFor(() => expect(screen.getByText("No recent sales found")).toBeTruthy());
});
