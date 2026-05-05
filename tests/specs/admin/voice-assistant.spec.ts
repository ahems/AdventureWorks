import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "../../utils/adminTestUser";

test.describe("Admin Portal – Voice Sales Assistant", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    // AdminHeader with mic button is present on all authenticated pages
  });

  test("mic toggle button is visible in header", async ({ page }) => {
    const micBtn = page.getByRole("button", {
      name: /toggle voice assistant/i,
    });
    await expect(micBtn).toBeVisible({ timeout: 15_000 });
  });

  test("clicking mic button opens the voice assistant panel", async ({
    page,
  }) => {
    const micBtn = page.getByRole("button", {
      name: /toggle voice assistant/i,
    });
    await micBtn.click();
    await expect(page.getByText("AI Voice Assistant")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("text input mode is active in headless (SpeechRecognition unavailable)", async ({
    page,
  }) => {
    const micBtn = page.getByRole("button", {
      name: /toggle voice assistant/i,
    });
    await micBtn.click();
    // Headless browsers lack SpeechRecognition → component falls back to text mode
    await expect(
      page.getByPlaceholder(/ask about customers, orders/i).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("submitting a text message shows user message in the chat", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const micBtn = page.getByRole("button", {
      name: /toggle voice assistant/i,
    });
    await micBtn.click();

    const input = page.getByPlaceholder(/ask about customers, orders/i).first();
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill("How many orders are there?");

    const sendBtn = input
      .locator("..")
      .locator("..")
      .getByRole("button")
      .last();
    await sendBtn.click();

    // The user message text should appear in the chat bubble
    await expect(page.getByText("How many orders are there?")).toBeVisible({
      timeout: 10_000,
    });

    // A thinking / spinner state or assistant response should follow
    await expect(page.locator(".animate-spin").first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("closing voice assistant panel via toggle removes it from view", async ({
    page,
  }) => {
    const micBtn = page.getByRole("button", {
      name: /toggle voice assistant/i,
    });
    await micBtn.click();
    await expect(page.getByText("AI Voice Assistant")).toBeVisible({
      timeout: 10_000,
    });
    // Click the mic button again – it toggles isVoiceOpen to false → panel returns null
    await micBtn.click();
    await expect(page.getByText("AI Voice Assistant")).not.toBeVisible({
      timeout: 5_000,
    });
  });
});
