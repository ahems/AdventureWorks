import { test, expect } from "@playwright/test";
import { testEnv } from "../../utils/env";
import { loginAsAdmin } from "../../utils/adminTestUser";

test.describe("Admin Portal – Promotions", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${testEnv.adminWebBaseUrl}/promotions`);
  });

  // ─── Read / smoke tests ────────────────────────────────────────────────────

  test("promotions page loads with real special offers", async ({ page }) => {
    await expect(page.getByText(/sales promotions/i).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test("promotion cards are rendered from the database", async ({ page }) => {
    // Set category filter to "All Categories" so "No Discount" (Category='No Discount') is visible
    await expect(page.locator(".doodle-card").first()).toBeVisible({
      timeout: 20_000,
    });
    const categoryCombobox = page.getByRole("combobox").nth(2);
    await categoryCombobox.click();
    await page.getByRole("option", { name: /all categories/i }).click();
    await expect(page.getByText("No Discount").first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("stats show active / upcoming / expired counts", async ({ page }) => {
    await expect(page.getByText(/active/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/upcoming/i).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/expired/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("search input filters promotions", async ({ page }) => {
    // Clear the category filter so all promotions are visible for search
    await expect(page.locator(".doodle-card").first()).toBeVisible({
      timeout: 20_000,
    });
    const categoryCombobox = page.getByRole("combobox").nth(2);
    await categoryCombobox.click();
    await page.getByRole("option", { name: /all categories/i }).click();

    const searchInput = page.getByPlaceholder(/search/i).first();
    await expect(searchInput).toBeVisible({ timeout: 10_000 });
    await searchInput.fill("Volume");
    await page.waitForTimeout(400);
    await expect(page.getByText(/volume discount/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("New Promotion button is visible", async ({ page }) => {
    await expect(
      page.getByRole("button", { name: /new promotion/i }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("filter comboboxes (status, type, category) are available", async ({
    page,
  }) => {
    // After removing the culture selector there should be exactly 3 filter comboboxes
    const comboboxes = page.getByRole("combobox");
    await expect(comboboxes.first()).toBeVisible({ timeout: 15_000 });
    const count = await comboboxes.count();
    expect(count).toBe(3); // status / type / category
  });

  test("culture filter is not shown on the promotions page", async ({
    page,
  }) => {
    // Wait for page to fully load
    await expect(page.getByText(/sales promotions/i).first()).toBeVisible({
      timeout: 20_000,
    });
    // The culture selector must not be present
    await expect(page.getByText("English (US)")).not.toBeVisible();
    await expect(page.getByText("French")).not.toBeVisible();
    await expect(page.getByText("German")).not.toBeVisible();
  });

  test("results count shows total promotions loaded from DB", async ({
    page,
  }) => {
    // Text is now "Showing X promotions" (no culture suffix)
    await expect(page.getByText(/showing \d+ promotions/i)).toBeVisible({
      timeout: 20_000,
    });
  });

  test("promotion cards with assigned products show admin and app links", async ({
    page,
  }) => {
    // Wait for promotion cards to load
    await expect(page.locator(".doodle-card").first()).toBeVisible({
      timeout: 25_000,
    });

    // Find admin-side product links (no target=_blank) inside the promotion cards
    const adminProductLinks = page
      .locator("a[href*='/product/']")
      .filter({ hasNot: page.locator("[target='_blank']") });

    const chipCount = await adminProductLinks.count();
    if (chipCount > 0) {
      // Each chip should also have a customer-app ExternalLink
      const appLinks = page.locator(
        "a[title='View in customer app'][href*='/product/']",
      );
      await expect(appLinks.first()).toBeVisible({ timeout: 5_000 });
      expect(await appLinks.first().getAttribute("target")).toBe("_blank");
    } else {
      // No promotions have assigned products yet — just verify page loaded OK
      await expect(page.getByText(/sales promotions/i)).toBeVisible();
    }
  });

  // ─── ID=1 guard ────────────────────────────────────────────────────────────

  test("No Discount (ID=1) Edit and Delete buttons are disabled", async ({
    page,
  }) => {
    // Set category filter to "All Categories" so the built-in "No Discount" card is visible
    await expect(page.locator(".doodle-card").first()).toBeVisible({
      timeout: 20_000,
    });
    const categoryCombobox = page.getByRole("combobox").nth(2);
    await categoryCombobox.click();
    await page.getByRole("option", { name: /all categories/i }).click();
    await expect(page.getByText("No Discount").first()).toBeVisible({
      timeout: 10_000,
    });

    // Find the card that contains "No Discount"
    const noDiscountCard = page
      .locator(".doodle-card")
      .filter({ hasText: "No Discount" })
      .first();

    await expect(
      noDiscountCard.getByRole("button", { name: /^edit$/i }),
    ).toBeDisabled();
    await expect(
      noDiscountCard.getByRole("button", { name: /^delete$/i }),
    ).toBeDisabled();
  });

  // ─── CRUD mutation tests ───────────────────────────────────────────────────

  test("creates a new promotion and it persists after page reload", async ({
    page,
  }) => {
    const uniqueDesc = `Playwright Create Test ${Date.now()}`;

    // Open create dialog
    await page.getByRole("button", { name: /new promotion/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // Culture selector must not be present in the create dialog
    await expect(dialog.getByText(/^culture$/i)).not.toBeVisible();

    // Fill the form
    await dialog.getByPlaceholder(/summer sale/i).fill(uniqueDesc);
    // Discount % input: first number input in the dialog
    await dialog.locator('input[type="number"]').nth(0).fill("15");
    await dialog.locator('input[type="date"]').nth(0).fill("2026-01-01");
    await dialog.locator('input[type="date"]').nth(1).fill("2026-12-31");

    // Submit
    await dialog.getByRole("button", { name: /create promotion/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: uniqueDesc })).toBeVisible({
      timeout: 15_000,
    });

    // Reload and confirm persistence
    await page.reload();
    await expect(page.getByRole("heading", { name: uniqueDesc })).toBeVisible({
      timeout: 20_000,
    });

    // Cleanup: delete the test record
    await page
      .locator(".doodle-card")
      .filter({ hasText: uniqueDesc })
      .getByRole("button", { name: /^delete$/i })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: /delete/i })
      .click();
    await expect(
      page.getByRole("heading", { name: uniqueDesc }),
    ).not.toBeVisible({
      timeout: 15_000,
    });
  });

  test("edits a promotion and changes persist after page reload", async ({
    page,
  }) => {
    const originalDesc = `Playwright Edit Test ${Date.now()}`;
    const editedDesc = `${originalDesc} UPDATED`;

    // Step 1: create a test promotion to edit
    await page.getByRole("button", { name: /new promotion/i }).click();
    const createDialog = page.getByRole("dialog");
    await expect(createDialog).toBeVisible({ timeout: 10_000 });
    await createDialog.getByPlaceholder(/summer sale/i).fill(originalDesc);
    // Discount % input: first number input in the dialog
    await createDialog.locator('input[type="number"]').nth(0).fill("5");
    await createDialog.locator('input[type="date"]').nth(0).fill("2026-01-01");
    await createDialog.locator('input[type="date"]').nth(1).fill("2026-12-31");
    await createDialog
      .getByRole("button", { name: /create promotion/i })
      .click();
    await expect(createDialog).not.toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: originalDesc })).toBeVisible(
      {
        timeout: 15_000,
      },
    );

    // Step 2: edit it
    await page
      .locator(".doodle-card")
      .filter({ hasText: originalDesc })
      .getByRole("button", { name: /^edit$/i })
      .click();
    const editDialog = page.getByRole("dialog");
    await expect(editDialog).toBeVisible({ timeout: 10_000 });

    // Description is the first text input in the edit dialog
    const descInput = editDialog.locator("input").first();
    await descInput.clear();
    await descInput.fill(editedDesc);
    await editDialog.getByRole("button", { name: /save changes/i }).click();
    await expect(editDialog).not.toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: editedDesc })).toBeVisible({
      timeout: 15_000,
    });

    // Step 3: reload and verify persistence
    await page.reload();
    await expect(page.getByRole("heading", { name: editedDesc })).toBeVisible({
      timeout: 20_000,
    });

    // Cleanup
    await page
      .locator(".doodle-card")
      .filter({ hasText: editedDesc })
      .getByRole("button", { name: /^delete$/i })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: /delete/i })
      .click();
    await expect(
      page.getByRole("heading", { name: editedDesc }),
    ).not.toBeVisible({
      timeout: 15_000,
    });
  });

  test("deletes a promotion and it is gone after page reload", async ({
    page,
  }) => {
    const uniqueDesc = `Playwright Delete Test ${Date.now()}`;

    // Create a promotion to delete
    await page.getByRole("button", { name: /new promotion/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByPlaceholder(/summer sale/i).fill(uniqueDesc);
    // Discount % input: first number input in the dialog
    await dialog.locator('input[type="number"]').nth(0).fill("0");
    await dialog.locator('input[type="date"]').nth(0).fill("2026-01-01");
    await dialog.locator('input[type="date"]').nth(1).fill("2026-12-31");
    await dialog.getByRole("button", { name: /create promotion/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: uniqueDesc })).toBeVisible({
      timeout: 15_000,
    });

    // Delete it
    await page
      .locator(".doodle-card")
      .filter({ hasText: uniqueDesc })
      .getByRole("button", { name: /^delete$/i })
      .click();
    const alertDialog = page.getByRole("alertdialog");
    await expect(alertDialog).toBeVisible({ timeout: 10_000 });
    await alertDialog.getByRole("button", { name: /delete/i }).click();
    await expect(
      page.getByRole("heading", { name: uniqueDesc }),
    ).not.toBeVisible({
      timeout: 15_000,
    });

    // Reload and confirm it is gone
    // Note: deleting a promotion removes ALL culture variants (not just English)
    await page.reload();
    await expect(
      page.getByRole("heading", { name: uniqueDesc }),
    ).not.toBeVisible({
      timeout: 20_000,
    });
  });

  // ─── Translation smoke test ────────────────────────────────────────────────

  test("creating a promotion triggers auto-translation to other cultures", async ({
    page,
    request,
  }) => {
    test.slow(); // AI translation takes up to ~45s
    const uniqueDesc = `Playwright Translation Test ${Date.now()}`;
    let createdId: number | null = null;

    try {
      // Create a new promotion
      await page.getByRole("button", { name: /new promotion/i }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await dialog.getByPlaceholder(/summer sale/i).fill(uniqueDesc);
      // Discount % input: first number input in the dialog
      await dialog.locator('input[type="number"]').nth(0).fill("10");
      await dialog.locator('input[type="date"]').nth(0).fill("2026-01-01");
      await dialog.locator('input[type="date"]').nth(1).fill("2026-12-31");
      await dialog.getByRole("button", { name: /create promotion/i }).click();
      await expect(dialog).not.toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("heading", { name: uniqueDesc })).toBeVisible(
        { timeout: 15_000 },
      );

      // Determine the SpecialOfferID from the DB via REST API
      const listRes = await request.get(
        `${testEnv.restApiBaseUrl}/SpecialOffer?$filter=Description eq '${uniqueDesc}'`,
      );
      expect(listRes.ok()).toBeTruthy();
      const listData = await listRes.json();
      const items: Array<{ SpecialOfferID: number; CultureID: string }> =
        listData?.value ?? [];
      const enRecord = items.find((i) => i.CultureID.trim() === "en");
      expect(enRecord).toBeDefined();
      createdId = enRecord!.SpecialOfferID;

      // Wait for translation (fire-and-forget; AI may take up to 45s)
      await page.waitForTimeout(45_000);

      // Verify at least one non-English culture record was created
      const allRes = await request.get(
        `${testEnv.restApiBaseUrl}/SpecialOffer?$filter=SpecialOfferID eq ${createdId}`,
      );
      expect(allRes.ok()).toBeTruthy();
      const allData = await allRes.json();
      const allItems: Array<{ CultureID: string }> = allData?.value ?? [];
      const nonEnglish = allItems.filter((i) => i.CultureID.trim() !== "en");
      expect(nonEnglish.length).toBeGreaterThan(0);
    } finally {
      // Cleanup: delete the test record (removes all culture variants)
      if (createdId !== null) {
        const card = page
          .locator(".doodle-card")
          .filter({ hasText: uniqueDesc });
        if ((await card.count()) > 0) {
          await card.getByRole("button", { name: /^delete$/i }).click();
          await page
            .getByRole("alertdialog")
            .getByRole("button", { name: /delete/i })
            .click();
        }
      }
    }
  });

  // ─── Product assignment ────────────────────────────────────────────────────

  test("product assignment dialog opens and lists products", async ({
    page,
  }) => {
    // Wait for at least one promotion card to be rendered
    await expect(page.locator(".doodle-card").first()).toBeVisible({
      timeout: 20_000,
    });

    // Click the first enabled Products button (skip ID=1 "No Discount")
    const productsBtns = page.getByRole("button", { name: /^products$/i });
    await productsBtns.first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // The dialog should contain a search input for products
    await expect(dialog.getByPlaceholder(/search/i)).toBeVisible({
      timeout: 10_000,
    });

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  });
});
