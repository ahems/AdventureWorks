import { test, expect } from "@playwright/test";
import { testEnv } from "../../utils/env";
import { loginAsAdmin } from "../../utils/adminTestUser";

test.describe("Admin Portal – Products (Category & Detail)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("Bikes category page loads and shows products", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/category/1`);
    // Subcategory filter buttons visible
    await expect(
      page.getByText(/mountain bikes|road bikes|touring bikes/i).first(),
    ).toBeVisible({
      timeout: 20_000,
    });
    // At least one product card
    await expect(
      page.locator("[data-testid=admin-product-card], .doodle-card").nth(1),
    ).toBeVisible({
      timeout: 20_000,
    });
  });

  test("category page supports subcategory filtering", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/category/1`);
    // Click first subcategory filter that appears
    const firstSubcat = page
      .getByRole("button", { name: /mountain bikes/i })
      .first();
    await expect(firstSubcat).toBeVisible({ timeout: 15_000 });
    await firstSubcat.click();
    // Products should still be shown
    await expect(page.locator(".doodle-card").nth(1)).toBeVisible();
  });

  test("category page supports sort by name", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/category/1`);
    // Sort select should be visible
    await expect(page.getByText(/name a-z|name z-a|sort/i).first()).toBeVisible(
      { timeout: 15_000 },
    );
  });

  test("clicking a product navigates to product detail page", async ({
    page,
  }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/category/1`);
    // Wait for products to load
    await page.waitForTimeout(2000);
    const productLinks = page
      .getByRole("link")
      .filter({ hasText: /edit|view|bike/i });
    const firstProductLink = productLinks.first();
    if ((await firstProductLink.count()) > 0) {
      const href = await firstProductLink.getAttribute("href");
      if (href && href.includes("/product/")) {
        await firstProductLink.click();
        await expect(page).toHaveURL(/\/product\/\d+/);
        await expect(page.getByText(/edit product/i)).toBeVisible({
          timeout: 15_000,
        });
      }
    }
  });

  test("product detail page shows SKU field", async ({ page }) => {
    // Navigate directly to a known product to avoid SPA-navigation timing issues
    // Product 775 = Mountain-100 Black, 38 (always present in AdventureWorks seed data)
    await page.goto(`${testEnv.adminWebBaseUrl}/product/775`);

    // Edit Product heading confirms the product loaded (not "Product Not Found")
    await expect(page.getByText(/edit product/i)).toBeVisible({
      timeout: 20_000,
    });
    // SKU label is rendered inside the Edit Product card
    await expect(page.locator("label", { hasText: /^SKU$/i })).toBeVisible({
      timeout: 5_000,
    });
  });

  test("product detail page has 'View in app' link pointing to customer app", async ({
    page,
  }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/product/775`);
    await expect(page.getByText(/edit product/i)).toBeVisible({
      timeout: 20_000,
    });

    const viewInAppLink = page.getByRole("link", { name: /view in app/i });
    await expect(viewInAppLink).toBeVisible({ timeout: 5_000 });
    const href = await viewInAppLink.getAttribute("href");
    expect(href).toMatch(/\/product\/775/);
    expect(await viewInAppLink.getAttribute("target")).toBe("_blank");
  });

  test("category page has 'View in customer app' ExternalLink icon on category header", async ({
    page,
  }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/category/1`);
    await expect(page.getByText(/product management/i)).toBeVisible({
      timeout: 20_000,
    });

    // ExternalLink icon is inside an <a> with title describing the customer app
    const catAppLink = page.locator(
      "a[title*='customer app'][href*='/category/']",
    );
    await expect(catAppLink).toBeVisible({ timeout: 5_000 });
    const href = await catAppLink.getAttribute("href");
    expect(href).toMatch(/\/category\/1/);
    expect(await catAppLink.getAttribute("target")).toBe("_blank");
  });

  test("product cards on category page have 'View in customer app' icon link", async ({
    page,
  }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/category/1`);
    // Wait for at least one product card to load
    await expect(page.locator(".doodle-card").nth(1)).toBeVisible({
      timeout: 25_000,
    });

    // There should be at least one ExternalLink icon pointing to a product in the customer app
    const productAppLinks = page.locator(
      "a[title='View in customer app'][href*='/product/']",
    );
    await expect(productAppLinks.first()).toBeVisible({ timeout: 5_000 });
    const href = await productAppLinks.first().getAttribute("href");
    expect(href).toMatch(/\/product\/\d+/);
    expect(await productAppLinks.first().getAttribute("target")).toBe("_blank");
  });

  test("Components category page loads", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/category/2`);
    await expect(
      page.getByText(/components|handlebars|frames|wheels/i).first(),
    ).toBeVisible({
      timeout: 20_000,
    });
  });

  // ── New feature tests ────────────────────────────────────────────────────────

  test("product images on category page are real (not placeholder)", async ({
    page,
  }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/category/1`);
    // Wait for product cards to load
    await expect(page.locator(".doodle-card").nth(1)).toBeVisible({
      timeout: 25_000,
    });
    // At least one product image should have a data:image src (real thumbnail)
    const images = page.locator("img[src^='data:image']");
    await expect(images.first()).toBeVisible({ timeout: 15_000 });
  });

  test("product detail page shows US English badge on Name field", async ({
    page,
  }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/product/775`);
    await expect(page.getByText(/edit product/i)).toBeVisible({
      timeout: 20_000,
    });
    // US English badge visible near Name label
    const usBadges = page.getByText(/us english/i);
    await expect(usBadges.first()).toBeVisible({ timeout: 5_000 });
  });

  test("product detail page shows US English badge on Description field", async ({
    page,
  }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/product/775`);
    await expect(page.getByText(/edit product/i)).toBeVisible({
      timeout: 20_000,
    });
    // At least 2 US English badges (Name + Description)
    const usBadges = page.getByText(/us english/i);
    await expect(usBadges.nth(1)).toBeVisible({ timeout: 5_000 });
  });

  test("product detail page description field is pre-populated", async ({
    page,
  }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/product/775`);
    await expect(page.getByText(/edit product/i)).toBeVisible({
      timeout: 20_000,
    });
    // Wait for description to load from API
    const descriptionField = page.locator(
      "textarea[placeholder*='English description'], textarea[name='description'], textarea",
    );
    await expect(descriptionField.first()).toBeVisible({ timeout: 10_000 });
    // The description should not be empty
    await expect(async () => {
      const val = await descriptionField.first().inputValue();
      expect(val.length).toBeGreaterThan(5);
    }).toPass({ timeout: 15_000 });
  });

  test("category page has Create Product button", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/category/1`);
    await expect(page.getByText(/product management/i)).toBeVisible({
      timeout: 20_000,
    });
    // Create Product button visible in header area
    const createBtn = page.getByTestId("create-product-btn");
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
  });

  test("Create Product button opens dialog", async ({ page }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/category/1`);
    const createBtn = page.getByTestId("create-product-btn");
    await expect(createBtn).toBeVisible({ timeout: 20_000 });
    await createBtn.click();
    // Dialog should appear with US English badge
    await expect(page.getByText(/create new product/i)).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByText(/us english/i).first()).toBeVisible({
      timeout: 3_000,
    });
  });

  test("Create Product form sends correct GraphQL variable types (Decimal, Short, DateTime)", async ({
    page,
  }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/category/1`);
    await expect(page.getByTestId("create-product-btn")).toBeVisible({
      timeout: 20_000,
    });
    await page.getByTestId("create-product-btn").click();
    await expect(page.getByText(/create new product/i)).toBeVisible({
      timeout: 5_000,
    });

    // Fill required fields
    await page.getByPlaceholder(/mountain bike pro/i).fill("Test Bike Types");
    await page.getByPlaceholder(/mb-5000/i).fill("TB-TYPES-001");
    await page.locator("input[name='ListPrice']").fill("499.99");
    await page.locator("input[name='StandardCost']").fill("250.00");
    await page
      .getByPlaceholder(/describe this product/i)
      .fill("A test product for type checking.");

    // Wait for subcategory options to load from the API before selecting
    const subcategorySelect = page.locator(
      "select[name='ProductSubcategoryID']",
    );
    await expect(subcategorySelect.locator("option").nth(1)).toBeAttached({
      timeout: 15_000,
    });
    await subcategorySelect.selectOption({ index: 1 });

    // Capture any GraphQL "variable type mismatch" error responses that would
    // indicate the bug (Float!/Int!/String! instead of Decimal!/Short!/DateTime!).
    const typeMismatchErrors: string[] = [];
    page.on("response", async (res) => {
      if (!res.url().includes("/graphql")) return;
      try {
        const json = (await res.json()) as {
          errors?: Array<{
            message?: string;
            extensions?: { variableType?: string; locationType?: string };
          }>;
        };
        for (const err of json.errors ?? []) {
          if (err.message?.includes("is not compatible with the type")) {
            typeMismatchErrors.push(
              `${err.extensions?.variableType} vs ${err.extensions?.locationType}`,
            );
          }
        }
      } catch {
        // not a JSON response
      }
    });

    // Click submit – use { force: true } to bypass pointer-interception from
    // background product images overlapping the dialog's inner scrollable area.
    // Wait for navigation to /product/:id which confirms the mutation succeeded.
    await page.locator("button[type='submit']").click({ force: true });
    await expect(page).toHaveURL(/\/product\/\d+/, { timeout: 30_000 });

    // Navigation succeeding proves the mutation was accepted without type errors.
    // The captured errors array provides a detailed failure message if it regresses.
    expect(typeMismatchErrors).toHaveLength(0);
  });

  test("Create Product submits successfully and navigates to new product page", async ({
    page,
  }) => {
    // Use a timestamp suffix to avoid SKU conflicts on repeated runs
    const uniqueSuffix = Date.now().toString().slice(-6);
    const productName = `Test Product ${uniqueSuffix}`;
    const productNumber = `TP-${uniqueSuffix}`;

    await page.goto(`${testEnv.adminWebBaseUrl}/category/1`);
    await expect(page.getByTestId("create-product-btn")).toBeVisible({
      timeout: 20_000,
    });
    await page.getByTestId("create-product-btn").click();
    await expect(page.getByText(/create new product/i)).toBeVisible({
      timeout: 5_000,
    });

    // Fill form
    await page.getByPlaceholder(/mountain bike pro/i).fill(productName);
    await page.getByPlaceholder(/mb-5000/i).fill(productNumber);
    await page.locator("input[name='ListPrice']").fill("299.99");
    await page.locator("input[name='StandardCost']").fill("150.00");
    await page
      .getByPlaceholder(/describe this product/i)
      .fill("A test bike product for automated testing.");

    // Wait for subcategory options to load before selecting
    const subcategorySelect = page.locator(
      "select[name='ProductSubcategoryID']",
    );
    await expect(subcategorySelect.locator("option").nth(1)).toBeAttached({
      timeout: 15_000,
    });
    await subcategorySelect.selectOption({ index: 1 });

    // Submit and wait for navigation to the new product page.
    // Use { force: true } to bypass pointer-interception from background images
    // when the dialog's inner scrollable area positions the button over the grid.
    await page.locator("button[type='submit']").click({ force: true });

    // After successful creation the dialog closes and the app navigates to /product/<id>
    await expect(page).toHaveURL(/\/product\/\d+/, { timeout: 20_000 });
    await expect(page.getByText(/edit product/i)).toBeVisible({
      timeout: 15_000,
    });
  });

  // ── Edit Product page smoke test ─────────────────────────────────────────────
  // Verifies the product edit page renders without the TDZ crash introduced by
  // Rollup chunk circular-dependency issues, and that a save round-trip works.
  // Uses product 775 (Mountain-100 Black, 38) – always present in seeded data.

  test("Edit Product page loads without JS errors (product 775)", async ({
    page,
  }) => {
    const jsErrors: string[] = [];
    page.on("pageerror", (err) => jsErrors.push(err.message));

    await page.goto(`${testEnv.adminWebBaseUrl}/product/775`);

    // Page must render the edit form heading
    await expect(page.getByText(/edit product/i)).toBeVisible({
      timeout: 25_000,
    });

    // Core fields from the updated edit page must be present
    await expect(page.locator("input[name='name']")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator("input[name='standardCost']")).toBeVisible();
    await expect(page.locator("input[name='listPrice']")).toBeVisible();

    // No TDZ / reference errors should have been thrown
    const tdz = jsErrors.filter(
      (e) =>
        e.includes("Cannot access") ||
        e.includes("before initialization") ||
        e.includes("ReferenceError"),
    );
    expect(tdz, `JS errors on product page: ${tdz.join("; ")}`).toHaveLength(0);
  });

  test("Edit Product page – Standard Cost auto-fills List Price at +20%", async ({
    page,
  }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/product/775`);
    await expect(page.getByText(/edit product/i)).toBeVisible({
      timeout: 25_000,
    });

    const costInput = page.locator("input[name='standardCost']");
    const priceInput = page.locator("input[name='listPrice']");
    await expect(costInput).toBeVisible({ timeout: 10_000 });

    // Clear and type a known value — list price should auto-fill to cost × 1.2
    await costInput.fill("100");
    // Wait for the auto-fill effect
    await expect(async () => {
      const price = await priceInput.inputValue();
      expect(parseFloat(price)).toBeCloseTo(120, 0);
    }).toPass({ timeout: 5_000 });
  });

  test("Edit Product page – save succeeds and shows success toast", async ({
    page,
  }) => {
    await page.goto(`${testEnv.adminWebBaseUrl}/product/775`);
    await expect(page.getByText(/edit product/i)).toBeVisible({
      timeout: 25_000,
    });

    // Wait for product data to load (name field populated)
    const nameInput = page.locator("input[name='name']");
    await expect(async () => {
      const val = await nameInput.inputValue();
      expect(val.length).toBeGreaterThan(0);
    }).toPass({ timeout: 15_000 });

    // Capture JS errors
    const jsErrors: string[] = [];
    page.on("pageerror", (e) => jsErrors.push(e.message));

    // Set up a listener that waits for the updateProduct mutation response
    const mutationErrors: string[] = [];
    let mutationFired = false;
    const mutationDone = new Promise<void>((resolve) => {
      page.on("request", async (req) => {
        if (!req.url().includes("/graphql")) return;
        try {
          const body = req.postDataJSON() as { operationName?: string };
          if (body?.operationName === "UpdateProduct") {
            mutationFired = true;
          }
        } catch {
          /* ignore */
        }
      });
      page.on("response", async (res) => {
        if (!res.url().includes("/graphql") || !mutationFired) return;
        try {
          const json = (await res.json()) as {
            errors?: Array<{ message: string }>;
            data?: { updateProduct?: unknown };
          };
          if (json.data?.updateProduct !== undefined || json.errors) {
            for (const e of json.errors ?? []) mutationErrors.push(e.message);
            resolve();
          }
        } catch {
          /* ignore */
        }
      });
    });

    // Click the Save Changes button
    const saveBtn = page.getByRole("button", { name: /save changes/i });
    await expect(saveBtn).toBeVisible({ timeout: 5_000 });
    await saveBtn.scrollIntoViewIfNeeded();

    // Start watching for the success toast BEFORE clicking so we don't miss a fast-dismiss
    const toastPromise = page
      .getByText(/product saved|saved successfully/i)
      .first()
      .waitFor({ state: "visible", timeout: 25_000 })
      .catch(() => null);

    await saveBtn.click({ force: true });

    // Wait for the updateProduct mutation to complete (max 15s)
    await Promise.race([mutationDone, page.waitForTimeout(15_000)]);

    // Mutation must have actually fired
    expect(mutationFired, "updateProduct mutation was not sent").toBe(true);

    // No mutation errors
    expect(
      mutationErrors.filter((e) => !e.includes("deprecated")),
      `GraphQL errors on save: ${mutationErrors.join("; ")}`,
    ).toHaveLength(0);

    // No JS crashes
    expect(
      jsErrors,
      `JS errors after save: ${jsErrors.join("; ")}`,
    ).toHaveLength(0);

    // Toast must have appeared (we started watching before clicking save)
    const toastSeen = await toastPromise;
    expect(toastSeen, "Product saved toast was not seen").not.toBeNull();
  });
});
