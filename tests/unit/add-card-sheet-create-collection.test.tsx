import { it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { AddCardSheet, type AddableCard } from "@/components/AddCardSheet";

/**
 * QA D6b — create a NEW collection from inside the add sheet (no navigation),
 * then file into it. Asserts: (1) the "+ New" control reveals a name input;
 * (2) confirming POSTs to /api/collections with { name, isPrivate, typeTag }
 * and, on the 201 { data } response, selects the newly-created collection.
 *
 * The 6a desktop-centering fix is CSS/responsive (.dojo-add-sheet +
 * @media (min-width:768px) in globals.css: bottom sheet on mobile, centered
 * modal with a full border + square corners on desktop). jsdom cannot assert
 * layout pixels, so it is verified by the breakpoint rule, not here.
 */

function mount(card: Partial<AddableCard> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(AddCardSheet, { card: { externalId: "base1-4", name: "Alakazam", ...card }, onClose: vi.fn(), onAdded: vi.fn() })
    )
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("reveals an inline name input when '+ New' is clicked", () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
  mount();
  // The list picker is shown first; no create input yet.
  expect(screen.queryByLabelText("New collection name")).toBeNull();
  fireEvent.click(screen.getByText("+ New"));
  expect(screen.getByLabelText("New collection name")).toBeTruthy();
  expect(screen.getByLabelText("Create collection")).toBeTruthy();
});

it("creates a collection via POST /api/collections and selects it", async () => {
  const created = { id: "col_new123", name: "Vintage" };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === "string" && url === "/api/collections" && init?.method === "POST") {
      return new Response(JSON.stringify({ data: created }), { status: 201 });
    }
    // GET /api/collections (and any other call): after create, include the new row.
    return new Response(JSON.stringify({ data: [created] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  mount();

  fireEvent.click(screen.getByText("+ New"));
  fireEvent.change(screen.getByLabelText("New collection name"), { target: { value: "Vintage" } });
  fireEvent.click(screen.getByLabelText("Create collection"));

  // The POST fired with the You-page shape.
  await waitFor(() => {
    const call = fetchMock.mock.calls.find(
      ([u, i]) => u === "/api/collections" && (i as RequestInit | undefined)?.method === "POST"
    );
    expect(call).toBeTruthy();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body).toMatchObject({ name: "Vintage", isPrivate: true, typeTag: "MIXED" });
  });

  // On success the inline input collapses back to the picker, now showing the
  // new collection selected (collectionId === created.id).
  await waitFor(() => {
    expect(screen.queryByLabelText("New collection name")).toBeNull();
    expect(screen.getByTestId("collection-select").textContent).toContain("Vintage");
  });
});

it("shows an inline error (role=alert) and does not POST when the name is empty", () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  mount();
  fireEvent.click(screen.getByText("+ New"));
  fireEvent.click(screen.getByLabelText("Create collection"));
  expect(screen.getByRole("alert").textContent).toMatch(/required/i);
  // No POST was attempted for the empty name.
  expect(fetchMock.mock.calls.some(([u, i]) => u === "/api/collections" && i?.method === "POST")).toBe(false);
});
