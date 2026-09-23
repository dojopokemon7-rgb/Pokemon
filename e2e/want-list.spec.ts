import { test, expect, request as apiRequest } from "@playwright/test";
import { STORAGE_STATE } from "./constants";

/**
 * F-07 — Want List (replaces Binders). RED phase.
 *
 * Runs under the `authed` project (real server-trusted session via
 * storageState) against the real backend. The Want List has three intents:
 * Want to Buy / Want to Sell / Want to Trade. Cards are added from
 * Explore/Search into a chosen tab, then can be moved between tabs or
 * removed.
 *
 * EXPECTED TO FAIL today: there is no /wantlist page, no tabs, no
 * add-to-want-list action on search (only a local-state "WANT TO BUY"
 * toggle that persists nothing), and no want-list API.
 */

// The add → move → remove scenarios form one lifecycle against the real
// backend and must run in order (and not concurrently) so each builds on
// the previous. Serial mode enforces that.
test.describe.configure({ mode: "serial" });

test.describe("F-07 Want List", () => {
  // Safety net: clear any want-list rows this run left behind in the real DB.
  test.afterAll(async () => {
    const ctx = await apiRequest.newContext({
      baseURL: "http://localhost:3001",
      storageState: STORAGE_STATE,
    });
    try {
      const res = await ctx.get("/api/want-list");
      if (res.ok()) {
        const { data } = await res.json();
        for (const item of (data ?? []) as { id: string }[]) {
          await ctx.delete(`/api/want-list/${item.id}`);
        }
      }
    } finally {
      await ctx.dispose();
    }
  });

  test("want list page has Buy / Sell / Trade tabs", async ({ page }) => {
    await page.goto("/wantlist");
    await expect(page.getByRole("tab", { name: /want to buy/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /want to sell/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /want to trade/i })).toBeVisible();
  });

  test("add a card to 'Want to Buy' from search, then it shows in that tab", async ({ page }) => {
    // The search quick-view popup was removed: tapping a card now navigates
    // to the full card detail page (/search/[id]), whose primary want-list
    // action is WANT TO BUY (intent BUY).
    await page.goto("/search");
    await page.getByTestId("card-result").first().click();
    await expect(page).toHaveURL(/\/search\/[^/?]+(\?|$)/);

    const buyBtn = page.getByTestId("want-to-buy-btn");
    await expect(buyBtn).toBeVisible({ timeout: 30_000 });
    // Wait for the add POST to actually complete before navigating away, so
    // the row is committed by the time we read the want list.
    const [addRes] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/want-list") && r.request().method() === "POST"
      ),
      buyBtn.click(),
    ]);
    expect(addRes.ok()).toBeTruthy();

    // It should now appear under the Want to Buy tab on the want list.
    await page.goto("/wantlist");
    await page.getByRole("tab", { name: /want to buy/i }).click();
    await expect(page.getByTestId("wantlist-item").first()).toBeVisible();
  });

  test("move a card from Buy to Sell", async ({ page }) => {
    await page.goto("/wantlist");
    await page.getByRole("tab", { name: /want to buy/i }).click();

    const item = page.getByTestId("wantlist-item").first();
    await item.getByRole("button", { name: "Move", exact: true }).click();
    await page.getByRole("menuitem", { name: /want to sell/i }).click();

    // Gone from Buy…
    await page.getByRole("tab", { name: /want to buy/i }).click();
    await expect(page.getByTestId("wantlist-item")).toHaveCount(0);
    // …present in Sell.
    await page.getByRole("tab", { name: /want to sell/i }).click();
    await expect(page.getByTestId("wantlist-item").first()).toBeVisible();
  });

  test("remove a card from the want list", async ({ page }) => {
    await page.goto("/wantlist");
    await page.getByRole("tab", { name: /want to sell/i }).click();

    const item = page.getByTestId("wantlist-item").first();
    await item.getByRole("button", { name: /remove/i }).click();

    await expect(page.getByTestId("wantlist-item")).toHaveCount(0);
  });
});
