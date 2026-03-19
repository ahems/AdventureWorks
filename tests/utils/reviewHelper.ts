import { Page } from "@playwright/test";
import { testEnv } from "./env";

/**
 * Creates a test review directly via the DAB REST API.
 * Returns the new ProductReviewID.
 */
export async function createTestReview(
  productId: number,
  rating: number,
  comment: string,
  reviewerName = "Test Reviewer",
  emailAddress = "test.reviewer@example.com",
): Promise<number> {
  const res = await fetch(`${testEnv.restApiBaseUrl}/ProductReview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ProductID: productId,
      ReviewerName: reviewerName,
      EmailAddress: emailAddress,
      Rating: rating,
      Comments: comment,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `createTestReview failed: ${res.status} ${await res.text()}`,
    );
  }
  const json = await res.json();
  const record = json.value?.[0] ?? json;
  return record.ProductReviewID as number;
}

/**
 * Creates a staff reply for a review directly via the DAB REST API.
 * Returns the new ProductReviewReplyID.
 */
export async function createTestReply(
  reviewId: number,
  replyText: string,
  repliedBy = "AdventureWorks Team",
): Promise<number> {
  const res = await fetch(`${testEnv.restApiBaseUrl}/ProductReviewReply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ProductReviewID: reviewId,
      Reply: replyText,
      RepliedBy: repliedBy,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `createTestReply failed: ${res.status} ${await res.text()}`,
    );
  }
  const json = await res.json();
  const record = json.value?.[0] ?? json;
  return record.ProductReviewReplyID as number;
}

/**
 * Approves a review by PATCHing IsModerated = true via DAB REST.
 */
export async function approveTestReview(reviewId: number): Promise<void> {
  const res = await fetch(
    `${testEnv.restApiBaseUrl}/ProductReview/ProductReviewID/${reviewId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ IsModerated: true }),
    },
  );
  if (!res.ok) {
    throw new Error(`approveTestReview failed: ${res.status}`);
  }
}

/**
 * Deletes a review and all its replies via the DAB REST API.
 * Replies are removed first to satisfy the FK constraint.
 */
export async function deleteTestReview(reviewId: number): Promise<void> {
  const restBase = testEnv.restApiBaseUrl;

  // Fetch replies
  const repliesRes = await fetch(
    `${restBase}/ProductReviewReply?$filter=ProductReviewID eq ${reviewId}`,
  );
  if (repliesRes.ok) {
    const repliesJson = await repliesRes.json();
    const replies: Array<{ ProductReviewReplyID: number }> =
      repliesJson.value ?? [];
    await Promise.all(
      replies.map((r) =>
        fetch(
          `${restBase}/ProductReviewReply/ProductReviewReplyID/${r.ProductReviewReplyID}`,
          { method: "DELETE" },
        ),
      ),
    );
  }

  await fetch(`${restBase}/ProductReview/ProductReviewID/${reviewId}`, {
    method: "DELETE",
  });
}

/**
 * Waits for a review card containing the given text to appear in the page.
 */
export async function waitForReviewInPage(
  page: Page,
  reviewText: string,
  timeoutMs = 15_000,
): Promise<void> {
  await page
    .locator('[data-testid="review-card"]')
    .filter({ hasText: reviewText })
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs });
}
