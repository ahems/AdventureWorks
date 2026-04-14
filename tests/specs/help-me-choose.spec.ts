import { test, expect } from "@playwright/test";
import { testEnv } from "../utils/env";

/**
 * Tests for the "Help me Choose" AI wizard feature.
 * Does NOT require authentication — the button is on the public home page.
 */
test.describe("Help me Choose wizard", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(testEnv.webBaseUrl);
    await page.waitForLoadState("domcontentloaded");
    // Wait for the hero CTA buttons to render (more specific than a generic <section>)
    await expect(page.getByRole("link", { name: /shop bikes/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  // -------------------------------------------------------------------------
  // 1. Button presence
  // -------------------------------------------------------------------------
  test("'Help me Choose' button is visible on the home page", async ({
    page,
  }) => {
    const btn = page.getByRole("button", { name: /help me choose/i });
    await expect(btn).toBeVisible({ timeout: 10_000 });
    console.log("✅ Help me Choose button found in hero section");
  });

  // -------------------------------------------------------------------------
  // 2. Dialog opens on click (core regression test)
  // -------------------------------------------------------------------------
  test("clicking the button opens the wizard dialog", async ({ page }) => {
    // Capture any console errors during the click
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    const btn = page.getByRole("button", { name: /help me choose/i });
    await expect(btn).toBeVisible({ timeout: 10_000 });

    // Verify dialog is NOT visible before click
    const dialog = page.getByRole("dialog");
    await expect(dialog).not.toBeVisible();

    // Click the button
    await btn.click();

    // Dialog should appear — allow up to 5 s for animation
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Dialog should contain the intro heading (scoped inside dialog)
    await expect(
      dialog.getByRole("heading", { name: /let.s find your perfect gear/i }),
    ).toBeVisible({ timeout: 5_000 });

    // Log z-index and position to diagnose CSS issues
    const dialogStyle = await dialog.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        position: cs.position,
        zIndex: cs.zIndex,
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
        top: cs.top,
        left: cs.left,
      };
    });
    console.log("Dialog computed style:", JSON.stringify(dialogStyle, null, 2));

    if (consoleErrors.length) {
      console.warn("Console errors during test:", consoleErrors);
    }

    console.log("✅ Wizard dialog opened successfully");
  });

  // -------------------------------------------------------------------------
  // 3. Dialog has correct structure
  // -------------------------------------------------------------------------
  test("wizard dialog contains intro text and start button", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /help me choose/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Intro text
    await expect(
      dialog.getByRole("heading", { name: /let.s find your perfect gear/i }),
    ).toBeVisible({ timeout: 5_000 });

    // CTA button
    const startBtn = dialog.getByRole("button", { name: /let's start|start/i });
    await expect(startBtn).toBeVisible({ timeout: 5_000 });

    console.log("✅ Wizard intro screen rendered correctly");
  });

  // -------------------------------------------------------------------------
  // 4. Dialog can be closed
  // -------------------------------------------------------------------------
  test("wizard dialog can be dismissed", async ({ page }) => {
    await page.getByRole("button", { name: /help me choose/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Close via the X button rendered by DialogContent
    await page.keyboard.press("Escape");

    await expect(dialog).not.toBeVisible({ timeout: 3_000 });
    console.log("✅ Wizard dialog dismissed successfully");
  });

  // -------------------------------------------------------------------------
  // 5. CSS position check via the dialog role itself
  // -------------------------------------------------------------------------
  test("diagnose: dialog has position:fixed and is fully visible", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /help me choose/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Verify computed CSS — position must be fixed, not relative (doodle-card conflict)
    const style = await dialog.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        position: cs.position,
        zIndex: cs.zIndex,
        visibility: cs.visibility,
        opacity: parseFloat(cs.opacity),
      };
    });

    console.log("Dialog computed style:", JSON.stringify(style, null, 2));

    expect(style.position).toBe("fixed");
    expect(parseInt(style.zIndex)).toBeGreaterThanOrEqual(50);
    expect(style.visibility).toBe("visible");
    expect(style.opacity).toBeGreaterThan(0);

    console.log("✅ Dialog has correct position: fixed with z-index ≥ 50");
  });
});
