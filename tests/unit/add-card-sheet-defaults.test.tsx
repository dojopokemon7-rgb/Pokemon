import { it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { AddCardSheet, type AddableCard } from "@/components/AddCardSheet";

/**
 * FEAT-004 — reproduce-first check of the reported "PSA 10 / quantity" default
 * issue in the add form: default grader must be Raw, condition raw/ungraded,
 * quantity 1 (never below 1, never above 999 — the server max).
 */
const GRADED = [
  { company: "PSA", grade: "10", price: 500 },
  { company: "PSA", grade: "9", price: 120 },
];

function mount(card: Partial<AddableCard>) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
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

const grader = () => screen.getByTestId("grader-select");
const qty = () => screen.getByLabelText("Decrease quantity").parentElement!.textContent;

it.each([
  ["(a) raw price + graded prices", { marketPrice: 12, gradedPrices: GRADED }],
  ["(b) null raw price + PSA 10 prices", { marketPrice: null, gradedPrices: GRADED }],
  ["(c) no prices at all", { marketPrice: null, gradedPrices: [] }],
])("%s: defaults to Raw / ungraded with quantity 1", (_label, card) => {
  mount(card);
  expect(grader().textContent).toMatch(/raw/i);
  expect(grader().textContent).not.toMatch(/psa/i);
  expect(screen.getByTestId("condition-select").textContent).toMatch(/near mint/i);
  expect(screen.queryByText(/gem mint 10/i)).toBeNull();
  expect(qty()).toContain("1");
});

it("QA #2: the payment field is hidden by default and, when revealed, is NOT pre-filled with the market price", () => {
  mount({ marketPrice: 500, gradedPrices: GRADED });
  // Collapsed by default — no "Price paid" input until the user opts in.
  expect(screen.queryByLabelText("Price paid")).toBeNull();
  // Reveal it via the "+ Add" (Record Payment) control.
  fireEvent.click(screen.getByText("+ Add"));
  const input = screen.getByLabelText("Price paid") as HTMLInputElement;
  // Must start blank — never auto-filled with the card's live/market price
  // (auto-filling Paid with the market value is exactly what QA #2 rejects).
  expect(input.value).toBe("");
  expect(input.value).not.toBe("500");
});

it("quantity cannot go below 1 or above 999", () => {
  mount({ marketPrice: 12 });
  fireEvent.click(screen.getByLabelText("Decrease quantity"));
  expect(qty()).toContain("1");
  for (let i = 0; i < 1100; i++) fireEvent.click(screen.getByLabelText("Increase quantity"));
  expect(qty()).toContain("999");
  expect(qty()).not.toContain("1000");
}, 60_000); // ~1000 clicks: slow under parallel load
