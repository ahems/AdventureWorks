import { test, expect } from "@playwright/test";
import { testEnv } from "../../utils/env";
import { loginAsAdmin } from "../../utils/adminTestUser";

test.describe("Admin Portal – Product Variations Wizard", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${testEnv.adminWebBaseUrl}/products`);
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({
      timeout: 20_000,
    });
  });

  // ── Toggle visibility ───────────────────────────────────────────────────

  test("variation mode checkbox appears in Create Product dialog", async ({
    page,
  }) => {
    await page.getByTestId("create-product-btn").click();
    const toggle = page.getByTestId("variation-mode-toggle");
    await expect(toggle).toBeVisible({ timeout: 5_000 });
    await expect(toggle.getByText("Create multiple variations")).toBeVisible();
  });

  test("toggling variation mode shows step indicator", async ({ page }) => {
    await page.getByTestId("create-product-btn").click();
    // Not visible initially
    await expect(page.getByTestId("wizard-step-indicator")).not.toBeVisible();

    // Check the variation toggle
    await page.getByTestId("variation-mode-toggle").locator("input").check();
    await expect(page.getByTestId("wizard-step-indicator")).toBeVisible();
    await expect(page.getByText("Base Product")).toBeVisible();
  });

  test("toggling variation mode off hides step indicator and restores single mode", async ({
    page,
  }) => {
    await page.getByTestId("create-product-btn").click();
    const checkbox = page.getByTestId("variation-mode-toggle").locator("input");
    await checkbox.check();
    await expect(page.getByTestId("wizard-step-indicator")).toBeVisible();

    await checkbox.uncheck();
    await expect(page.getByTestId("wizard-step-indicator")).not.toBeVisible();
    // SKU field should be visible again in single mode
    await expect(page.getByPlaceholder("e.g. MB-5000-BK")).toBeVisible();
  });

  // ── Step 2: Dimension selection ─────────────────────────────────────────

  test("can navigate to step 2 and select colors/sizes", async ({ page }) => {
    await page.getByTestId("create-product-btn").click();
    await page.getByTestId("variation-mode-toggle").locator("input").check();

    // Fill required base fields for step 1
    await page.getByPlaceholder("e.g. Mountain Bike Pro 500").fill("Test Bike");
    await page.locator("input[name='StandardCost']").fill("100");
    // List price auto-fills
    await page
      .getByPlaceholder(
        "Describe this product — other languages auto-translated after creation",
      )
      .fill("A test product");

    // Select category + subcategory (first available)
    const categorySelect = page.locator("select").nth(0);
    await categorySelect.selectOption({ index: 1 });
    // Wait for subcategory options to load
    await page.waitForTimeout(1000);

    // Click Next
    await page.getByTestId("wizard-next-btn").click();
    await expect(page.getByTestId("wizard-step-2")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByText("Select Variations")).toBeVisible();

    // Select 2 colors
    await page.getByTestId("color-checkbox-Black").check();
    await page.getByTestId("color-checkbox-Red").check();

    // Select 2 sizes
    await page.getByTestId("size-checkbox-S").check();
    await page.getByTestId("size-checkbox-L").check();

    // Verify total count
    await expect(page.getByTestId("variation-total-count")).toContainText("4");
  });

  test("Next button is disabled on step 2 without selections", async ({
    page,
  }) => {
    await page.getByTestId("create-product-btn").click();
    await page.getByTestId("variation-mode-toggle").locator("input").check();

    // Fill required base fields
    await page.getByPlaceholder("e.g. Mountain Bike Pro 500").fill("Test Bike");
    await page.locator("input[name='StandardCost']").fill("100");
    await page
      .getByPlaceholder(
        "Describe this product — other languages auto-translated after creation",
      )
      .fill("A test product");
    const categorySelect = page.locator("select").nth(0);
    await categorySelect.selectOption({ index: 1 });
    await page.waitForTimeout(1000);

    await page.getByTestId("wizard-next-btn").click();
    await expect(page.getByTestId("wizard-step-2")).toBeVisible();

    // Next should be disabled (no colors or sizes selected)
    await expect(page.getByTestId("wizard-next-btn")).toBeDisabled();

    // Select only color — still disabled
    await page.getByTestId("color-checkbox-Black").check();
    await expect(page.getByTestId("wizard-next-btn")).toBeDisabled();

    // Select a size too — enabled
    await page.getByTestId("size-checkbox-M").check();
    await expect(page.getByTestId("wizard-next-btn")).toBeEnabled();
  });

  // ── Step 3: Preview table ───────────────────────────────────────────────

  test("preview table shows correct rows with cost escalation", async ({
    page,
  }) => {
    await page.getByTestId("create-product-btn").click();
    await page.getByTestId("variation-mode-toggle").locator("input").check();

    // Fill base fields
    await page.getByPlaceholder("e.g. Mountain Bike Pro 500").fill("Test Bike");
    await page.locator("input[name='StandardCost']").fill("100");
    await page
      .getByPlaceholder(
        "Describe this product — other languages auto-translated after creation",
      )
      .fill("A test product");
    const categorySelect = page.locator("select").nth(0);
    await categorySelect.selectOption({ index: 1 });
    await page.waitForTimeout(1000);

    // Step 2
    await page.getByTestId("wizard-next-btn").click();
    await expect(page.getByTestId("wizard-step-2")).toBeVisible();

    await page.getByTestId("color-checkbox-Black").check();
    await page.getByTestId("color-checkbox-Red").check();
    await page.getByTestId("size-checkbox-S").check();
    await page.getByTestId("size-checkbox-L").check();

    // Step 3
    await page.getByTestId("wizard-next-btn").click();
    await expect(page.getByTestId("wizard-step-3")).toBeVisible({
      timeout: 5_000,
    });

    // 2 colors × 2 sizes = 4 rows
    const table = page.getByTestId("variation-preview-table");
    const rows = table.locator("tbody tr");
    await expect(rows).toHaveCount(4);

    // First row should have $100.00 cost (smallest size = S)
    const firstCost = rows.nth(0).locator("td").nth(5);
    await expect(firstCost).toHaveText("$100.00");

    // Row for size L should have ~$110.00 cost (2 steps from S → L: S=1, M=2, L=3, diff=2 → 1.10)
    // S index=1, L index=3 → diff=2 → 1 + 0.05*2 = 1.10 → $110.00
    const lRow = rows.nth(1).locator("td").nth(5);
    await expect(lRow).toHaveText("$110.00");

    // All SKUs should be unique
    const skus: string[] = [];
    for (let i = 0; i < 4; i++) {
      const sku = await rows.nth(i).locator("td").nth(1).textContent();
      skus.push(sku ?? "");
    }
    const uniqueSkus = new Set(skus);
    expect(uniqueSkus.size).toBe(4);
  });

  // ── Cancel & Back navigation ────────────────────────────────────────────

  test("back button returns to previous step", async ({ page }) => {
    await page.getByTestId("create-product-btn").click();
    await page.getByTestId("variation-mode-toggle").locator("input").check();

    // Fill base fields
    await page.getByPlaceholder("e.g. Mountain Bike Pro 500").fill("Test Bike");
    await page.locator("input[name='StandardCost']").fill("50");
    await page
      .getByPlaceholder(
        "Describe this product — other languages auto-translated after creation",
      )
      .fill("A test product");
    const categorySelect = page.locator("select").nth(0);
    await categorySelect.selectOption({ index: 1 });
    await page.waitForTimeout(1000);

    // Go to step 2
    await page.getByTestId("wizard-next-btn").click();
    await expect(page.getByTestId("wizard-step-2")).toBeVisible();
    await expect(page.getByText("Select Variations")).toBeVisible();

    // Go back to step 1
    await page.getByTestId("wizard-back-btn").click();
    await expect(page.getByText("Base Product")).toBeVisible();
    // Base form values should be preserved
    await expect(
      page.getByPlaceholder("e.g. Mountain Bike Pro 500"),
    ).toHaveValue("Test Bike");
  });

  test("cancel closes wizard without creating products", async ({ page }) => {
    await page.getByTestId("create-product-btn").click();
    await page.getByTestId("variation-mode-toggle").locator("input").check();
    await page.getByPlaceholder("e.g. Mountain Bike Pro 500").fill("Test Bike");

    // Click Cancel
    await page.getByRole("button", { name: "Cancel" }).click();
    // Dialog should close
    await expect(page.getByTestId("variation-mode-toggle")).not.toBeVisible();

    // Reopen — should be reset
    await page.getByTestId("create-product-btn").click();
    await expect(
      page.getByPlaceholder("e.g. Mountain Bike Pro 500"),
    ).toHaveValue("");
    await expect(
      page.getByTestId("variation-mode-toggle").locator("input"),
    ).not.toBeChecked();
  });

  // ── Styles dimension ────────────────────────────────────────────────────

  test("selecting styles multiplies variation count", async ({ page }) => {
    await page.getByTestId("create-product-btn").click();
    await page.getByTestId("variation-mode-toggle").locator("input").check();

    await page.getByPlaceholder("e.g. Mountain Bike Pro 500").fill("Test Bike");
    await page.locator("input[name='StandardCost']").fill("80");
    await page
      .getByPlaceholder(
        "Describe this product — other languages auto-translated after creation",
      )
      .fill("A test product");
    const categorySelect = page.locator("select").nth(0);
    await categorySelect.selectOption({ index: 1 });
    await page.waitForTimeout(1000);

    await page.getByTestId("wizard-next-btn").click();
    await expect(page.getByTestId("wizard-step-2")).toBeVisible();

    await page.getByTestId("color-checkbox-Black").check();
    await page.getByTestId("size-checkbox-S").check();
    await page.getByTestId("size-checkbox-M").check();

    // 1 color × 2 sizes × 1 (no styles) = 2
    await expect(page.getByTestId("variation-total-count")).toContainText("2");

    // Now add 2 styles → 1 × 2 × 2 = 4
    await page.getByTestId("style-checkbox-M").check();
    await page.getByTestId("style-checkbox-W").check();
    await expect(page.getByTestId("variation-total-count")).toContainText("4");
  });

  // ── Existing single-product mode still works ────────────────────────────

  test("single-product mode remains functional when checkbox unchecked", async ({
    page,
  }) => {
    await page.getByTestId("create-product-btn").click();

    // Verify checkbox is unchecked
    await expect(
      page.getByTestId("variation-mode-toggle").locator("input"),
    ).not.toBeChecked();

    // SKU field visible in single mode
    await expect(page.getByPlaceholder("e.g. MB-5000-BK")).toBeVisible();

    // Color/Size selects visible
    await expect(page.locator("select[name='Color']")).toBeVisible();
    await expect(page.locator("select[name='Size']")).toBeVisible();

    // Create Product button visible (not wizard next)
    await expect(
      page.getByRole("button", { name: /Create Product/i }),
    ).toBeVisible();
    await expect(page.getByTestId("wizard-next-btn")).not.toBeVisible();
  });
});
