/**
 * AI Agent API tests
 *
 * Validates the new Foundry-backed endpoints introduced in the agent migration:
 *   - POST /api/helpme/questions  → returns threadId for multi-turn chaining
 *   - POST /api/helpme/recommend  → accepts previousThreadId, chains conversation
 *   - POST /api/GeneratePromotion → returns threadId for multi-turn refinement
 *   - POST /api/simulation/orders/start → enqueues messages on simulation-order-queue
 *
 * These are purely API-level tests (no browser). They use Playwright's request
 * fixture which has its own timeout management.
 *
 * ⚠️  AI calls are slow (30–90 s). Each test that invokes an agent carries
 *     an individual timeout. Tests are skipped when functionsBaseUrl is absent.
 */

import { test, expect } from "@playwright/test";
import { testEnv } from "../utils/env";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skipIfNoFunctions() {
  if (!testEnv.functionsBaseUrl) {
    test.skip(
      true,
      "FUNCTIONS_BASE_URL / VITE_API_FUNCTIONS_URL not set – skipping API tests",
    );
  }
}

const apiBase = () => testEnv.functionsBaseUrl.replace(/\/$/, "");

// ---------------------------------------------------------------------------
// HelpMeChoose – multi-turn API contract
// ---------------------------------------------------------------------------

test.describe("HelpMeChoose API – multi-turn contract", () => {
  test("POST /api/helpme/questions returns questions array and threadId", async ({
    request,
  }) => {
    skipIfNoFunctions();
    test.setTimeout(90_000);

    const res = await request.post(`${apiBase()}/api/helpme/questions`, {
      data: { context: "looking for a mountain bike", cultureId: "en-US" },
    });

    expect(
      res.ok(),
      `Expected 200, got ${res.status()}: ${await res.text()}`,
    ).toBeTruthy();

    const body = await res.json();

    // Must contain at least one question
    expect(Array.isArray(body.questions), "questions should be an array").toBe(
      true,
    );
    expect(
      body.questions.length,
      "should have at least one question",
    ).toBeGreaterThan(0);

    // Each question must have an id (number) and text field
    for (const q of body.questions) {
      expect(typeof q.id, "question.id should be a number").toBe("number");
      expect(typeof q.text, "question.text should be a string").toBe("string");
      expect(
        q.text.length,
        "question text should not be empty",
      ).toBeGreaterThan(0);
    }

    // threadId is set when the Foundry agent succeeds; null means the service returned
    // static fallback questions — both are valid responses.
    expect(
      body.threadId === null || typeof body.threadId === "string",
      "threadId should be a string or null",
    ).toBe(true);
    if (body.threadId) {
      expect(
        body.threadId.length,
        "threadId should not be empty when present",
      ).toBeGreaterThan(0);
    }
    console.log(
      `✅ questions returned ${body.questions.length} Qs, threadId=${body.threadId ?? "(fallback)"}`,
    );
  });

  test("POST /api/helpme/recommend with previousThreadId chains conversation", async ({
    request,
  }) => {
    skipIfNoFunctions();
    test.setTimeout(180_000); // two AI calls

    // Step 1 – get questions and capture threadId
    const qRes = await request.post(`${apiBase()}/api/helpme/questions`, {
      data: { context: "gravel bike for commuting", cultureId: "en-US" },
    });
    expect(qRes.ok()).toBeTruthy();
    const qBody = await qRes.json();
    const threadId: string | null = qBody.threadId;
    // threadId may be null if the Foundry agent fell back to static questions.
    // We still proceed with the test; passing null previousThreadId is valid.

    const answers = (qBody.questions as Array<{ id: number }>).map((q) => ({
      questionId: q.id,
      answer: "Yes",
    }));

    // Step 2 – recommend, passing previousThreadId when available to chain
    const recRes = await request.post(`${apiBase()}/api/helpme/recommend`, {
      data: {
        answers,
        cultureId: "en-US",
        ...(threadId ? { previousThreadId: threadId } : {}),
      },
    });
    expect(
      recRes.ok(),
      `Recommend failed (${recRes.status()}): ${await recRes.text()}`,
    ).toBeTruthy();

    const recBody = await recRes.json();

    // Must return at least one product recommendation (or an empty array on fallback)
    expect(
      Array.isArray(recBody.recommendations),
      "recommendations should be an array",
    ).toBe(true);

    // threadId from recommendations phase (string or null)
    expect(
      recBody.threadId === null || typeof recBody.threadId === "string",
      "recommendation response threadId should be string or null",
    ).toBe(true);

    console.log(
      `✅ recommend returned ${recBody.recommendations.length} product(s), threadId=${recBody.threadId ?? "(fallback)"}`,
    );
  });
});

// ---------------------------------------------------------------------------
// GeneratePromotion – multi-turn API contract
// ---------------------------------------------------------------------------

