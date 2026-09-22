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
const RENAMED = `My Holo Collection v2 ${RUN}`;

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
          if (c.name === NAME || c.name === RENAMED) {
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
    // Privacy → Private, type tag → POKEMON.
    await page.getByLabel(/private/i).check();
    await page.getByLabel(/type|tag/i).selectOption("POKEMON");
    await page.getByRole("button", { name: /save|create/i }).click();

    const row = page.getByTestId("collection-row").filter({ hasText: NAME });
    await expect(row).toBeVisible();
    await expect(row.getByText(/private/i)).toBeVisible();
    await expect(row.getByText(/pokemon/i)).toBeVisible();
  });

  test("rename: change the collection name", async ({ page }) => {
    await page.goto("/you");

    const row = page.getByTestId("collection-row").filter({ hasText: NAME });
    await row.getByRole("button", { name: /edit|rename/i }).click();

    await page.getByLabel(/name/i).fill(RENAMED);
    await page.getByRole("button", { name: /save/i }).click();

    await expect(
      page.getByTestId("collection-row").filter({ hasText: RENAMED })
    ).toBeVisible();
  });

  test("toggle privacy & tag: make it public and MIXED", async ({ page }) => {
    await page.goto("/you");

    const row = page.getByTestId("collection-row").filter({ hasText: RENAMED });
    await row.getByRole("button", { name: /edit|settings/i }).click();

    await page.getByLabel(/public/i).check();
    await page.getByLabel(/type|tag/i).selectOption("MIXED");
    await page.getByRole("button", { name: /save/i }).click();

    const updated = page.getByTestId("collection-row").filter({ hasText: RENAMED });
    await expect(updated.getByText(/public/i)).toBeVisible();
    await expect(updated.getByText(/mixed/i)).toBeVisible();
  });

  test("delete: remove the collection from the list", async ({ page }) => {
    await page.goto("/you");

    const row = page.getByTestId("collection-row").filter({ hasText: RENAMED });
    await row.getByRole("button", { name: /delete/i }).click();
    // Confirm if a confirmation control appears.
    const confirm = page.getByRole("button", { name: /confirm|yes, delete|delete/i });
    if (await confirm.count()) await confirm.last().click();

    await expect(
      page.getByTestId("collection-row").filter({ hasText: RENAMED })
    ).toHaveCount(0);
  });
});
