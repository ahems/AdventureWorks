import { useQuery, useQueryClient } from "@tanstack/react-query";
import { graphqlClient } from "@/lib/graphql-client";
import { getRestApiUrl } from "@/lib/utils";
import { gql } from "graphql-request";
import { Review } from "@/types/review";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RawProductReview {
  ProductReviewID: number;
  ProductID: number;
  ReviewerName?: string;
  ReviewDate?: string;
  EmailAddress?: string;
  Rating: number;
  Comments?: string;
  HelpfulVotes?: number;
}

// ─── Query ────────────────────────────────────────────────────────────────────

const GET_REVIEWS_BY_PRODUCT = gql`
  query GetReviewsByProduct($productId: Int!) {
    productReviews(
      filter: { ProductID: { eq: $productId } }
      orderBy: { ReviewDate: DESC }
    ) {
      items {
        ProductReviewID
        ProductID
        ReviewerName
        ReviewDate
        EmailAddress
        Rating
        Comments
        HelpfulVotes
      }
    }
  }
`;

// ─── Mapper ───────────────────────────────────────────────────────────────────

const mapToReview = (r: RawProductReview): Review => ({
  id: String(r.ProductReviewID),
  productId: r.ProductID,
  userName: r.ReviewerName ?? "Anonymous",
  rating: r.Rating,
  title: "", // DB has no separate title column
  comment: r.Comments ?? "",
  createdAt: r.ReviewDate ?? new Date().toISOString().split("T")[0],
  helpful: r.HelpfulVotes ?? 0,
  markedUsefulBy: [], // DB has no per-user vote tracking
});

// ─── Hook ─────────────────────────────────────────────────────────────────────

export const useReviews = (productId: number) => {
  const queryClient = useQueryClient();

  const { data: reviews = [], isLoading } = useQuery<Review[]>({
    queryKey: ["reviews", "product", productId],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        productReviews?: { items: RawProductReview[] };
      }>(GET_REVIEWS_BY_PRODUCT, { productId });
      return (data.productReviews?.items ?? []).map(mapToReview);
    },
    enabled: !!productId,
    staleTime: 2 * 60 * 1000,
  });

  const addReview = async (
    review: Omit<Review, "id" | "createdAt" | "helpful" | "markedUsefulBy">,
  ): Promise<Review | null> => {
    try {
      const restUrl = getRestApiUrl();
      const body = {
        ProductID: review.productId,
        ReviewerName: review.userName,
        ReviewDate: new Date().toISOString().split("T")[0],
        EmailAddress: "noreply@adventureworks.com",
        Rating: review.rating,
        // DB has no title column — prepend title to comments if provided
        Comments: review.title
          ? `${review.title}\n${review.comment}`
          : review.comment,
      };
      const response = await fetch(`${restUrl}/ProductReview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok)
        throw new Error(`Failed to submit review: ${response.statusText}`);
      const created: { value?: RawProductReview[] } = await response.json();
      const newReview = mapToReview(
        created.value?.[0] ??
          ({ ProductReviewID: Date.now(), ...body } as RawProductReview),
      );
      queryClient.invalidateQueries({
        queryKey: ["reviews", "product", productId],
      });
      return newReview;
    } catch (err) {
      console.error("addReview error:", err);
      return null;
    }
  };

  const markAsUseful = async (
    reviewId: string,
    _userId: string,
  ): Promise<boolean> => {
    try {
      const review = reviews.find((r) => r.id === reviewId);
      if (!review) return false;
      const restUrl = getRestApiUrl();
      const response = await fetch(
        `${restUrl}/ProductReview/ProductReviewID/${reviewId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ HelpfulVotes: review.helpful + 1 }),
        },
      );
      if (!response.ok)
        throw new Error(
          `Failed to update helpful votes: ${response.statusText}`,
        );
      queryClient.invalidateQueries({
        queryKey: ["reviews", "product", productId],
      });
      return true;
    } catch (err) {
      console.error("markAsUseful error:", err);
      return false;
    }
  };

  // No per-user tracking in the DB — always returns false
  const hasUserMarkedUseful = (_reviewId: string, _userId: string): boolean =>
    false;

  const averageRating =
    reviews.length > 0
      ? reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length
      : 0;

  return {
    reviews,
    isLoading,
    addReview,
    markAsUseful,
    hasUserMarkedUseful,
    averageRating,
    reviewCount: reviews.length,
  };
};