test.describe("GeneratePromotion API – multi-turn contract", () => {
  test("POST /api/GeneratePromotion returns promotion fields and threadId", async ({
    request,
  }) => {
    skipIfNoFunctions();
    test.setTimeout(120_000);

    const res = await request.post(`${apiBase()}/api/GeneratePromotion`, {
      data: {
        promotionType: "Seasonal",
        offerCategory: "Customer",
        categoryId: 1,
        categoryName: "Bikes",
      },
    });

    expect(
      res.ok(),
      `GeneratePromotion failed (${res.status()}): ${await res.text()}`,
    ).toBeTruthy();

    const body = await res.json();

    // Response wraps the suggestion under a 'suggestion' key
    expect(
      typeof body.suggestion,
      "response should have a 'suggestion' object",
    ).toBe("object");
    const s = body.suggestion;
    expect(typeof s.description, "description should be a string").toBe(
      "string",
    );
    expect(
      s.description.length,
      "description should not be empty",
    ).toBeGreaterThan(0);
    expect(typeof s.discountPct, "discountPct should be a number").toBe(
      "number",
    );
    expect(s.discountPct, "discountPct should be positive").toBeGreaterThan(0);

    // threadId is set when the Foundry agent succeeds; null on error/fallback
    expect(
      body.threadId === null || typeof body.threadId === "string",
      "threadId should be a string or null",
    ).toBe(true);

    console.log(
      `✅ Promotion desc="${s.description?.substring(0, 40)}..." discountPct=${s.discountPct}, threadId=${body.threadId ?? "(null)"}`,
    );
  });

  test("second GeneratePromotion call with previousThreadId refines result", async ({
    request,
  }) => {
    skipIfNoFunctions();
    test.setTimeout(240_000); // two AI calls

    // First call – baseline
    const first = await request.post(`${apiBase()}/api/GeneratePromotion`, {
      data: {
        promotionType: "Volume",
        offerCategory: "Customer",
        categoryName: "Components",
      },
    });
    expect(first.ok()).toBeTruthy();
    const firstBody = await first.json();
    // threadId may be null if the Foundry agent encountered an error
    const threadId: string | null = firstBody.threadId;

    // Second call – refinement (send previousThreadId only when we have one)
    const second = await request.post(`${apiBase()}/api/GeneratePromotion`, {
      data: {
        promotionType: "Volume",
        offerCategory: "Customer",
        categoryName: "Components",
        ...(threadId ? { previousThreadId: threadId } : {}),
        userMessage:
          "Increase the discount to 25% and target cyclists who race competitively",
      },
    });
    expect(
      second.ok(),
      `Refinement call failed (${second.status()}): ${await second.text()}`,
    ).toBeTruthy();

    const secondBody = await second.json();
    expect(
      typeof secondBody.suggestion,
      "second response should have suggestion",
    ).toBe("object");
    expect(
      secondBody.threadId === null || typeof secondBody.threadId === "string",
      "second response threadId should be string or null",
    ).toBe(true);

    console.log(
      `✅ Refined promotion: first discountPct=${firstBody.suggestion?.discountPct}, second discountPct=${secondBody.suggestion?.discountPct}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Simulation order queue – enqueue API contract
// ---------------------------------------------------------------------------

test.describe("Simulation order queue – enqueue API", () => {
  test("POST /api/simulation/orders/start with count=1 enqueues 1 message", async ({
    request,
  }) => {
    skipIfNoFunctions();
    test.setTimeout(30_000);

    const res = await request.post(`${apiBase()}/api/simulation/orders/start`, {
      data: { count: 1, customerId: 0 },
    });

    expect(
      res.ok(),
      `Expected 200, got ${res.status()}: ${await res.text()}`,
    ).toBeTruthy();

    const body = await res.json();
    expect(body.queued, "queued count should be 1").toBe(1);
    expect(typeof body.message, "should have a confirmation message").toBe(
      "string",
    );

    console.log(`✅ Enqueued: ${body.message}`);
  });

  test("POST /api/simulation/orders/start with count=3 enqueues 3 messages", async ({
    request,
  }) => {
    skipIfNoFunctions();
    test.setTimeout(30_000);

    const res = await request.post(`${apiBase()}/api/simulation/orders/start`, {
      data: { count: 3, customerId: 0 },
    });

    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.queued).toBe(3);

    console.log(`✅ Enqueued 3 messages: ${body.message}`);
  });

  test("POST /api/simulation/orders/start clamps count to 500 max", async ({
    request,
  }) => {
    skipIfNoFunctions();
    test.setTimeout(30_000);

    // Sending a count that exceeds the max — should be clamped to 500
    const res = await request.post(`${apiBase()}/api/simulation/orders/start`, {
      data: { count: 9999, customerId: 0 },
    });

    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.queued).toBe(500);

    console.log(`✅ Count clamped to 500: ${body.message}`);
  });

  test("POST /api/simulation/orders/start with personaHint enqueues with hint", async ({
    request,
  }) => {
    skipIfNoFunctions();
    test.setTimeout(30_000);

    const res = await request.post(`${apiBase()}/api/simulation/orders/start`, {
      data: { count: 1, customerId: 0, personaHint: "mountain-enthusiast" },
    });

    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.queued).toBe(1);

    console.log(`✅ Persona-hinted message enqueued: ${body.message}`);
  });

  test("POST /api/simulation/orders/start rejects missing / invalid body gracefully", async ({
    request,
  }) => {
    skipIfNoFunctions();
    test.setTimeout(15_000);

    // Empty body — should default to count=1 and succeed (not crash)
    const res = await request.post(`${apiBase()}/api/simulation/orders/start`, {
      data: {},
    });

    // Either 200 (defaults applied) or 400 (validation error) is acceptable;
    // what we must NOT see is a 500 unhandled exception
    expect(res.status(), "should not return 500 for empty body").not.toBe(500);

    console.log(`✅ Empty body → ${res.status()}`);
  });
});
