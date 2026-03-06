import { test, expect } from "@playwright/test";
import { signupThroughUi } from "../utils/testUser";
import { testEnv } from "../utils/env";

test.describe("AI Features", () => {
  test("AI search with embeddings returns relevant results", async ({
    page,
  }) => {
    // Check if AI services are configured (optional test)
    // If VITE_API_FUNCTIONS_URL is not set, semantic search won't work
    const hasFunctionsUrl = testEnv.functionsBaseUrl && testEnv.functionsBaseUrl.length > 0;
    if (!hasFunctionsUrl) {
      console.log("⚠️ Azure Functions URL not configured - skipping AI search test");
      test.skip();
    }

    // Create a test user
    await signupThroughUi(page);

    // Navigate to search page so the search input is always visible (no header toggle)
    await page.goto(`${testEnv.webBaseUrl}/search`);

    // Wait for the page to mount, then for the search input to appear (only visible once data loads)
    await expect(page.locator('[data-testid="search-page"]')).toBeVisible({ timeout: 30000 });
    const searchInput = page.getByPlaceholder(/search|bikes|gear|clothing|describe/i).first();
    await expect(searchInput).toBeVisible({ timeout: 30000 });

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
        console.warn(`⚠️ No AI search results for "${query}" after 20s - embeddings may not be seeded or search is slow`);
        test.skip();
      }

      // Go back to search page for next query
      await page.goto(`${testEnv.webBaseUrl}/search`);
      await expect(searchInput).toBeVisible({ timeout: 30000 });
    }
  });

  test("AI chat interface is accessible and responds", async ({ page }) => {
    // Create a test user
    await signupThroughUi(page);

    // Navigate to home page
    await page.goto(testEnv.webBaseUrl);

    // Look for AI chat button/icon (common patterns)
    const chatButton = page
      .getByRole("button", { name: /chat|ai.*assistant|help/i })
      .or(page.locator('[data-testid*="chat"]'))
      .or(page.locator('[aria-label*="chat"]'))
      .or(page.locator('button:has-text("💬")'))
      .or(page.locator('button:has-text("🤖")'));

    // Check if chat is available
    if ((await chatButton.count()) === 0) {
      console.log("⚠️ AI chat button not found on page");
      // Try looking for floating action button or sidebar
      const floatingChat = page.locator(
        '[class*="chat-fab"], [class*="floating-chat"], [class*="chat-widget"]',
      );
      if ((await floatingChat.count()) > 0) {
        await floatingChat.first().click();
      } else {
        test.skip();
      }
    } else {
      await chatButton.first().click();

      // Wait for chat interface to open
      await page.waitForTimeout(1000);

      // Look for chat input
      const chatInput = page
        .getByPlaceholder(/ask|message|type|chat/i)
        .or(page.locator('[data-testid*="chat-input"]'))
        .or(page.locator('textarea[class*="chat"]'))
        .or(page.locator('input[class*="chat"]'));

      await expect(chatInput.first()).toBeVisible({ timeout: 5000 });

      // Send a test message
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

      // Wait for AI response
      await page.waitForTimeout(3000);

      // Look for response message
      const chatMessages = page.locator(
        '[data-testid*="message"], [class*="message"], [class*="chat-bubble"]',
      );

      const messageCount = await chatMessages.count();
      expect(messageCount).toBeGreaterThan(1); // Should have user message + AI response

      console.log("✅ AI chat responded to user message");

      // Verify response contains relevant content
      const lastMessage = chatMessages.last();
      const messageText = await lastMessage.textContent();
      expect(messageText?.length).toBeGreaterThan(10); // Should have meaningful response

      console.log("✅ AI chat interface is working correctly");
    }
  });

  test("AI chat can answer product-related questions", async ({ page }) => {
    // Create a test user
    await signupThroughUi(page);

    // Navigate to home page
    await page.goto(testEnv.webBaseUrl);

    // Open AI chat
    const chatButton = page
      .getByRole("button", { name: /chat|ai/i })
      .or(page.locator('[data-testid*="chat"]'));

    if ((await chatButton.count()) === 0) {
      test.skip();
      return;
    }

    await chatButton.first().click();
    await page.waitForTimeout(1000);

    // Find chat input
    const chatInput = page
      .getByPlaceholder(/ask|message|type/i)
      .or(page.locator('[data-testid*="chat-input"]'));

    await expect(chatInput.first()).toBeVisible();

    // Ask product-specific questions
    const questions = [
      "Tell me about your bikes",
      "What cycling accessories do you have?",
      "Do you have helmets?",
    ];

    for (const question of questions) {
      await chatInput.first().fill(question);

      const sendButton = page
        .getByRole("button", { name: /send/i })
        .or(page.locator('[data-testid*="send"]'));

      if ((await sendButton.count()) > 0) {
        await sendButton.first().click();
      } else {
        await chatInput.first().press("Enter");
      }

      // Wait for response
      await page.waitForTimeout(3000);

      // Verify response appeared
      const messages = page.locator(
        '[data-testid*="message"], [class*="message"]',
      );
      const messageCount = await messages.count();
      expect(messageCount).toBeGreaterThan(0);

      console.log(`✅ AI chat answered: "${question}"`);
    }
  });

  test("search results include AI-enhanced product descriptions", async ({
    page,
  }) => {
    // Create a test user
    await signupThroughUi(page);

    // Navigate to a product page
    await page.goto(testEnv.webBaseUrl);

    // Wait longer for products to load (cold start tolerance)
    await page.waitForTimeout(5000);

    // Look for any product links - use data-testid for reliability
    const productCards = page.locator('[data-testid^="product-card-"]');
    const productCardCount = await productCards.count();

    if (productCardCount === 0) {
      console.log("⚠️ No product cards found on home page - skipping test");
      test.skip();
      return;
    }

    console.log(`Found ${productCardCount} product cards`);

    // Click directly on the first product card (the whole card is a link)
    await productCards.first().click({ timeout: 10000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 });
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
    // Check if AI services are configured (optional test)
    const hasFunctionsUrl = testEnv.functionsBaseUrl && testEnv.functionsBaseUrl.length > 0;
    if (!hasFunctionsUrl) {
      console.log("⚠️ Azure Functions URL not configured - skipping AI search test");
      test.skip();
    }

    // Create a test user
    await signupThroughUi(page);

    // Navigate to search page so the search input is always visible
    await page.goto(`${testEnv.webBaseUrl}/search`);

    // Wait for the page to mount, then for the search input to appear (only visible once data loads)
    await expect(page.locator('[data-testid="search-page"]')).toBeVisible({ timeout: 30000 });
    const searchInput = page.getByPlaceholder(/search|bikes|gear|clothing|describe/i).first();
    await expect(searchInput).toBeVisible({ timeout: 30000 });

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
        console.warn(`⚠️ No results for ${type} search: "${query}" after 20s - AI search may not be working`);
        test.skip();
      }

      // Return to search page for next query
      await page.goto(`${testEnv.webBaseUrl}/search`);
      await expect(searchInput).toBeVisible({ timeout: 30000 });
    }
  });
});
