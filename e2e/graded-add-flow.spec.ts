import { test, expect, request as apiRequest } from "@playwright/test";
import { execSync } from "node:child_process";
import { STORAGE_STATE } from "./constants";
import { GRADED_EXTERNAL_ID, GRADED_NAME } from "./fixtures/seed-graded-card";

/**
 * F-19 — Graded Add Flow Popup. RED phase.
 *
 * Runs under the `authed` project (real server-trusted session via
 * storageState) against the real backend + Supabase (Prisma / Better Auth).
 *
 * Target behaviour (the end state these tests pin, NOT yet built):
 *   When a user adds a *graded* card to their collection from the Card
 *   Details Popup, the app opens a dedicated "Graded Add Flow" modal that
 *   prompts for grading details (Grading Company + Grade) — rather than the
 *   generic Ungraded/Graded picker sheet used for raw cards. Submitting it
 *   persists the card WITH its graded metadata and shows a success toast.
 *
 * Selector contract for the GREEN phase:
 *   - The graded modal exposes data-testid="graded-add-modal".
 *   - It contains a "Grading Company" control (label / accessible name
 *     matching /grading company/i, offering PSA / BGS …) and a "Grade"
 *     control (accessible name matching /grade/i, e.g. 10 / 9).
 *   - Submitting is a button named /add|save|confirm/i inside the modal.
 *   - On success a toast (role="status") appears, and the card is in the
 *     collection with graded `condition` metadata (e.g. "PSA 10").
 *
 * EXPECTED TO FAIL today:
 *   - The popup's "Add to Collection" always opens the generic AddCardSheet
 *     (an Ungraded/Graded *picker*), never a data-testid="graded-add-modal".
 *   - That sheet's graded step is a UI stub whose ADD button only fires a
 *     "coming in Week 3" toast and persists NO graded metadata.
 *   - The search page also never threads a card's grade/condition into the
 *     popup, so nothing downstream can know the card is graded.
 *
 * Graded cards encode graded-ness in `rarity = "PSA <n>"` (there is no
 * dedicated grade column yet — see prisma/seed-test.ts). The production
 * seed pulls real TCG data with no graded rows, and /search only surfaces
 * "pokemon-"/"onepiece-" catalog sets, so we seed ONE graded catalog card
 * (see e2e/fixtures/seed-graded-card.ts) up-front and remove it after.
 */

const BASE_URL = "http://localhost:3001";
const GRADED_RE = /\b(psa|bgs|cgc|sgc|beckett)\b/i;

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
    // Find the graded card in the UI by searching its name, then open it.
    await page.goto(`/search?q=${encodeURIComponent(GRADED_NAME)}`);

    const firstCard = page.getByTestId("card-result").first();
    await expect(firstCard).toBeVisible({ timeout: 30_000 });
    await firstCard.click();

    const popup = page.getByTestId("card-details-popup");
    await expect(popup).toBeVisible();

    // The popup must reflect that this is a graded card.
    await expect(popup.getByTestId("card-details-grade")).toHaveText(GRADED_RE);

    // "Add to Collection" for a graded card opens the GRADED add modal,
    // not the generic Ungraded/Graded picker sheet.
    await popup.getByRole("button", { name: /add to collection/i }).click();

    const gradedModal = page.getByTestId("graded-add-modal");
    await expect(gradedModal).toBeVisible();

    // It prompts for grading company + grade.
    await expect(
      gradedModal.getByRole("combobox", { name: /grading company/i })
    ).toBeVisible();
    await expect(gradedModal.getByRole("textbox", { name: /grade/i })).toBeVisible();
  });

  test("submitting graded details adds the card with graded metadata + a toast", async ({ page }) => {
    await page.goto(`/search?q=${encodeURIComponent(GRADED_NAME)}`);

    const firstCard = page.getByTestId("card-result").first();
    await expect(firstCard).toBeVisible({ timeout: 30_000 });
    await firstCard.click();

    await page.getByTestId("card-details-popup")
      .getByRole("button", { name: /add to collection/i })
      .click();

    const gradedModal = page.getByTestId("graded-add-modal");
    await expect(gradedModal).toBeVisible();

    // Fill graded details: Company PSA, Grade 10.
    await gradedModal.getByRole("combobox", { name: /grading company/i }).selectOption("PSA");
    await gradedModal.getByRole("textbox", { name: /grade/i }).fill("10");

    // Submit and wait for the persisting POST to actually complete.
    const [addRes] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/users/me/collection") &&
          r.request().method() === "POST"
      ),
      gradedModal.getByRole("button", { name: /add|save|confirm/i }).click(),
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
