import { it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";

/**
 * QA #8 — the Collections loading state must reserve the real rows' footprint
 * with a skeleton (no "Loading collections…" text line that CLS-jumps when the
 * taller rows arrive). While the ["collections"] query is pending, the section
 * renders the skeleton placeholder and NOT the old text line.
 */
import { CollectionsSection } from "@/app/(dashboard)/you/_components/CollectionsSection";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPending() {
  // Never-resolving fetch keeps the query in `isLoading` so we observe the
  // loading branch (not the loaded/empty branches).
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, createElement(CollectionsSection)));
}

it("loading state renders the skeleton placeholder, not the old text line", () => {
  renderPending();
  const skeleton = screen.getByTestId("collections-skeleton");
  // Reuses the shared <Skeleton> primitive (`.dojo-skeleton`), one per name +
  // caption line across the placeholder rows.
  expect(skeleton.querySelectorAll(".dojo-skeleton").length).toBeGreaterThan(0);
  expect(screen.queryByText(/Loading collections/i)).toBeNull();
});
