import { test, expect, request as apiRequest } from "@playwright/test";
import { STORAGE_STATE } from "./constants";

/**
 * F-10 — Collections management UI on /you. RED phase.
 *
 * Runs under the `authed` project (real server-trusted session via
 * storageState) and hits the REAL backend + Supabase. To avoid state
 * collisions across runs, the collection name is unique per run, and the
 * scenarios run SERIALLY as one lifecycle (create → rename → toggle →
 * delete) so the final delete cleans up what create made.
 *
 * EXPECTED TO FAIL today: /you has no collections-management UI — no
 * "Add Collection" control, no create form, no per-collection rename /
 * settings / delete actions, and no API behind them.
 */

// Unique per run so reruns / leftovers can't collide on the
// @@unique([userId, name]) constraint.
const RUN = Date.now();
const NAME = `My Holo Collection ${RUN}`;

test.describe.configure({ mode: "serial" });

test.describe("F-10 collections management", () => {
  // Safety net: even if a scenario fails mid-flow, remove any collection
  // this run created (by either name) via the API so nothing accumulates
  // in the real DB. Uses the same server-trusted session as the specs.
  test.afterAll(async () => {
    const ctx = await apiRequest.newContext({
      baseURL: "http://localhost:3001",
      storageState: STORAGE_STATE,
    });
    try {
      const res = await ctx.get("/api/collections");
      if (res.ok()) {
        const { data } = await res.json();
        for (const c of (data ?? []) as { id: string; name: string }[]) {
          if (c.name === NAME) {
            await ctx.delete(`/api/collections/${c.id}`);
          }
        }
      }
    } finally {
      await ctx.dispose();
    }
  });

  test("create: add a private POKEMON collection", async ({ page }) => {
    await page.goto("/you");

    await page.getByRole("button", { name: /add collection/i }).click();

    await page.getByLabel(/name/i).fill(NAME);
    // Privacy → Private, type tag → POKEMON (create form still uses radios
    // + a type select; the row-level pill toggle is exercised separately).
    await page.getByLabel(/private/i).check();
    await page.getByLabel(/type|tag/i).selectOption("POKEMON");
    await page.getByRole("button", { name: /save|create/i }).click();

    const row = page.getByTestId("collection-row").filter({ hasText: NAME });
    await expect(row).toBeVisible();
    // The private caption + the PRIVATE pill being active reflect privacy.
    await expect(row.getByText(/only you/i)).toBeVisible();
    await expect(row.getByRole("button", { name: /set private/i })).toHaveAttribute("aria-pressed", "true");
  });

  test("toggle privacy via the PUBLIC/PRIVATE pill: make it public", async ({ page }) => {
    await page.goto("/you");

    const row = page.getByTestId("collection-row").filter({ hasText: NAME });
    // Click the PUBLIC pill on the row (row-level toggle).
    await row.getByRole("button", { name: /set public/i }).click();

    const updated = page.getByTestId("collection-row").filter({ hasText: NAME });
    await expect(updated.getByText(/visible to everyone/i)).toBeVisible();
    await expect(updated.getByRole("button", { name: /set public/i })).toHaveAttribute("aria-pressed", "true");
  });

  test("delete: expand the row, click Delete, confirm in the modal", async ({ page }) => {
    await page.goto("/you");

    const row = page.getByTestId("collection-row").filter({ hasText: NAME });
    // Expand the row to reveal Delete.
    await row.getByRole("button", { name: /expand for options/i }).click();
    await row.getByRole("button", { name: /^delete$/i }).click();

    // Double-confirm modal: click the final Delete.
    const dialog = page.getByRole("dialog", { name: /confirm delete/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /^delete$/i }).click();

    await expect(
      page.getByTestId("collection-row").filter({ hasText: NAME })
    ).toHaveCount(0);
  });
});
