import { test, expect, request as apiRequest } from "@playwright/test";
import { execSync } from "node:child_process";
import { STORAGE_STATE } from "./constants";
import { GRADED_EXTERNAL_ID, GRADED_NAME } from "./fixtures/seed-graded-card";

/**
 * F-19 — Graded Add Flow.
 *
 * Runs under the `authed` project (real server-trusted session via
 * storageState) against the real backend + Supabase (Prisma / Better Auth).
 *
 * Behaviour pinned here:
 *   The search quick-view popup was removed, so a graded card is added via
 *   the tile's "+" (Add to portfolio) button, which opens the Add sheet.
 *   For a graded card the sheet opens straight into the graded (PSA) form,
 *   pre-filled. Submitting persists the card WITH its graded metadata
 *   (condition = "PSA 10") and shows a success toast.
 *
 * Selector contract:
 *   - The graded modal exposes data-testid="graded-add-modal".
 *   - Grader is a RAW/PSA radiogroup; the condition control is a CUSTOM
 *     listbox (data-testid="condition-select") whose rows are role="option"
 *     — there is no native <select> in the Add sheet.
 *   - Submitting is the "ADD TO PORTFOLIO" button inside the modal.
 *   - On success a toast (role="status") appears, and the card is in the
 *     collection with graded `condition` metadata (e.g. "PSA 10").
 *
 * Graded cards encode graded-ness in `rarity = "PSA <n>"` (there is no
 * dedicated grade column yet — see prisma/seed-test.ts). The production
 * seed pulls real TCG data with no graded rows, and /search only surfaces
 * "pokemon-"/"onepiece-" catalog sets, so we seed ONE graded catalog card
 * (see e2e/fixtures/seed-graded-card.ts) up-front and remove it after.
 */

const BASE_URL = "http://localhost:3001";

test.describe("F-19 Graded Add Flow", () => {
  // Seed a discoverable graded catalog card once for the suite.
  test.beforeAll(() => {
    execSync("npx tsx e2e/fixtures/seed-graded-card.ts up", { stdio: "inherit" });
  });

  // Leave the DB as we found it: remove the seeded card + any collection
  // row this run added for it.
  test.afterAll(async () => {
    const ctx = await apiRequest.newContext({ baseURL: BASE_URL, storageState: STORAGE_STATE });
    try {
      const res = await ctx.get("/api/users/me/collection");
      if (res.ok()) {
        const { items } = (await res.json()) as {
          items: { id: string; card?: { externalId?: string } }[];
        };
        for (const item of items ?? []) {
          if (item.card?.externalId === GRADED_EXTERNAL_ID) {
            await ctx.delete(`/api/users/me/collection/${item.id}`);
          }
        }
      }
    } finally {
      await ctx.dispose();
    }
    execSync("npx tsx e2e/fixtures/seed-graded-card.ts down", { stdio: "inherit" });
  });

  test("adding a graded card opens the dedicated graded-add modal", async ({ page }) => {
    // Find the graded card in the UI by searching its name.
    await page.goto(`/search?q=${encodeURIComponent(GRADED_NAME)}`);

    const firstCard = page.getByTestId("card-result").first();
    await expect(firstCard).toBeVisible({ timeout: 30_000 });

    // The quick-view popup was removed — the card's "+" (Add to portfolio)
    // button on the tile opens the Add sheet directly. For a graded card it
    // opens straight into the graded (PSA) form.
    await firstCard.getByRole("button", { name: /add .* to portfolio/i }).click();

    const gradedModal = page.getByTestId("graded-add-modal");
    await expect(gradedModal).toBeVisible();

    // It offers the RAW/PSA grader pills (a graded card opens on PSA) and a
    // custom condition listbox (no native <select>).
    await expect(gradedModal.getByRole("radio", { name: "PSA" })).toBeVisible();
    await expect(gradedModal.getByTestId("condition-select")).toBeVisible();
  });

  test("submitting graded details adds the card with graded metadata + a toast", async ({ page }) => {
    await page.goto(`/search?q=${encodeURIComponent(GRADED_NAME)}`);

    const firstCard = page.getByTestId("card-result").first();
    await expect(firstCard).toBeVisible({ timeout: 30_000 });
    await firstCard.getByRole("button", { name: /add .* to portfolio/i }).click();

    const gradedModal = page.getByTestId("graded-add-modal");
    await expect(gradedModal).toBeVisible();

    // Select PSA grader, then pick "Gem Mint 10" from the custom listbox →
    // persists "PSA 10".
    await gradedModal.getByRole("radio", { name: "PSA" }).click();
    await gradedModal.getByTestId("condition-select").click();
    await gradedModal.getByRole("option", { name: "Gem Mint 10" }).click();

    // Submit and wait for the persisting POST to actually complete.
    const [addRes] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/users/me/collection") &&
          r.request().method() === "POST"
      ),
      gradedModal.getByRole("button", { name: /add to portfolio/i }).click(),
    ]);
    expect(addRes.ok()).toBeTruthy();

    // Success toast.
    await expect(page.getByRole("status")).toBeVisible();

    // The card is persisted WITH its graded metadata (condition = "PSA 10").
    const ctx = await apiRequest.newContext({ baseURL: BASE_URL, storageState: STORAGE_STATE });
    try {
      const res = await ctx.get("/api/users/me/collection");
      expect(res.ok()).toBeTruthy();
      const { items } = (await res.json()) as {
        items: { condition: string | null; card?: { externalId?: string } }[];
      };
      const row = items.find((i) => i.card?.externalId === GRADED_EXTERNAL_ID);
      expect(row, "graded card was not added to the collection").toBeTruthy();
      expect(row!.condition ?? "").toMatch(/psa\s*10/i);
    } finally {
      await ctx.dispose();
    }
  });
});
