import { it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";

/**
 * FEAT-004 — multi-select Add on /search/multi: accessible rows, count + Clear,
 * collection picker (only /api/collections results, default Main), POST
 * { collectionId, onExisting:"skip", cards } with deduped externalIds in
 * SELECTION order, status/alert regions, cache invalidation, and selection
 * retained on failure.
 */
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("q=alakazam&game=pokemon"),
  useRouter: () => ({ push, back: vi.fn(), replace: vi.fn() }),
}));

import SearchMultiPage from "@/app/(dashboard)/search/multi/page";

const CARDS = [
  { id: "base1-1", name: "Alakazam", setName: "Base", marketPrice: 10 },
  { id: "base1-2", name: "Blastoise", setName: "Base", marketPrice: 20 },
  { id: "base1-2", name: "Blastoise dup", setName: "Base", marketPrice: 20 }, // duplicate externalId
  { id: "base1-3", name: "Chansey", setName: "Base" },
];
const COLLECTIONS = [
  { id: "col_main", name: "Main" },
  { id: "col_v", name: "Vintage" },
  { id: "__uncat__" }, // nameless pseudo-entry must NOT be pickable
];

let posts: { url: string; body: Record<string, unknown> }[] = [];
let postResponse: { status: number; json: unknown } = { status: 200, json: { added: 2, alreadyPresent: 1, invalid: 0, total: 3 } };

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST") {
        posts.push({ url: u, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify(postResponse.json), { status: postResponse.status });
      }
      if (u.includes("/api/collections")) return new Response(JSON.stringify({ data: COLLECTIONS }), { status: 200 });
      if (u.includes("/api/cards/search")) return new Response(JSON.stringify({ cards: CARDS }), { status: 200 });
      return new Response("{}", { status: 200 });
    })
  );
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(client, "invalidateQueries");
  render(createElement(QueryClientProvider, { client }, createElement(SearchMultiPage)));
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  posts = [];
  postResponse = { status: 200, json: { added: 2, alreadyPresent: 1, invalid: 0, total: 3 } };
  push.mockClear();
});

const row = async (name: string) => (await screen.findByText(name)).closest('[role="checkbox"]') as HTMLElement;

it("rows are keyboard-accessible checkboxes; count + Clear work", async () => {
  stub();
  renderPage();
  const a = await row("Alakazam");
  expect(a.getAttribute("aria-checked")).toBe("false");
  fireEvent.keyDown(a, { key: " " });
  expect(a.getAttribute("aria-checked")).toBe("true");
  fireEvent.keyDown(await row("Chansey"), { key: "Enter" });
  expect(screen.getByText(/2 selected/i)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^clear/i }));
  expect(screen.queryByText(/selected/i)).toBeNull();
});

it("picker lists only named /api/collections results, defaulting to Main", async () => {
  stub();
  renderPage();
  fireEvent.click(await row("Alakazam"));
  const select = (await screen.findByLabelText(/destination collection/i)) as HTMLSelectElement;
  await waitFor(() => expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Main", "Vintage"]));
  expect(select.value).toBe("col_main");
});

it("Add posts {collectionId,onExisting:'skip',cards} deduped in selection order, reports counts, invalidates caches, clears selection", async () => {
  stub();
  const spy = renderPage();
  fireEvent.click(await row("Chansey"));
  fireEvent.click(await row("Alakazam"));
  fireEvent.click(await row("Blastoise"));
  await screen.findByLabelText(/destination collection/i);
  await waitFor(() => expect((screen.getByLabelText(/destination collection/i) as HTMLSelectElement).value).toBe("col_main"));
  fireEvent.change(screen.getByLabelText(/destination collection/i), { target: { value: "col_v" } });
  fireEvent.click(screen.getByRole("button", { name: /^add 3/i }));

  await waitFor(() => expect(posts).toHaveLength(1));
  const { body } = posts[0];
  expect(body.collectionId).toBe("col_v");
  expect(body.onExisting).toBe("skip");
  expect((body.cards as { externalId: string }[]).map((c) => c.externalId)).toEqual(["base1-3", "base1-1", "base1-2"]);

  const status = await screen.findByRole("status");
  await waitFor(() => expect(status.textContent).toMatch(/2 added.*1 already in collection.*0 invalid/i));
  const keys = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
  for (const k of ['["collection"]', '["portfolio-collection"]', '["collections"]']) expect(keys).toContain(k);
  expect(screen.queryByText(/\d+ selected/i)).toBeNull();
});

it("on failure keeps the selection and shows a role=alert", async () => {
  postResponse = { status: 500, json: { message: "Could not add this card." } };
  stub();
  renderPage();
  fireEvent.click(await row("Alakazam"));
  await waitFor(() => expect(screen.getByLabelText(/destination collection/i)).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: /^add 1/i }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/could not add/i);
  expect(screen.getByText(/1 selected/i)).toBeTruthy();
  expect((await row("Alakazam")).getAttribute("aria-checked")).toBe("true");
});

it("keeps 'Set details' as a secondary action to /collection/add", async () => {
  stub();
  renderPage();
  fireEvent.click(await row("Alakazam"));
  fireEvent.click(await screen.findByRole("button", { name: /set details/i }));
  expect(push).toHaveBeenCalledWith("/collection/add");
});
