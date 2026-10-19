import { it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

/**
 * QA D4 — the desktop sidebar collapse toggle. The button must render with a
 * state-reflecting accessible name, and toggling it must flip the collapsed
 * state (asserted via the nav's `.dojo-shell-nav--collapsed` class, the
 * aria-label/aria-expanded, and the persisted localStorage flag).
 *
 * jsdom has no layout engine, so the actual icon-only RAIL WIDTH (a CSS media
 * query under >=768px) cannot be verified here — that's manual/visual. This
 * test pins the behavior the component owns: class toggle + a11y name + persist.
 *
 * Harness mirrors add-invalidates-chart.test.tsx: next/navigation is mocked.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
}));

import DashboardClientShell from "@/app/(dashboard)/dashboard-client-shell";

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it("renders the collapse toggle with an accessible name and starts expanded", async () => {
  render(createElement(DashboardClientShell, null, "content"), { wrapper: wrapper(makeClient()) });

  // Starts expanded (server-parity default), so the toggle offers to collapse.
  const btn = await screen.findByRole("button", { name: "Collapse sidebar" });
  expect(btn.getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector(".dojo-shell-nav--collapsed")).toBeNull();
});

it("toggling flips the collapsed class, the accessible name, and persists it", async () => {
  render(createElement(DashboardClientShell, null, "content"), { wrapper: wrapper(makeClient()) });

  fireEvent.click(await screen.findByRole("button", { name: "Collapse sidebar" }));

  const btn = await screen.findByRole("button", { name: "Expand sidebar" });
  expect(btn.getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector(".dojo-shell-nav--collapsed")).not.toBeNull();
  expect(localStorage.getItem("dojo_nav_collapsed")).toBe("true");
});

it("restores the collapsed state from localStorage after mount", async () => {
  localStorage.setItem("dojo_nav_collapsed", "true");
  render(createElement(DashboardClientShell, null, "content"), { wrapper: wrapper(makeClient()) });

  // Hydration-safe: starts expanded on first render, resolves to collapsed
  // from storage in a post-mount effect.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy()
  );
  expect(document.querySelector(".dojo-shell-nav--collapsed")).not.toBeNull();
});
