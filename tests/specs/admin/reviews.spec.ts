import { test, expect } from "@playwright/test";
import { testEnv } from "../../utils/env";
import { loginAsAdmin } from "../../utils/adminTestUser";
import {
  createTestReview,
  deleteTestReview,
  approveTestReview,
  createTestReply,
} from "../../utils/reviewHelper";

test.describe("Admin Portal – Reviews", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${testEnv.adminWebBaseUrl}/reviews`);
  });

  test("reviews page renders", async ({ page }) => {
    await expect(page.getByText(/reviews/i).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test("review cards appear after API loads", async ({ page }) => {
    // Reviews rendered as cards or table rows
    await expect(page.locator("article, [class*=card], tr").nth(1)).toBeVisible(
      { timeout: 25_000 },
    );
  });

  test("search filter input is present", async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search/i).first();
    await expect(searchInput).toBeVisible({ timeout: 15_000 });
  });

  test("review cards show product name as admin link and 'View in app' ExternalLink", async ({
    page,
  }) => {
    // Wait for at least one review card to load
    await expect(page.locator(".doodle-card").first()).toBeVisible({
      timeout: 25_000,
    });

    // Each review shows "Product: <name>" — the name should be a link to the admin product page
    const adminProductLinks = page.locator("a[href*='/product/']").filter({
      hasNot: page.locator("[target='_blank']"),
    });
    await expect(adminProductLinks.first()).toBeVisible({ timeout: 10_000 });

    // There should also be an ExternalLink icon linking to the customer app
    const appProductLinks = page.locator(
      "a[title='View in customer app'][href*='/product/']",
    );
    await expect(appProductLinks.first()).toBeVisible({ timeout: 5_000 });
    expect(await appProductLinks.first().getAttribute("target")).toBe("_blank");
  });

  test("rating filter is available", async ({ page }) => {
    const ratingFilter = page.getByRole("combobox").first();
    await expect(ratingFilter).toBeVisible({ timeout: 15_000 });
  });

  test("AI analyze button is present and disabled until reviews selected", async ({
    page,
  }) => {
    // Wait for review cards to load
    await expect(page.locator(".doodle-card").first()).toBeVisible({
      timeout: 25_000,
    });
    const analyzeBtn = page.getByRole("button", { name: /run ai analysis/i });
    await expect(analyzeBtn).toBeVisible({ timeout: 15_000 });
    // Button must be disabled when nothing is selected
    await expect(analyzeBtn).toBeDisabled();
    // Select one review (nth(0) is the "select all" checkbox; individual cards start at nth(1))
    await page.getByRole("checkbox").nth(1).click();
    await expect(analyzeBtn).toBeEnabled();
  });

  test("clicking Run AI Analysis starts the analysis process", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    // Wait for review cards to load and select 3 reviews before analyzing
    await expect(page.locator(".doodle-card").first()).toBeVisible({
      timeout: 25_000,
    });
    const checkboxes = page.getByRole("checkbox");
    await checkboxes.nth(1).click();
    await checkboxes.nth(2).click();
    await checkboxes.nth(3).click();
    const analyzeBtn = page.getByRole("button", {
      name: /run ai analysis \(3\)/i,
    });
    await expect(analyzeBtn).toBeVisible({ timeout: 5_000 });
    await analyzeBtn.click();
    // Button transitions: "Run AI Analysis" → "Analyzing..." → "Re-analyze"
    // Accept either in-progress or completed state (API may be fast on warm instances)
    await expect(
      page.getByRole("button", { name: /analyzing|re-analyze/i }),
    ).toBeVisible({ timeout: 200_000 });
  });

  test("AI analysis completes and Re-analyze button appears", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    // Wait for review cards to load and select 3 reviews before analyzing
    await expect(page.locator(".doodle-card").first()).toBeVisible({
      timeout: 25_000,
    });
    const checkboxes = page.getByRole("checkbox");
    await checkboxes.nth(1).click();
    await checkboxes.nth(2).click();
    await checkboxes.nth(3).click();
    const analyzeBtn = page.getByRole("button", {
      name: /run ai analysis \(3\)/i,
    });
    await expect(analyzeBtn).toBeVisible({ timeout: 5_000 });
    await analyzeBtn.click();
    // After analysis completes the button label changes to "Re-analyze (3)"
    // Batch AI analysis can take up to ~3 minutes on a cold Azure Functions instance
    await expect(page.getByRole("button", { name: /re-analyze/i })).toBeVisible(
      { timeout: 200_000 },
    );
  });

  test("View AI Summary dialog shows Powered by Azure AI after analysis", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    // Wait for review cards to load and select 3 reviews before analyzing
    await expect(page.locator(".doodle-card").first()).toBeVisible({
      timeout: 25_000,
    });
    const checkboxes = page.getByRole("checkbox");
    await checkboxes.nth(1).click();
    await checkboxes.nth(2).click();
    await checkboxes.nth(3).click();
    const analyzeBtn = page.getByRole("button", {
      name: /run ai analysis \(3\)/i,
    });
    await expect(analyzeBtn).toBeVisible({ timeout: 5_000 });
    await analyzeBtn.click();
    // Wait for analysis to finish (batch AI can take ~3 minutes on cold start)
    await expect(page.getByRole("button", { name: /re-analyze/i })).toBeVisible(
      { timeout: 200_000 },
    );
    // "View AI Summary" button appears after analysis
    const viewSummaryBtn = page.getByRole("button", {
      name: /view ai summary/i,
    });
    await expect(viewSummaryBtn).toBeVisible({ timeout: 10_000 });
    await viewSummaryBtn.click();
    // Dialog content should contain the Azure AI attribution
    await expect(page.getByText("Powered by Azure AI")).toBeVisible({
      timeout: 10_000,
    });
  });

  // ─── Moderation filter ────────────────────────────────────────────────────

  test("moderation filter shows only pending reviews", async ({ page }) => {
    await expect(page.locator(".doodle-card").first()).toBeVisible({
      timeout: 25_000,
    });
    // Select the moderation dropdown (last combobox in the filter row)
    const selects = page.getByRole("combobox");
    // The moderation select is the last one; click it and pick "Pending"
    await selects.last().click();
    await page.getByRole("option", { name: /pending/i }).click();
    // At least one card should still be visible (unmoderated reviews exist)
    await expect(page.locator(".doodle-card").nth(1)).toBeVisible({
      timeout: 10_000,
    });
    // "Approved" badge should not be visible in the filtered results
    const approvedBadges = page.locator("text=Approved");
    // Allow 0 approved badges when filter is "Pending"
    expect(await approvedBadges.count()).toBe(0);
  });

  // ─── Approve a review ────────────────────────────────────────────────────

  test("admin can approve a review via the approve button", async ({
    page,
  }) => {
    // Create a dedicated test review so we don't disturb real data
    const reviewId = await createTestReview(
      706, // Mountain-100 Black, 38 — guaranteed to exist in seed data
      3,
      `Admin approve test ${Date.now()}`,
    );

    await page.reload();
    await expect(page.locator(".doodle-card").first()).toBeVisible({
      timeout: 25_000,
    });

    // The newest review (just created) appears at the top of the list.
    // Click the approve button (CheckCircle icon) on the first review card.
    const approveButtons = page.locator(
      'button[title="Approve"], button:has(svg.lucide-circle-check)',
    );
    await approveButtons.first().waitFor({ state: "visible", timeout: 10_000 });
    await approveButtons.first().click();

    // "Approved" badge should appear on that card
    await expect(page.locator("text=Approved").first()).toBeVisible({
      timeout: 10_000,
    });

    // Cleanup
    await deleteTestReview(reviewId);
  });

  // ─── Delete a single review ───────────────────────────────────────────────

  test("admin can delete a review and it is removed from the list", async ({
    page,
  }) => {
    const uniqueComment = `Delete-single-test-${Date.now()}`;
    const reviewId = await createTestReview(706, 2, uniqueComment);

    await page.reload();
    await expect(page.locator(".doodle-card").first()).toBeVisible({
      timeout: 25_000,
    });

    // Verify our test review appears
    const testCard = page
      .locator(".doodle-card")
      .filter({ hasText: uniqueComment });
    await expect(testCard.first()).toBeVisible({ timeout: 15_000 });

    // Click the Delete (trash) button on that card
    const deleteBtn = testCard
      .first()
      .locator('button[title="Delete"], button:has(svg.lucide-trash2)');
    await deleteBtn.click();

    // The card should disappear
    await expect(testCard.first()).toBeHidden({ timeout: 15_000 });

    // Verify it's gone from DB too (DAB returns 200 + empty value[] for missing records)
    const check = await fetch(
      `${testEnv.restApiBaseUrl}/ProductReview/ProductReviewID/${reviewId}`,
    );
    const checkJson = await check.json();
    expect((checkJson.value ?? []).length).toBe(0);
  });

  // ─── Bulk delete ─────────────────────────────────────────────────────────

  test("bulk delete removes selected reviews from DB", async ({ page }) => {
    const ts = Date.now();
    const id1 = await createTestReview(706, 4, `Bulk-delete-A-${ts}`);
    const id2 = await createTestReview(706, 5, `Bulk-delete-B-${ts}`);

    await page.reload();
    await expect(page.locator(".doodle-card").first()).toBeVisible({
      timeout: 25_000,
    });

    // Select checkboxes for both test reviews
    const card1 = page
      .locator(".doodle-card")
      .filter({ hasText: `Bulk-delete-A-${ts}` });
    const card2 = page
      .locator(".doodle-card")
      .filter({ hasText: `Bulk-delete-B-${ts}` });
    await card1.first().getByRole("checkbox").click();
    await card2.first().getByRole("checkbox").click();

    // Click the bulk Delete button
    const bulkDeleteBtn = page.getByRole("button", { name: /delete \(2\)/i });
    await expect(bulkDeleteBtn).toBeVisible({ timeout: 5_000 });
    await bulkDeleteBtn.click();

    // Both cards should disappear
    await expect(card1.first()).toBeHidden({ timeout: 15_000 });
    await expect(card2.first()).toBeHidden({ timeout: 15_000 });

    // Verify gone from DB (DAB returns 200 + empty value[] for missing records)
    const check1 = await fetch(
      `${testEnv.restApiBaseUrl}/ProductReview/ProductReviewID/${id1}`,
    );
    expect(((await check1.json()).value ?? []).length).toBe(0);
    const check2 = await fetch(
      `${testEnv.restApiBaseUrl}/ProductReview/ProductReviewID/${id2}`,
    );
    expect(((await check2.json()).value ?? []).length).toBe(0);
  });

  // ─── Delete review that has a reply ──────────────────────────────────────

  test("deleting a review with an existing reply removes both from DB", async ({
    page,
  }) => {
    const uniqueComment = `Delete-with-reply-test-${Date.now()}`;
    const reviewId = await createTestReview(706, 1, uniqueComment);
    await approveTestReview(reviewId);
    await createTestReply(reviewId, "Thanks for your feedback!");

    await page.reload();
    await expect(page.locator(".doodle-card").first()).toBeVisible({
      timeout: 25_000,
    });

    const testCard = page
      .locator(".doodle-card")
      .filter({ hasText: uniqueComment });
    await expect(testCard.first()).toBeVisible({ timeout: 15_000 });

    const deleteBtn = testCard
      .first()
      .locator('button[title="Delete"], button:has(svg.lucide-trash2)');
    await deleteBtn.click();

    await expect(testCard.first()).toBeHidden({ timeout: 15_000 });

    // Review should be gone (DAB returns 200 + empty value[] for missing records)
    const check = await fetch(
      `${testEnv.restApiBaseUrl}/ProductReview/ProductReviewID/${reviewId}`,
    );
    expect(((await check.json()).value ?? []).length).toBe(0);

    // Reply table should have no records for this reviewId
    const repliesCheck = await fetch(
      `${testEnv.restApiBaseUrl}/ProductReviewReply?$filter=ProductReviewID eq ${reviewId}`,
    );
    const repliesJson = await repliesCheck.json();
    expect((repliesJson.value ?? []).length).toBe(0);
  });

  // ─── Post as Reply ────────────────────────────────────────────────────────

  test("posting AI reply marks review as approved and persists", async ({
    page,
  }) => {
    test.setTimeout(240_000);

    const uniqueComment = `Post-reply-test-${Date.now()}`;
    const reviewId = await createTestReview(706, 5, uniqueComment);

    await page.reload();
    await expect(page.locator(".doodle-card").first()).toBeVisible({
      timeout: 25_000,
    });

    // Find the card and select its checkbox for AI analysis
    const testCard = page
      .locator(".doodle-card")
      .filter({ hasText: uniqueComment });
    await expect(testCard.first()).toBeVisible({ timeout: 15_000 });
    await testCard.first().getByRole("checkbox").click();

    // Run AI analysis on this single review
    const analyzeBtn = page.getByRole("button", {
      name: /run ai analysis \(1\)/i,
    });
    await expect(analyzeBtn).toBeEnabled({ timeout: 5_000 });
    await analyzeBtn.click();

    // Wait for the "Post as Reply" button to appear (analysis complete)
    const postReplyBtn = testCard
      .first()
      .getByRole("button", { name: /post as reply/i });
    await expect(postReplyBtn).toBeVisible({ timeout: 200_000 });
    await postReplyBtn.click();

    // The "Approved" badge should now appear on this card
    await expect(testCard.first().locator("text=Approved")).toBeVisible({
      timeout: 15_000,
    });

    // Verify persisted in DB
    const check = await fetch(
      `${testEnv.restApiBaseUrl}/ProductReview/ProductReviewID/${reviewId}`,
    );
    const json = await check.json();
    expect((json.value?.[0] ?? json).IsModerated).toBe(true);

    // Cleanup
    await deleteTestReview(reviewId);
  });
});
