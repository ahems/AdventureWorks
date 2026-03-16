import { useQuery } from "@tanstack/react-query";
import { graphqlClient } from "@/lib/graphql-client";
import { gql } from "graphql-request";

// ProductReview from AdventureWorks DB:
// ProductReviewID, ProductID, ReviewerName, ReviewDate, EmailAddress, Rating, Comments, HelpfulVotes, UserID
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
      }
      hasNextPage
      endCursor
    }
  }
`;

interface RawProductReview {
  ProductReviewID: number;
  ProductID: number;
  ReviewerName?: string;
  ReviewDate?: string;
  Rating: number;
  Comments?: string;
  HelpfulVotes?: number;
}

const mapReview = (r: RawProductReview): AdminReview => ({
  id: String(r.ProductReviewID),
  productId: r.ProductID,
  userName: r.ReviewerName ?? "Anonymous",
  rating: r.Rating,
  title: "",
  comment: r.Comments ?? "",
  createdAt: r.ReviewDate ?? "",
  helpful: r.HelpfulVotes ?? 0,
  markedUsefulBy: [],
});

export interface PagedReviews {
  items: AdminReview[];
  hasNextPage: boolean;
  endCursor: string;
}

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
