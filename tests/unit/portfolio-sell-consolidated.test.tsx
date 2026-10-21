import { it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";

/**
 * BUG 3 (audit 13 F-02) — selling a consolidated tile whose quantity spans more
 * than one UserCollection row must draw across those rows (oldest first, RULE 9)
 * instead of pinning the sell to the first row id (which threw "only 1 owned").
 */
vi.mock("next/navigation", () => ({
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));

window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;

import PortfolioPage from "@/app/(dashboard)/portfolio/page";

// Two active lots of the SAME variant → consolidated into one tile of Qty 3.
// Row A (oldest, qty 1) must drain before row B (qty 2).
const base = {
  cardId: "card_cuid",
  isFoil: false,
  condition: null,
  purchasePrice: 5,
  collectionId: "col_main",
  isSold: false,
  card: { id: "card_cuid", externalId: "base1-4", name: "Alakazam", number: "1", rarity: "Rare", imageUrl: null, marketPrice: 10, set: { id: "s", name: "Base" } },
};
const rowA = { ...base, id: "uc_A", quantity: 1, addedAt: "2026-01-01T00:00:00.000Z" };
const rowB = { ...base, id: "uc_B", quantity: 2, addedAt: "2026-02-01T00:00:00.000Z" };

const sellCalls: { url: string; body: unknown }[] = [];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const u = String(url);
      if (u.includes("/sell") && method === "POST") {
        sellCalls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (u.includes("/api/collections")) return new Response(JSON.stringify({ data: [{ id: "col_main", name: "Main" }] }), { status: 200 });
      if (u.includes("/history")) return new Response(JSON.stringify({ histories: {} }), { status: 200 });
      // The GET must come BEFORE the /sell check matching would be wrong; /sell
      // is POST-only above, so GET to /collection returns the two rows.
      if (u.includes("/api/users/me/collection")) return new Response(JSON.stringify({ items: [rowB, rowA] }), { status: 200 });
      return new Response("{}", { status: 200 });
    })
  );
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, createElement(PortfolioPage)));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sellCalls.length = 0;
});

it("selling 2 of a consolidated Qty-3 tile draws oldest row first, no 'only 1 owned'", async () => {
  stubFetch();
  renderPage();

  // One consolidated tile shows Qty: 3.
  await screen.findByText("Alakazam");
  expect(screen.getAllByText(/Qty: 3/).length).toBeGreaterThan(0);

  // Open Mark Sold.
  fireEvent.click((await screen.findAllByRole("button", { name: /mark sold/i }))[0]);
  const dialog = await screen.findByRole("dialog");

  // Sell 2 at the default per-card market price. The quantity input is the
  // first number field (defaults to "1", max = tile quantity 3); the price
  // field is the second. The labels aren't htmlFor-associated, so target by role.
  const numberInputs = within(dialog).getAllByRole("spinbutton");
  const qtyInput = numberInputs[0];
  fireEvent.change(qtyInput, { target: { value: "2" } });
  fireEvent.click(within(dialog).getByRole("button", { name: /confirm sale/i }));

  await waitFor(() => expect(sellCalls).toHaveLength(2));
  // Oldest (uc_A, qty 1) first, then uc_B qty 1.
  expect(sellCalls[0].url).toContain("/uc_A/sell");
  expect((sellCalls[0].body as { quantity: number }).quantity).toBe(1);
  expect(sellCalls[1].url).toContain("/uc_B/sell");
  expect((sellCalls[1].body as { quantity: number }).quantity).toBe(1);
});
