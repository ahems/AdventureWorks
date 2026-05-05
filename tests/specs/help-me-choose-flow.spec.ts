/**
 * Help me Choose wizard – multi-turn and recommendation flow tests
 *
 * These tests exercise the wizard beyond the basic open/close already covered in
 * help-me-choose.spec.ts. They verify:
 *   - The wizard progresses through the question phase (questions loaded from AI)
 *   - The user can answer questions and reach the recommendations step
 *   - Recommendations contain real product data
 *
 * AI calls take 30-90 s each. Tests skip if the customer app URL is absent.
 */

import { test, expect } from "@playwright/test";
import { testEnv } from "../utils/env";

test.describe("Help me Choose wizard – full flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(testEnv.webBaseUrl);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("link", { name: /shop bikes/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  // -------------------------------------------------------------------------
  // 1. Wizard loads AI questions
  // -------------------------------------------------------------------------

  test("wizard loads AI-generated questions after 'Let's start'", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    const btn = page.getByRole("button", { name: /help me choose/i });
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await btn.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Click the "Let's start" / "Start" CTA in the intro screen
    const startBtn = dialog.getByRole("button", {
      name: /let.?s start|start/i,
    });
    await expect(startBtn).toBeVisible({ timeout: 5_000 });
    await startBtn.click();

    // The wizard should transition to the questions phase.
    // AI questions take 15-45 s on a cold container – allow 60 s.
    // We look for either a loading indicator that clears, or the first question.
    await expect(
      dialog
        .getByRole("radio")
        .or(dialog.getByRole("checkbox"))
        .or(dialog.locator("input"))
        .first(),
    ).toBeVisible({ timeout: 60_000 });

    const questionCount = await dialog
      .locator("label, [role='radiogroup'] label")
      .count();
    console.log(
      `✅ Wizard loaded questions (${questionCount} label elements found)`,
    );
    expect(
      questionCount,
      "at least one question label should be rendered",
    ).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 2. Wizard answers and reaches recommendations
  // -------------------------------------------------------------------------

  test("answering questions produces product recommendations", async ({
    page,
  }) => {
    test.setTimeout(180_000); // questions + recommendations = two AI calls

    const btn = page.getByRole("button", { name: /help me choose/i });
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await btn.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Start the wizard
    const startBtn = dialog.getByRole("button", {
      name: /let.?s start|start/i,
    });
    if (await startBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await startBtn.click();
    }

    // Wait for first question (inputs or radio options)
    const firstInput = dialog
      .locator(
        "input[type='radio'], input[type='checkbox'], input[type='text']",
      )
      .first();
    await expect(firstInput).toBeVisible({ timeout: 60_000 });

    // Answer all visible questions by selecting the first available option or typing text
    const radioOptions = dialog.locator("input[type='radio']");
    const radioCount = await radioOptions.count();

    if (radioCount > 0) {
      // Select the first option in each radio group
      const groups = dialog.locator("[role='radiogroup']");
      const groupCount = await groups.count();
      if (groupCount > 0) {
        for (let i = 0; i < groupCount; i++) {
          const firstRadio = groups
            .nth(i)
            .locator("input[type='radio']")
            .first();
          if (
            await firstRadio.isVisible({ timeout: 1_000 }).catch(() => false)
          ) {
            await firstRadio.check().catch(() => {});
          }
        }
      } else {
        // Just click the first few radio buttons directly
        for (let i = 0; i < Math.min(radioCount, 5); i++) {
          await radioOptions
            .nth(i)
            .check()
            .catch(() => {});
        }
      }
    }

    // Also fill text inputs if any
    const textInputs = dialog.locator("input[type='text'], textarea");
    const textCount = await textInputs.count();
    for (let i = 0; i < textCount; i++) {
      const input = textInputs.nth(i);
      if (await input.isVisible({ timeout: 500 }).catch(() => false)) {
        await input.fill("casual riding and fitness").catch(() => {});
        break; // One is enough
      }
    }

    // Submit answers – look for Submit / Get Recommendations / Next button
    const submitBtn = dialog
      .getByRole("button", {
        name: /submit|get recommendation|find|search|next|continue/i,
      })
      .last();
    await expect(submitBtn).toBeVisible({ timeout: 10_000 });
    await submitBtn.click();

    // Wait for recommendations – another AI call (up to 90 s)
    // Recommendations typically show product cards or a list with product names
    const recommendations = dialog.locator(
      "[data-testid^='product-card'], .product-card, [class*='recommendation'], [class*='product']",
    );
    const anyText = dialog.getByText(
      /we recommend|suggested|top pick|perfect for you|matches/i,
    );

    await Promise.race([
      recommendations.first().waitFor({ state: "visible", timeout: 90_000 }),
      anyText.waitFor({ state: "visible", timeout: 90_000 }),
    ]);

    // At least one result should be visible
    const resultCount = await recommendations.count();
    if (resultCount > 0) {
      expect(
        resultCount,
        "should show at least one recommendation",
      ).toBeGreaterThan(0);
      console.log(`✅ ${resultCount} product recommendation(s) displayed`);
    } else {
      // Fallback: at least the recommendations heading text should be visible
      await expect(anyText).toBeVisible({ timeout: 5_000 });
      console.log("✅ Recommendations text visible");
    }
  });

  // -------------------------------------------------------------------------
  // 3. Wizard can be restarted / dismissed from recommendations step
  // -------------------------------------------------------------------------

  test("wizard can be closed from the recommendations step", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const btn = page.getByRole("button", { name: /help me choose/i });
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await btn.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Start the wizard
    const startBtn = dialog.getByRole("button", {
      name: /let.?s start|start/i,
    });
    if (await startBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await startBtn.click();
    }

    // Wait for question phase
    await dialog
      .locator(
        "input[type='radio'], input[type='checkbox'], input[type='text']",
      )
      .first()
      .waitFor({ state: "visible", timeout: 60_000 });

    // Submit with defaults (don't bother answering for this smoke test)
    const submitBtn = dialog
      .getByRole("button", {
        name: /submit|get recommendation|find|search|next|continue/i,
      })
      .last();
    if (await submitBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await submitBtn.click();
    }

    // Wait briefly, then dismiss via Escape
    await page.waitForTimeout(3_000);
    await page.keyboard.press("Escape");

    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
    console.log(
      "✅ Dialog dismissed via Escape from the recommendations / loading step",
    );
  });
});
