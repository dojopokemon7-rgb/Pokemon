import { it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

/**
 * FEAT-002 B / HIGH-1 — after a successful add on the card-detail page, the
 * mutation `onSuccess` must invalidate the dashboard chart query family
 * `["portfolio-history"]` IN ADDITION to the three existing keys
 * (`["collection"]`, `["portfolio-collection"]`, `["collections"]`). Without
 * the fourth invalidation the chosen collection's chart (made drawable by A1)
 * does NOT refetch immediately after an add (AC-16).
 *
 * Harness mirrors add-button-gate.test.tsx: next/navigation is mocked and
 * fetch is stubbed. The add POST resolves `{ added: 1 }` so onSuccess runs.
 * We spy on queryClient.invalidateQueries and assert all four keys fire.
 */

const searchParamsMock = new URLSearchParams();
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

it("add onSuccess invalidates ['portfolio-history'] plus the three existing keys", async () => {
  // A real raw price so the ADD button is quantity-gated-visible; the POST
  // returns added:1 so onSuccess runs its invalidations.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/graded")) return new Response(JSON.stringify({ price: null }), { status: 200 });
      if (u.includes("/prices"))
        return new Response(JSON.stringify({ prices: [{ condition: "NM", priceMarket: 100 }] }), { status: 200 });
      if (u.includes("/collections")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (u.endsWith("/api/users/me/collection") && init?.method === "POST") {
        return new Response(JSON.stringify({ added: 1, total: 1, results: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    })
  );

  const client = makeClient();
  const spy = vi.spyOn(client, "invalidateQueries");

  render(createElement(CardDetailPage), { wrapper: wrapper(client) });

  // Initial addQty = { raw: 0, psa10: 1 } → the button is visible on quantity.
  const addBtn = await screen.findByRole("button", { name: /ADD TO COLLECTION/i });
  fireEvent.click(addBtn);

  await waitFor(() => {
    const keys = spy.mock.calls
      .map((c) => (c[0] as { queryKey?: unknown[] } | undefined)?.queryKey?.[0])
      .filter(Boolean);
    expect(keys).toContain("collection");
    expect(keys).toContain("portfolio-collection");
    expect(keys).toContain("collections");
    expect(keys).toContain("portfolio-history");
  });
});
