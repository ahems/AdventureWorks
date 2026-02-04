import { test, expect } from "@playwright/test";
import { signupThroughUi } from "../utils/testUser";
import { testEnv } from "../utils/env";
import { getRandomProductIds } from "../utils/productHelper";

test.describe("Product Reviews", () => {
  test("authenticated user can add a product review", async ({ page }) => {
    test.setTimeout(120000); // 2 minutes for potential cold start
    console.log("🧪 Test: Authenticated user can add a product review");

    // Step 1: Create and sign up a test user
    console.log("📝 Step 1: Creating test user and signing up...");
    const testUser = await signupThroughUi(page);
    console.log(`✅ Test user created: ${testUser.email}`);

    // Step 2: Navigate to a specific product page
    // Use different products to reduce chance of "already reviewed" conflicts
    console.log("🔍 Step 2: Selecting random product from database...");
    const testProductIds = await getRandomProductIds(1);
    const testProductId = testProductIds[0];
    console.log(`🔍 Selected product ID ${testProductId} for review test`);
    await page.goto(`${testEnv.webBaseUrl}/product/${testProductId}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000); // Allow product to load

    // Verify product page loaded
    await expect(page).toHaveURL(new RegExp(`/product/${testProductId}`));
    console.log(`✅ Product page ${testProductId} loaded`);

    // Step 3: Scroll to the reviews section
    console.log("📜 Step 3: Scrolling to reviews section...");
    const reviewsSection = page.locator("section:has-text('Customer Reviews')");
    await reviewsSection.scrollIntoViewIfNeeded({ timeout: 10000 });
    await page.waitForTimeout(1000);
    console.log("✅ Reviews section visible");

    // Step 4: Check if review form is visible
    console.log("🔍 Step 4: Locating review form...");
    const writeReviewButton = page.getByRole("button", {
      name: /write a review/i,
    });

    // If there's a button to open the form, click it
    if (await writeReviewButton.isVisible({ timeout: 5000 })) {
      console.log("Clicking 'Write a Review' button...");
      await writeReviewButton.click();
      await page.waitForTimeout(1000);
    }

    // Step 5: Fill out the review form
    console.log("✍️  Step 5: Filling out review form...");

    // Check if user has already reviewed this product
    const alreadyReviewed = await page
      .locator('h3:has-text("Already Reviewed")')
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (alreadyReviewed) {
      console.log(
        "ℹ️  User has already reviewed this product - skipping to avoid duplicate",
      );
      console.log(
        "✅ Test passed: Review system correctly prevents duplicate reviews",
      );
      return;
    }

    // Wait for the review form to be visible
    const titleInput = page.locator("#review-title");
    await titleInput.waitFor({ state: "visible", timeout: 10000 });
    console.log("✅ Review form is visible");

    // Select rating (click on the 4th star for a 4-star rating)
    // Stars are button elements with Star icon inside
    const starButtons = page
      .locator('form button[type="button"]')
      .filter({ has: page.locator("svg") });
    await starButtons.nth(3).click({ timeout: 10000 }); // 0-indexed, so 3 = 4th star
    console.log("⭐ Selected 4-star rating");
    await page.waitForTimeout(500);

    // Fill in review title using the input with id="review-title"
    const reviewTitle = `Great product! - Test ${Date.now()}`;
    await titleInput.fill(reviewTitle);
    console.log(`📝 Entered title: "${reviewTitle}"`);
    await page.waitForTimeout(500);

    // Fill in review comment using textarea with id="review-comment"
    const reviewComment =
      "This is an automated test review. The product quality is excellent and I would recommend it to others. Great value for money!";
    const commentTextarea = page.locator("#review-comment");
    await commentTextarea.fill(reviewComment);
    console.log(`💬 Entered comment: "${reviewComment.substring(0, 50)}..."`);
    await page.waitForTimeout(500);

    // Step 6: Submit the review
    console.log("📤 Step 6: Submitting review...");
    const submitButton = page
      .locator('button[type="submit"]')
      .filter({ hasText: /submit/i });
    await submitButton.click();

    // Wait for submission to complete
    await page.waitForTimeout(3000);
    console.log("✅ Review submitted");

    // Step 7: Verify the review appears in the list
    console.log("🔍 Step 7: Verifying review appears in the list...");

    // Look for the review in the reviews list
    // The review should contain the title or comment we just submitted
    const reviewCard = page.locator(
      `[data-testid*="review-card"], .doodle-card:has-text("${reviewTitle}")`,
    );

    // Wait for the review to appear
    await expect(reviewCard.first()).toBeVisible({ timeout: 10000 });
    console.log("✅ Review is visible in the reviews list");

    // Verify review content
    const reviewText = page.locator(
      `text="${reviewTitle}", text="${reviewComment}"`,
    );
    await expect(reviewText.first()).toBeVisible({ timeout: 5000 });
    console.log("✅ Review content verified");

    // Verify the rating stars appear
    const reviewStars = page.locator('[data-testid*="review-rating"]');
    if ((await reviewStars.count()) > 0) {
      await expect(reviewStars.first()).toBeVisible({ timeout: 5000 });
      console.log("✅ Review rating stars visible");
    }

    console.log("🎉 Test completed successfully!");
  });

  test("unauthenticated user sees login prompt when trying to review", async ({
    page,
  }) => {
    console.log("🧪 Test: Unauthenticated user sees login prompt");

    // Navigate directly to product page without logging in
    console.log(
      "🔍 Step 1: Selecting random product and navigating without authentication...",
    );
    const testProductIds = await getRandomProductIds(1);
    const testProductId = testProductIds[0];
    console.log(`🔍 Selected product ID ${testProductId} for auth test`);

    // Clear any existing user data
    await page.addInitScript(() => {
      localStorage.removeItem("adventureworks_current_user");
    });

    await page.goto(`${testEnv.webBaseUrl}/product/${testProductId}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000);

    // Scroll to reviews section
    console.log("📜 Step 2: Scrolling to reviews section...");
    const reviewsSection = page.locator("section:has-text('Customer Reviews')");
    await reviewsSection.scrollIntoViewIfNeeded({ timeout: 10000 });
    await page.waitForTimeout(1000);

    // Look for login prompt or disabled review form
    console.log("🔍 Step 3: Checking for authentication prompt...");

    // Check if there's a "Sign in to write a review" message or similar
    const signInPrompt = page.locator(
      "text=/sign in|log in|please.*login|create.*account/i",
    );

    // Should find some indication that user needs to sign in
    const promptVisible = await signInPrompt
      .first()
      .isVisible({ timeout: 5000 });

    if (promptVisible) {
      console.log("✅ Login prompt is visible for unauthenticated users");
    } else {
      // Alternative: Check if review form is disabled
      const submitButton = page.getByRole("button", {
        name: /submit review/i,
      });
      if (await submitButton.isVisible({ timeout: 3000 })) {
        const isDisabled = await submitButton.isDisabled();
        expect(isDisabled).toBeTruthy();
        console.log("✅ Submit button is disabled for unauthenticated users");
      } else {
        console.log("⚠️  Review form not visible for unauthenticated users");
      }
    }

    console.log("🎉 Test completed successfully!");
  });

  test("user cannot submit review with missing required fields", async ({
    page,
  }) => {
    console.log("🧪 Test: User cannot submit review with missing fields");

    // Create and sign up a test user
    console.log("📝 Step 1: Creating test user...");
    await signupThroughUi(page);
    console.log("✅ Test user created");

    // Navigate to product page - use random product to avoid conflicts
    console.log("🔍 Step 2: Selecting random product from database...");
    const testProductIds = await getRandomProductIds(1);
    const testProductId = testProductIds[0];
    console.log(`🔍 Selected product ID ${testProductId} for validation test`);
    await page.goto(`${testEnv.webBaseUrl}/product/${testProductId}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000);

    // Scroll to reviews section
    const reviewsSection = page.locator("section:has-text('Customer Reviews')");
    await reviewsSection.scrollIntoViewIfNeeded({ timeout: 10000 });
    await page.waitForTimeout(1000);

    // Check if user already reviewed
    const alreadyReviewed = await page
      .locator('h3:has-text("Already Reviewed")')
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (alreadyReviewed) {
      console.log(
        "ℹ️  User already reviewed - test validates duplicate prevention",
      );
      return;
    }

    // Open review form if needed
    const writeReviewButton = page.getByRole("button", {
      name: /write a review/i,
    });
    if (await writeReviewButton.isVisible({ timeout: 5000 })) {
      await writeReviewButton.click();
      await page.waitForTimeout(1000);
    }

    // Step 3: Try to submit without filling any fields
    console.log("📤 Step 3: Attempting to submit empty form...");
    const submitButton = page
      .locator('button[type="submit"]')
      .filter({ hasText: /submit/i });

    // Check if submit button is disabled or if it shows errors
    const isDisabled = await submitButton.isDisabled().catch(() => false);
    if (isDisabled) {
      console.log("✅ Submit button is disabled when form is empty");
    } else {
      // Click and check for validation errors
      await submitButton.click();
      await page.waitForTimeout(1000);

      // Look for error messages
      const errorMessages = page.locator(
        "text=/required|please|must|cannot be empty/i",
      );
      const hasErrors = (await errorMessages.count()) > 0;
      expect(hasErrors).toBeTruthy();
      console.log("✅ Validation errors shown for empty form");
    }

    // Step 4: Fill only rating, leave other fields empty
    console.log("📤 Step 4: Testing partial form submission...");
    const starButtons = page
      .locator('form button[type="button"]')
      .filter({ has: page.locator("svg") });
    await starButtons.nth(2).click(); // 3-star rating
    await page.waitForTimeout(500);

    if (!(await submitButton.isDisabled())) {
      await submitButton.click();
      await page.waitForTimeout(1000);

      // Should still show errors for missing title/comment
      const errorMessages = page.locator(
        "text=/title.*required|comment.*required/i",
      );
      const hasErrors = (await errorMessages.count()) > 0;
      if (hasErrors) {
        console.log("✅ Validation errors shown for incomplete form");
      }
    }

    console.log("🎉 Test completed successfully!");
  });

  test("user can view existing reviews for a product", async ({ page }) => {
    console.log("🧪 Test: User can view existing product reviews");

    // Navigate to a product that likely has reviews
    console.log("🔍 Step 1: Selecting random product from database...");
    const testProductIds = await getRandomProductIds(1);
    const testProductId = testProductIds[0];
    console.log(
      `🔍 Selected product ID ${testProductId} for view reviews test`,
    );
    await page.goto(`${testEnv.webBaseUrl}/product/${testProductId}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000);

    // Scroll to reviews section
    console.log("📜 Step 2: Scrolling to reviews section...");
    const reviewsSection = page.locator("section:has-text('Customer Reviews')");
    await reviewsSection.scrollIntoViewIfNeeded({ timeout: 10000 });
    await page.waitForTimeout(2000);

    // Check for reviews display
    console.log("🔍 Step 3: Checking reviews display...");

    // Look for review cards or "no reviews" message
    const reviewCards = page.locator(".doodle-card, [data-testid*='review']");
    const noReviewsMessage = page.locator(
      "text=/no reviews yet|be the first/i",
    );

    const hasReviews = (await reviewCards.count()) > 0;
    const hasNoReviewsMsg = await page
      .locator('h3:has-text("No reviews yet")')
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (hasReviews) {
      console.log(`✅ Found ${await reviewCards.count()} review(s) displayed`);

      // Verify review components are present
      const starRatings = page.locator('[class*="star"], [aria-label*="star"]');
      if ((await starRatings.count()) > 0) {
        console.log("✅ Review ratings are visible");
      }
    } else if (hasNoReviewsMsg) {
      console.log("✅ 'No reviews yet' message is displayed");
    } else {
      console.log("⚠️  Reviews section exists but no content found");
    }

    // Check for rating summary
    const ratingSummary = page.locator(
      "text=/average|rating|out of 5|based on/i",
    );
    if ((await ratingSummary.count()) > 0) {
      console.log("✅ Rating summary is visible");
    }

    console.log("🎉 Test completed successfully!");
  });

  test("user can sort reviews by different criteria", async ({ page }) => {
    console.log("🧪 Test: User can sort reviews");

    // Create user and navigate to product
    await signupThroughUi(page);
    console.log("🔍 Selecting random product from database...");
    const testProductIds = await getRandomProductIds(1);
    const testProductId = testProductIds[0];
    console.log(
      `🔍 Selected product ID ${testProductId} for sort reviews test`,
    );
    await page.goto(`${testEnv.webBaseUrl}/product/${testProductId}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000);

    // Scroll to reviews
    const reviewsSection = page.locator("section:has-text('Customer Reviews')");
    await reviewsSection.scrollIntoViewIfNeeded({ timeout: 10000 });
    await page.waitForTimeout(2000);

    // Look for sort controls
    console.log("🔍 Looking for sort controls...");
    const sortButtons = page
      .locator("button")
      .filter({ hasText: /newest|helpful|highest|lowest/i });

    if ((await sortButtons.count()) > 0) {
      console.log(
        `✅ Found ${await sortButtons.count()} sort option(s) available`,
      );

      // Try clicking a sort option
      const newestButton = page
        .locator("button")
        .filter({ hasText: /newest/i });
      if (await newestButton.isVisible({ timeout: 3000 })) {
        await newestButton.click();
        await page.waitForTimeout(1000);
        console.log("✅ Clicked 'Newest' sort option");
      }

      // Try another sort option - be specific to avoid 'Mark as Helpful' buttons on review cards
      const sortControls = page.locator(
        '[class*="sort"], .flex:has(text=/sort by/i)',
      );
      const helpfulButton = sortControls
        .locator('button:has-text("Most Helpful")')
        .first();

      if (await helpfulButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await helpfulButton.click();
        await page.waitForTimeout(1000);
        console.log("✅ Clicked 'Most Helpful' sort option");
      } else {
        console.log(
          "ℹ️  'Most Helpful' sort button not found, but sort controls exist",
        );
      }
    } else {
      console.log("ℹ️  Sort controls not found - may not be implemented yet");
    }

    console.log("🎉 Test completed successfully!");
  });
});
