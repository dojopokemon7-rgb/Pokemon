import { it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";

/**
 * FEAT-004 — removal is deliberate: no control removes a card before the
 * confirm dialog, the dialog says "from your collection only", DELETE fires
 * only after confirm, and partial failures keep the failed ids selected.
 */
vi.mock("next/navigation", () => ({
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));

// jsdom has no matchMedia; the page reads it once to pick grid vs list.
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;

import PortfolioPage from "@/app/(dashboard)/portfolio/page";

const item = (id: string, name: string, collectionId: string | null) => ({
  id,
  cardId: `card_${id}`,
  quantity: 1,
  isFoil: false,
  condition: null,
  purchasePrice: 5,
  collectionId,
  isSold: false,
  addedAt: "2026-01-01T00:00:00.000Z",
  card: { id: `card_${id}`, externalId: `ext-${id}`, name, number: "1", rarity: "Rare", imageUrl: null, marketPrice: 10, set: { id: "s", name: "Base" } },
});

let deleteStatus: Record<string, number> = {};
const calls: { url: string; method: string }[] = [];

function stubFetch(items: unknown[], collections: unknown[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(url), method });
      if (method === "DELETE") {
        const id = String(url).split("/").pop() as string;
        return new Response("{}", { status: deleteStatus[id] ?? 200 });
      }
      if (String(url).includes("/api/collections")) return new Response(JSON.stringify({ data: collections }), { status: 200 });
      if (String(url).includes("/history")) return new Response(JSON.stringify({ histories: {} }), { status: 200 });
      if (String(url).includes("/api/users/me/collection")) return new Response(JSON.stringify({ items }), { status: 200 });
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
  deleteStatus = {};
});

async function selectFirstCard(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Select" }));
  const row = (await screen.findByText(name)).closest("[aria-pressed]") as HTMLElement;
  fireEvent.click(row);
}

const deletes = () => calls.filter((c) => c.method === "DELETE");

it("no DELETE before confirm; dialog says 'from your collection only'; DELETE after confirm", async () => {
  stubFetch([item("u1", "Alakazam", "col_main")], [{ id: "col_main", name: "Main" }]);
  renderPage();
  await selectFirstCard("Alakazam");

  fireEvent.click(screen.getByRole("button", { name: "Remove from collection" }));
  const dialog = await screen.findByRole("dialog", { name: /remove from collection/i });
  expect(dialog.textContent).toMatch(/from your collection only/i);
  expect(deletes()).toHaveLength(0);

  fireEvent.click(screen.getByRole("button", { name: "Yes, Remove" }));
  await waitFor(() => expect(deletes()).toHaveLength(1));
  expect(deletes()[0].url).toContain("/api/users/me/collection/u1");
});

it("Cancel in the dialog never calls DELETE", async () => {
  stubFetch([item("u1", "Alakazam", "col_main")]);
  renderPage();
  await selectFirstCard("Alakazam");
  fireEvent.click(screen.getByRole("button", { name: "Remove from collection" }));
  const dlg = await screen.findByRole("dialog", { name: /remove from collection/i });
  fireEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
  expect(deletes()).toHaveLength(0);
});

it("a failed removal keeps that card selected and the dialog open with an error", async () => {
  deleteStatus = { u1: 500 };
  stubFetch([item("u1", "Alakazam", "col_main")]);
  renderPage();
  await selectFirstCard("Alakazam");
  fireEvent.click(screen.getByRole("button", { name: "Remove from collection" }));
  fireEvent.click(await screen.findByRole("button", { name: "Yes, Remove" }));
  expect(await screen.findByText(/could not be removed/i)).toBeTruthy();
  expect(screen.getByText(/1 selected/i)).toBeTruthy();
});

it("hides the Uncategorized filter when no lot is unassigned; shows it when one is (null rows still listed)", async () => {
  stubFetch([item("u1", "Alakazam", "col_main")], [{ id: "col_main", name: "Main" }, { id: "__uncat__" }]);
  const first = renderPage();
  fireEvent.click(await screen.findByRole("button", { name: /all collections/i }));
  expect(screen.queryByText("Uncategorized")).toBeNull();
  first.unmount();

  stubFetch([item("u2", "Blastoise", null)], [{ id: "col_main", name: "Main" }, { id: "__uncat__" }]);
  renderPage();
  expect(await screen.findByText("Blastoise")).toBeTruthy(); // visible under All
  fireEvent.click(await screen.findByRole("button", { name: /all collections/i }));
  expect(await screen.findByText("Uncategorized")).toBeTruthy();
});
