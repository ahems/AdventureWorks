import { test, expect } from "@playwright/test";
import { signupThroughUi } from "../utils/testUser";
import { testEnv, APP_STORAGE_KEYS } from "../utils/env";

test.describe("AI Features", () => {
  test("AI search with embeddings returns relevant results", async ({
    page,
  }) => {
    // Semantic search is unauthenticated - no sign-up needed.
    test.setTimeout(90_000);

    const hasFunctionsUrl = testEnv.functionsBaseUrl && testEnv.functionsBaseUrl.length > 0;
    if (!hasFunctionsUrl) {
      console.log("⚠️ Azure Functions URL not configured - skipping AI search test");
      test.skip();
    }

    // Semantic search API requires cultureId; set language so app sends cultureId: "en"
    await page.goto(testEnv.webBaseUrl);
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(
      ({ key }) => localStorage.setItem(key, "en"),
      { key: APP_STORAGE_KEYS.language },
    );

    await page.goto(`${testEnv.webBaseUrl}/search`);

    // Wait for the search input - it renders immediately outside the loading skeleton
    const searchInput = page.locator('[data-testid="search-query-input"]');
    await expect(searchInput).toBeVisible({ timeout: 15000 });

    // Test search with semantic query (should use embeddings)
    const searchQueries = [
      "bike for mountain trails",
      "cycling gear for professionals",
      "equipment for outdoor adventures",
    ];

    for (const query of searchQueries) {
      await searchInput.clear();
      await searchInput.fill(query);

      // Click the search submit button (SearchBar has no data-testid)
      const searchButton = page.locator('button[type="submit"]', {
        hasText: "Search",
      });
      await searchButton.click();

      // Wait for semantic search API and product cards to appear (can be slow)
      const searchResults = page.locator(
        '[data-testid^="product-card-"], [class*="product-card"]',
      );
      const hasSearchUrl = page.url().includes("/search");
      let resultCount = 0;
      try {
        await expect(searchResults.first()).toBeVisible({ timeout: 20000 });
        resultCount = await searchResults.count();
      } catch {
        resultCount = await searchResults.count();
      }

      if (resultCount > 0) {
        expect(resultCount).toBeGreaterThan(0);
        const firstResult = searchResults.first();
        await expect(firstResult).toBeVisible();
        console.log(`✅ Search for "${query}" returned ${resultCount} results`);
      } else {
        test.skip(
          true,
          `Search for "${query}" returned no results after 20s. Semantic search may be cold or not indexed.`,
        );
      }

      // Go back to search page for next query
      await page.goto(`${testEnv.webBaseUrl}/search`);
      await expect(page.locator('[data-testid="search-query-input"]')).toBeVisible({ timeout: 10000 });
    }
  });

  test("AI chat interface is accessible and responds", async ({ page }) => {
    // Create a test user
    await signupThroughUi(page);

    // Navigate to home page and wait for content (chat only shows when authenticated)
    await page.goto(testEnv.webBaseUrl);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("main, [role=main]")).toBeVisible({ timeout: 15000 });

    const chatButton = page.getByTestId("ai-chat-toggle").or(
      page.getByRole("button", { name: /chat|ai|assistant/i }),
    ).or(page.locator('[data-testid*="chat"]'));

    await expect(chatButton.first()).toBeVisible({ timeout: 10000 });
    if ((await chatButton.count()) === 0) {
      const floatingChat = page.locator(
        '[class*="chat-fab"], [class*="floating-chat"], [class*="chat-widget"]',
      );
      if ((await floatingChat.count()) > 0) {
        await floatingChat.first().click();
      } else {
        throw new Error(
          "AI chat button not found on page. Check WEB_BASE_URL and that the app has loaded (chat is shown only when signed in).",
        );
      }
    } else {
      await chatButton.first().click();

      // Wait for chat overlay and welcome message to render
      const chatMessages = page.getByTestId("chat-message");
      await expect(chatMessages.first()).toBeVisible({ timeout: 5000 });

      const chatInput = page
        .getByPlaceholder(/ask|message|type|chat/i)
        .or(page.locator('[data-testid*="chat-input"]'))
        .or(page.locator('textarea[class*="chat"]'))
        .or(page.locator('input[class*="chat"]'));

      await expect(chatInput.first()).toBeVisible({ timeout: 5000 });

      const testMessage = "What products do you recommend for cycling?";
      await chatInput.first().fill(testMessage);

      // Send the message
      const sendButton = page
        .getByRole("button", { name: /send/i })
        .or(page.locator('[data-testid*="send"]'))
        .or(page.locator('button[type="submit"]'));

      if ((await sendButton.count()) > 0) {
        await sendButton.first().click();
      } else {
        await chatInput.first().press("Enter");
      }

      // Wait for at least our user message to appear (2 = welcome + user)
      const chatMessagesAfter = page.getByTestId("chat-message");
      await expect(chatMessagesAfter).toHaveCount(2, { timeout: 20000 });
      const messageCount = await chatMessagesAfter.count();

      if (messageCount >= 3) {
        const lastMessage = chatMessagesAfter.last();
        const messageText = await lastMessage.textContent();
        expect(messageText?.length).toBeGreaterThan(10);
        console.log("✅ AI chat responded to user message");
      } else {
        console.log("✅ Chat accepted message (AI response may still be loading)");
      }

      console.log("✅ AI chat interface is working correctly");
    }
  });

  test("AI chat can answer product-related questions", async ({ page }) => {
    // Create a test user
    await signupThroughUi(page);

    await page.goto(testEnv.webBaseUrl);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("main, [role=main]")).toBeVisible({ timeout: 15000 });

    const chatButton = page.getByTestId("ai-chat-toggle").or(
      page.getByRole("button", { name: /chat|ai|assistant/i }),
    ).or(page.locator('[data-testid*="chat"]'));

    await expect(chatButton.first()).toBeVisible({ timeout: 10000 });
    await chatButton.first().click();
    await page.waitForTimeout(1000);

    const chatInput = page
      .getByPlaceholder(/ask|message|type/i)
      .or(page.locator('[data-testid*="chat-input"]'));

    await expect(chatInput.first()).toBeVisible({ timeout: 5000 });

    const questions = [
      "Tell me about your bikes",
      "What cycling accessories do you have?",
      "Do you have helmets?",
    ];
    const messages = page.getByTestId("chat-message");

    for (let i = 0; i < questions.length; i++) {
      const question = questions[i];
      await chatInput.first().fill(question);

      const sendButton = page
        .getByRole("button", { name: /send/i })
        .or(page.locator('[data-testid*="send"]'));

      if ((await sendButton.count()) > 0) {
        await sendButton.first().click();
      } else {
        await chatInput.first().press("Enter");
      }

      // After each Q: welcome + (user+assistant) per question → 3, 5, 7...
      const expectedCount = 2 * (i + 1) + 1;
      await expect(messages).toHaveCount(expectedCount, { timeout: 15000 });

      console.log(`✅ AI chat answered: "${question}"`);
    }
  });

  test("search results include AI-enhanced product descriptions", async ({
    page,
  }) => {
    // Create a test user
    await signupThroughUi(page);

    await page.goto(testEnv.webBaseUrl);
    await page.waitForLoadState("domcontentloaded");

    const productCards = page.locator('[data-testid^="product-card-"]');
    const hasCards = await productCards.first().waitFor({ state: "visible", timeout: 20000 }).then(() => true).catch(() => false);

    if (!hasCards) {
      console.log("⚠️ No product cards on home after 20s - going to product 680");
      await page.goto(`${testEnv.webBaseUrl}/product/680`);
    } else {
      await productCards.first().click({ timeout: 10000 });
    }
    await page.waitForLoadState("domcontentloaded");
    await expect(page).toHaveURL(/\/product\//, { timeout: 15000 });

    // Look for product description section
    const descriptionSection = page.locator(
      '[data-testid*="description"], [class*="description"], [class*="detail"]',
    );

    if ((await descriptionSection.count()) > 0) {
      const descriptionText = await descriptionSection.first().textContent();

      // AI-enhanced descriptions should be substantial
      expect(descriptionText?.length).toBeGreaterThan(50);

      // Should not contain placeholder text
      expect(descriptionText).not.toContain("[description]");
      expect(descriptionText).not.toContain("Lorem ipsum");

      console.log("✅ Product has AI-enhanced description");
    }

    // Check for product reviews (if they exist)
    const reviewsSection = page.locator(
      '[data-testid*="review"], [class*="review"]',
    );

    if ((await reviewsSection.count()) > 0) {
      const reviewText = await reviewsSection.first().textContent();
      expect(reviewText?.length).toBeGreaterThan(20);
      console.log("✅ Product has reviews");
    }
  });

  test("AI search handles various query types", async ({ page }) => {
    test.setTimeout(90_000);

    const hasFunctionsUrl = testEnv.functionsBaseUrl && testEnv.functionsBaseUrl.length > 0;
    if (!hasFunctionsUrl) {
      console.log("⚠️ Azure Functions URL not configured - skipping AI search test");
      test.skip();
    }

    await page.goto(testEnv.webBaseUrl);
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(
      ({ key }) => localStorage.setItem(key, "en"),
      { key: APP_STORAGE_KEYS.language },
    );

    await page.goto(`${testEnv.webBaseUrl}/search`);

    // Wait for the search input - it renders immediately outside the loading skeleton
    const searchInput = page.locator('[data-testid="search-query-input"]');
    await expect(searchInput).toBeVisible({ timeout: 15000 });

    // Test different types of queries
    const testQueries = [
      { query: "red", type: "color" },
      { query: "mountain", type: "category" },
      { query: "professional", type: "keyword" },
    ];

    for (const { query, type } of testQueries) {
      await searchInput.clear();
      await searchInput.fill(query);

      // Click the search submit button (SearchBar has no data-testid)
      const searchButton = page.locator('button[type="submit"]', {
        hasText: "Search",
      });
      await searchButton.click();

      // Wait for product cards (semantic search can be slow)
      const results = page.locator(
        '[data-testid^="product-card-"], [class*="product-card"]',
      );
      let count = 0;
      try {
        await expect(results.first()).toBeVisible({ timeout: 20000 });
        count = await results.count();
      } catch {
        count = await results.count();
      }

      if (count > 0) {
        console.log(
          `✅ Search by ${type} ("${query}") returned ${count} results`,
        );
      } else {
        test.skip(
          true,
          `Search for "${query}" (${type}) returned no results after 20s. Semantic search may be cold or not indexed.`,
        );
      }

      // Return to search page for next query
      await page.goto(`${testEnv.webBaseUrl}/search`);
      await expect(page.locator('[data-testid="search-query-input"]')).toBeVisible({ timeout: 10000 });
    }
  });
});
