import { it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";

/**
 * BUG 1 (audit 06 F-01 / 03 P-22) — the Portfolio "Want Sell" action must POST
 * the CATALOG externalId (RULE 3), never the internal Card.id cuid. The
 * want-list read service joins WantListItem.cardId to Card.externalId, so a
 * cuid would create an unreadable/duplicate SELL row that never matches a card.
 */
vi.mock("next/navigation", () => ({
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));

window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;

import PortfolioPage from "@/app/(dashboard)/portfolio/page";

// An active lot whose `cardId` is the internal cuid and whose `card.externalId`
// is the catalog id — the two MUST NOT be confused (RULE 3).
const lot = {
  id: "uc_1",
  cardId: "card_u1cuid", // internal Card.id cuid (the bug: this was sent)
  quantity: 1,
  isFoil: false,
  condition: null,
  purchasePrice: 5,
  collectionId: "col_main",
  isSold: false,
  addedAt: "2026-01-01T00:00:00.000Z",
  card: { id: "card_u1cuid", externalId: "base1-4", name: "Alakazam", number: "1", rarity: "Rare", imageUrl: null, marketPrice: 10, set: { id: "s", name: "Base" } },
};

const calls: { url: string; method: string; body: unknown }[] = [];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), method, body });
      if (String(url).includes("/api/want-list")) return new Response("{}", { status: 200 });
      if (String(url).includes("/api/collections")) return new Response(JSON.stringify({ data: [{ id: "col_main", name: "Main" }] }), { status: 200 });
      if (String(url).includes("/history")) return new Response(JSON.stringify({ histories: {} }), { status: 200 });
      if (String(url).includes("/api/users/me/collection")) return new Response(JSON.stringify({ items: [lot] }), { status: 200 });
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
  calls.length = 0;
});

it("Want Sell posts the card externalId as cardId (RULE 3), never the cuid", async () => {
  stubFetch();
  renderPage();
  // Two "Want Sell" buttons render (grid + list are both in the tree only one
  // view at a time; findAll handles whichever is active).
  const btn = (await screen.findAllByRole("button", { name: /want sell/i }))[0];
  fireEvent.click(btn);

  await waitFor(() => {
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/api/want-list"));
    expect(post).toBeTruthy();
  });
  const post = calls.find((c) => c.method === "POST" && c.url.includes("/api/want-list"))!;
  expect(post.body).toEqual({ cardId: "base1-4", intent: "SELL" });
  expect((post.body as { cardId: string }).cardId).not.toBe("card_u1cuid");
});
