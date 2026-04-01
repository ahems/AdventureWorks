import { useQuery } from "@tanstack/react-query";
import { graphqlClient } from "@/lib/graphql-client";
import { getRestApiUrl } from "@/lib/utils";
import { gql } from "graphql-request";

// ProductReview from AdventureWorks DB:
// ProductReviewID, ProductID, ReviewerName, ReviewDate, EmailAddress, Rating, Comments, HelpfulVotes, UserID, IsModerated
export interface AdminReview {
  id: string;
  productId: number;
  userName: string;
  rating: number;
  title: string;
  comment: string;
  createdAt: string;
  helpful: number;
  markedUsefulBy: string[];
  isModerated: boolean;
  existingReply?: {
    replyId: number;
    text: string;
    by: string;
    date: string;
  };
}

const GET_PRODUCT_REVIEWS_ADMIN = gql`
  query GetProductReviewsAdmin($after: String) {
    productReviews(first: 100, after: $after, orderBy: { ReviewDate: DESC }) {
      items {
        ProductReviewID
        ProductID
        ReviewerName
        ReviewDate
        Rating
        Comments
        HelpfulVotes
        IsModerated
        productReviewReplies {
          items {
            ProductReviewReplyID
            Reply
            RepliedBy
            ReplyDate
          }
        }
      }
      hasNextPage
      endCursor
    }
  }
`;

interface RawReviewReply {
  ProductReviewReplyID: number;
  Reply: string;
  RepliedBy: string;
  ReplyDate: string;
}

interface RawProductReview {
  ProductReviewID: number;
  ProductID: number;
  ReviewerName?: string;
  ReviewDate?: string;
  Rating: number;
  Comments?: string;
  HelpfulVotes?: number;
  IsModerated?: boolean;
  productReviewReplies?: { items: RawReviewReply[] };
}

const mapReview = (r: RawProductReview): AdminReview => {
  const firstReply = r.productReviewReplies?.items?.[0];
  return {
    id: String(r.ProductReviewID),
    productId: r.ProductID,
    userName: r.ReviewerName ?? "Anonymous",
    rating: r.Rating,
    title: "",
    comment: r.Comments ?? "",
    createdAt: r.ReviewDate ?? "",
    helpful: r.HelpfulVotes ?? 0,
    markedUsefulBy: [],
    isModerated: r.IsModerated ?? false,
    existingReply: firstReply
      ? {
          replyId: firstReply.ProductReviewReplyID,
          text: firstReply.Reply,
          by: firstReply.RepliedBy,
          date: firstReply.ReplyDate,
        }
      : undefined,
  };
};

export interface PagedReviews {
  items: AdminReview[];
  hasNextPage: boolean;
  endCursor: string;
}

export const useReviewTotalCount = () =>
  useQuery<number | null>({
    queryKey: ["admin", "reviews", "totalCount"],
    queryFn: async () => {
      // OData $count=true (DAB REST list endpoint); returns { "@odata.count": N, "value": [] }
      const res = await fetch(
        `${getRestApiUrl()}/ProductReview?$count=true&$top=0`,
      );
      if (!res.ok) return null;
      const json = await res.json();
      const count = json["@odata.count"];
      return typeof count === "number" ? count : null;
    },
    staleTime: 5 * 60 * 1000,
  });

export const useAdminReviews = (after?: string | null) =>
  useQuery<PagedReviews>({
    queryKey: ["admin", "reviews", after ?? null],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        productReviews?: {
          items: RawProductReview[];
          hasNextPage?: boolean;
          endCursor?: string;
        };
      }>(GET_PRODUCT_REVIEWS_ADMIN, { after: after ?? null });
      return {
        items: (data.productReviews?.items ?? []).map(mapReview),
        hasNextPage: data.productReviews?.hasNextPage ?? false,
        endCursor: data.productReviews?.endCursor ?? "",
      };
    },
    staleTime: 2 * 60 * 1000,
  });

const GET_PRODUCT_REVIEWS_BY_PRODUCT = gql`
  query GetProductReviewsByProduct($productId: Int!) {
    productReviews(
      filter: { ProductID: { eq: $productId } }
      orderBy: { ReviewDate: DESC }
    ) {
      items {
        ProductReviewID
        ProductID
        ReviewerName
        ReviewDate
        Rating
        Comments
        HelpfulVotes
        IsModerated
        productReviewReplies {
          items {
            ProductReviewReplyID
            Reply
            RepliedBy
            ReplyDate
          }
        }
      }
      hasNextPage
      endCursor
    }
  }
`;

/** Fetches ALL reviews for a specific product using a server-side filter. */
export const useAdminReviewsByProduct = (productId: number | null) =>
  useQuery<PagedReviews>({
    queryKey: ["admin", "reviews", "byProduct", productId],
    enabled: productId !== null,
    queryFn: async () => {
      const data = await graphqlClient.request<{
        productReviews?: {
          items: RawProductReview[];
          hasNextPage?: boolean;
          endCursor?: string;
        };
      }>(GET_PRODUCT_REVIEWS_BY_PRODUCT, { productId });
      return {
        items: (data.productReviews?.items ?? []).map(mapReview),
        hasNextPage: data.productReviews?.hasNextPage ?? false,
        endCursor: data.productReviews?.endCursor ?? "",
      };
    },
    staleTime: 2 * 60 * 1000,
  });

/** PATCH the review's IsModerated flag to true in the database. */
export const approveReview = async (id: string): Promise<void> => {
  const res = await fetch(
    `${getRestApiUrl()}/ProductReview/ProductReviewID/${id}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ IsModerated: true }),
    },
  );
  if (!res.ok) {
    throw new Error(`approveReview failed: ${res.status}`);
  }
};

/** POST a staff reply for the given review. Returns the new reply record. */
export const submitReply = async (
  reviewId: string,
  replyText: string,
  repliedBy = "AdventureWorks Team",
): Promise<RawReviewReply> => {
  const res = await fetch(`${getRestApiUrl()}/ProductReviewReply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ProductReviewID: parseInt(reviewId, 10),
      Reply: replyText,
      RepliedBy: repliedBy,
    }),
  });
  if (!res.ok) {
    throw new Error(`submitReply failed: ${res.status}`);
  }
  const json = await res.json();
  // DAB REST POST returns { value: [record] }
  return (json.value?.[0] ?? json) as RawReviewReply;
};

/**
 * Delete a review and all its replies from the database.
 * Replies must be deleted first to satisfy the FK constraint.
 */
export const deleteReview = async (id: string): Promise<void> => {
  const restBase = getRestApiUrl();

  // 1. Fetch existing replies by ProductReviewID
  const repliesRes = await fetch(
    `${restBase}/ProductReviewReply?$filter=ProductReviewID eq ${id}`,
  );
  if (repliesRes.ok) {
    const repliesJson = await repliesRes.json();
    const replies: Array<{ ProductReviewReplyID: number }> =
      repliesJson.value ?? [];
    // 2. Delete each reply by PK
    await Promise.all(
      replies.map((r) =>
        fetch(
          `${restBase}/ProductReviewReply/ProductReviewReplyID/${r.ProductReviewReplyID}`,
          { method: "DELETE" },
        ),
      ),
    );
  }

  // 3. Delete the review itself
  const reviewRes = await fetch(
    `${restBase}/ProductReview/ProductReviewID/${id}`,
    { method: "DELETE" },
  );
  if (!reviewRes.ok) {
    throw new Error(`deleteReview failed: ${reviewRes.status}`);
  }
};
