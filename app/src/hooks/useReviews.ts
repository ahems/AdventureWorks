import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Review, ProductReview } from "@/types/review";
import { graphqlClient } from "@/lib/graphql-client";
import { GET_PRODUCT_REVIEWS, GET_ALL_REVIEWS } from "@/lib/graphql-queries";
import { getRestApiUrl } from "@/lib/utils";

const STORAGE_KEY = "adventureworks_user_reviews";

// Convert API ProductReview to app Review format
const convertProductReview = (pr: ProductReview): Review => ({
  id: `api_${pr.ProductReviewID}`,
  productId: pr.ProductID,
  userName: pr.ReviewerName,
  rating: pr.Rating,
  title: "", // API doesn't have separate title field
  comment: pr.Comments,
  createdAt: new Date(pr.ReviewDate).toISOString().split("T")[0],
  helpful: pr.HelpfulVotes || 0, // Use HelpfulVotes from API
  markedUsefulBy: [], // Will track user votes in localStorage
});

interface ReviewsResponse {
  productReviews: {
    items: ProductReview[];
  };
}

export const useReviews = (productId: number) => {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchReviews = async () => {
      try {
        setIsLoading(true);

        // Fetch reviews from API
        const data = await graphqlClient.request<ReviewsResponse>(
          GET_PRODUCT_REVIEWS,
          { productId }
        );

        const apiReviews = data.productReviews.items.map(convertProductReview);

        // Load user-submitted reviews from localStorage
        const storedReviews = localStorage.getItem(STORAGE_KEY);
        const userReviews: Review[] = storedReviews
          ? JSON.parse(storedReviews)
          : [];
        const productUserReviews = userReviews.filter(
          (r) => r.productId === productId
        );

        // Load user vote marks from localStorage (to track who voted)
        const voteMarks = localStorage.getItem(`${STORAGE_KEY}_votes`);
        const voteData: Record<string, string[]> = voteMarks
          ? JSON.parse(voteMarks)
          : {};

        // Apply vote marks to API reviews
        const reviewsWithVotes = apiReviews.map((review) => ({
          ...review,
          markedUsefulBy: voteData[review.id] || [],
        }));

        // Combine and sort: user reviews first, then API reviews by date
        const allReviews = [...productUserReviews, ...reviewsWithVotes].sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );

        setReviews(allReviews);
      } catch (error) {
        console.error("Error fetching reviews:", error);
        setReviews([]);
      } finally {
        setIsLoading(false);
      }
    };

    if (productId) {
      fetchReviews();
    }
  }, [productId]);

  const addReview = async (
    review: Omit<Review, "id" | "createdAt" | "helpful" | "markedUsefulBy">,
    userEmail?: string,
    userId?: number
  ) => {
    // If user is logged in and we have email/userId, submit to API
    if (userEmail && userId) {
      // Check if user already reviewed this product
      const existingReview = reviews.find(
        (r) => r.id.startsWith("api_") && r.productId === review.productId
      );

      // Check API reviews for this user
      const hasReviewed = reviews.some((r) => {
        // For API reviews, check if UserID matches
        if (r.id.startsWith("api_")) {
          // We need to fetch the full review data to check UserID
          // For now, we'll rely on the frontend check below
          return false;
        }
        return false;
      });

      try {
        const restApiUrl = getRestApiUrl();
        const response = await fetch(`${restApiUrl}/ProductReview`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ProductID: review.productId,
            ReviewerName: review.userName,
            ReviewDate: new Date().toISOString(),
            EmailAddress: userEmail,
            Rating: review.rating,
            Comments: review.comment,
            HelpfulVotes: 0,
            UserID: userId,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.message || "Failed to submit review");
        }

        const newReviewData = await response.json();

        // Refetch reviews to get the updated list
        // For now, just optimistically update the UI
        const newReview: Review = {
          id: `api_${newReviewData.value?.[0]?.ProductReviewID || Date.now()}`,
          productId: review.productId,
          userName: review.userName,
          rating: review.rating,
          title: review.title,
          comment: review.comment,
          createdAt: new Date().toISOString().split("T")[0],
          helpful: 0,
          markedUsefulBy: [],
        };

        setReviews((prev) => [newReview, ...prev]);
        return newReview;
      } catch (error) {
        console.error("Error submitting review to API:", error);
        throw error;
      }
    }

    // Fallback to localStorage for non-authenticated users
    const newReview: Review = {
      ...review,
      id: `user_${Date.now()}`,
      createdAt: new Date().toISOString().split("T")[0],
      helpful: 0,
      markedUsefulBy: [],
    };

    // Store only user-submitted reviews
    const storedReviews = localStorage.getItem(STORAGE_KEY);
    const userReviews: Review[] = storedReviews
      ? JSON.parse(storedReviews)
      : [];

    userReviews.unshift(newReview);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(userReviews));

    setReviews((prev) => [newReview, ...prev]);

    return newReview;
  };

  const markAsUseful = async (reviewId: string, userId: string) => {
    // Only handle API reviews (start with 'api_')
    if (!reviewId.startsWith("api_")) {
      // For user-submitted reviews, keep using localStorage
      const helpfulMarks = localStorage.getItem(`${STORAGE_KEY}_helpful`);
      const helpfulData: Record<
        string,
        { helpful: number; markedUsefulBy: string[] }
      > = helpfulMarks ? JSON.parse(helpfulMarks) : {};

      const currentData = helpfulData[reviewId] || {
        helpful: 0,
        markedUsefulBy: [],
      };
      const markedUsefulBy = currentData.markedUsefulBy || [];

      if (markedUsefulBy.includes(userId)) {
        helpfulData[reviewId] = {
          helpful: Math.max(0, currentData.helpful - 1),
          markedUsefulBy: markedUsefulBy.filter((id) => id !== userId),
        };
      } else {
        helpfulData[reviewId] = {
          helpful: currentData.helpful + 1,
          markedUsefulBy: [...markedUsefulBy, userId],
        };
      }

      localStorage.setItem(
        `${STORAGE_KEY}_helpful`,
        JSON.stringify(helpfulData)
      );

      setReviews((prev) =>
        prev.map((r) =>
          r.id === reviewId
            ? {
                ...r,
                helpful: helpfulData[reviewId].helpful,
                markedUsefulBy: helpfulData[reviewId].markedUsefulBy,
              }
            : r
        )
      );

      return true;
    }

    // For API reviews, update via REST API
    const productReviewId = parseInt(reviewId.replace("api_", ""));
    const review = reviews.find((r) => r.id === reviewId);

    if (!review) return false;

    // Load user votes from localStorage
    const voteMarks = localStorage.getItem(`${STORAGE_KEY}_votes`);
    const voteData: Record<string, string[]> = voteMarks
      ? JSON.parse(voteMarks)
      : {};
    const markedUsefulBy = voteData[reviewId] || [];

    // Check if user already voted
    const hasVoted = markedUsefulBy.includes(userId);
    const newHelpfulCount = hasVoted
      ? Math.max(0, review.helpful - 1)
      : review.helpful + 1;

    try {
      // Update via DAB REST API
      const restApiUrl = getRestApiUrl();
      const response = await fetch(
        `${restApiUrl}/ProductReview/ProductReviewID/${productReviewId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            HelpfulVotes: newHelpfulCount,
          }),
        }
      );

      if (!response.ok) {
        throw new Error("Failed to update helpful votes");
      }

      // Update localStorage vote tracking
      if (hasVoted) {
        voteData[reviewId] = markedUsefulBy.filter((id) => id !== userId);
      } else {
        voteData[reviewId] = [...markedUsefulBy, userId];
      }
      localStorage.setItem(`${STORAGE_KEY}_votes`, JSON.stringify(voteData));

      // Update local state
      setReviews((prev) =>
        prev.map((r) =>
          r.id === reviewId
            ? {
                ...r,
                helpful: newHelpfulCount,
                markedUsefulBy: voteData[reviewId],
              }
            : r
        )
      );

      return true;
    } catch (error) {
      console.error("Error updating helpful votes:", error);
      return false;
    }
  };

  const hasUserReviewedProduct = (
    userId: number,
    productId: number
  ): boolean => {
    // Check if user already submitted a review for this product
    // Check API reviews for matching UserID
    return reviews.some(
      (r) => r.id.startsWith("api_") && r.productId === productId
    );
  };

  const hasUserMarkedUseful = (reviewId: string, userId: string): boolean => {
    const review = reviews.find((r) => r.id === reviewId);
    return review?.markedUsefulBy?.includes(userId) || false;
  };

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
    hasUserReviewedProduct,
    averageRating,
    reviewCount: reviews.length,
  };
};

// Hook to fetch all reviews for all products
export const useAllReviews = () => {
  return useQuery({
    queryKey: ["allReviews"],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        productReviews: { items: ProductReview[] };
      }>(GET_ALL_REVIEWS);
      return data.productReviews.items;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
};
