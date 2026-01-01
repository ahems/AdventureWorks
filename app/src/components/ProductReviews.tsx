import React, { useState, useMemo } from "react";
import { Star, ArrowUpDown } from "lucide-react";
import { useReviews } from "@/hooks/useReviews";
import { useAuth } from "@/context/AuthContext";
import { Review } from "@/types/review";
import ReviewCard from "./ReviewCard";
import ReviewForm from "./ReviewForm";
import { useTranslation } from "react-i18next";

type SortOption = "newest" | "helpful" | "highest" | "lowest";

interface ProductReviewsProps {
  productId: number;
}

const ProductReviews: React.FC<ProductReviewsProps> = ({ productId }) => {
  const {
    reviews,
    isLoading,
    addReview,
    markAsUseful,
    hasUserMarkedUseful,
    hasUserReviewedProduct,
    averageRating,
    reviewCount,
  } = useReviews(productId);
  const { user } = useAuth();
  const { t } = useTranslation("common");
  const [sortBy, setSortBy] = useState<SortOption>("newest");

  const handleSubmitReview = async (review: {
    productId: number;
    userName: string;
    rating: number;
    title: string;
    comment: string;
  }) => {
    try {
      await addReview(review, user?.email, user?.businessEntityId);
    } catch (error) {
      console.error("Failed to submit review:", error);
    }
  };

  const handleMarkUseful = (reviewId: string) => {
    if (user) {
      markAsUseful(reviewId, user.id);
    }
  };

  const sortedReviews = useMemo(() => {
    const sorted = [...reviews];
    switch (sortBy) {
      case "newest":
        return sorted.sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      case "helpful":
        return sorted.sort((a, b) => b.helpful - a.helpful);
      case "highest":
        return sorted.sort((a, b) => b.rating - a.rating);
      case "lowest":
        return sorted.sort((a, b) => a.rating - b.rating);
      default:
        return sorted;
    }
  }, [reviews, sortBy]);

  // Rating distribution
  const ratingDistribution = [5, 4, 3, 2, 1].map((rating) => {
    const count = reviews.filter((r) => r.rating === rating).length;
    const percentage = reviewCount > 0 ? (count / reviewCount) * 100 : 0;
    return { rating, count, percentage };
  });

  const sortOptions: { value: SortOption; label: string }[] = [
    { value: "newest", label: t("productReviews.newest") },
    { value: "helpful", label: t("productReviews.mostHelpful") },
    { value: "highest", label: t("productReviews.highestRating") },
    { value: "lowest", label: t("productReviews.lowestRating") },
  ];

  return (
    <section className="container mx-auto px-4 py-8 md:py-12">
      <h2 className="font-doodle text-2xl md:text-3xl font-bold text-doodle-text mb-6">
        {t("productReviews.customerReviews")}
      </h2>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: Summary & Form */}
        <div className="space-y-6">
          {/* Rating Summary */}
          <div className="doodle-card p-6">
            <div className="flex items-center gap-4 mb-4">
              <span className="font-doodle text-5xl font-bold text-doodle-text">
                {averageRating > 0 ? averageRating.toFixed(1) : "-"}
              </span>
              <div>
                <div className="flex items-center gap-0.5 mb-1">
                  {[...Array(5)].map((_, i) => (
                    <Star
                      key={i}
                      className={`w-5 h-5 ${
                        i < Math.round(averageRating)
                          ? "text-doodle-accent fill-current"
                          : "text-doodle-text/20"
                      }`}
                    />
                  ))}
                </div>
                <span className="font-doodle text-sm text-doodle-text/60">
                  {t("productReviews.basedOn")} {reviewCount}{" "}
                  {reviewCount === 1
                    ? t("productReviews.review")
                    : t("productReviews.reviews")}
                </span>
              </div>
            </div>

            {/* Rating Bars */}
            <div className="space-y-2">
              {ratingDistribution.map(({ rating, count, percentage }) => (
                <div key={rating} className="flex items-center gap-2">
                  <span className="font-doodle text-sm text-doodle-text/70 w-6">
                    {rating}★
                  </span>
                  <div className="flex-1 h-3 bg-doodle-text/10 border border-doodle-text/20">
                    <div
                      className="h-full bg-doodle-accent transition-all"
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                  <span className="font-doodle text-xs text-doodle-text/50 w-8">
                    {count}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Review Form */}
          <ReviewForm
            productId={productId}
            onSubmit={handleSubmitReview}
            hasUserReviewed={
              user
                ? hasUserReviewedProduct(user.businessEntityId, productId)
                : false
            }
          />
        </div>

        {/* Right Column: Reviews List */}
        <div className="lg:col-span-2">
          {isLoading ? (
            <div className="doodle-card p-8 text-center">
              <span className="font-doodle text-doodle-text/60">
                {t("productReviews.loadingReviews")}
              </span>
            </div>
          ) : reviews.length > 0 ? (
            <div className="space-y-4">
              {/* Sort Controls */}
              <div className="flex items-center justify-between mb-2">
                <span className="font-doodle text-sm text-doodle-text/60">
                  {reviewCount}{" "}
                  {reviewCount === 1
                    ? t("productReviews.review")
                    : t("productReviews.reviews")}
                </span>
                <div className="flex items-center gap-2">
                  <ArrowUpDown className="w-4 h-4 text-doodle-text/50" />
                  <span className="font-doodle text-sm text-doodle-text/60">
                    {t("productReviews.sortBy")}
                  </span>
                  <div className="flex gap-1 flex-wrap">
                    {sortOptions.map((option) => (
                      <button
                        key={option.value}
                        onClick={() => setSortBy(option.value)}
                        className={`font-doodle text-xs px-2 py-1 border-2 transition-all ${
                          sortBy === option.value
                            ? "border-doodle-accent bg-doodle-accent text-white"
                            : "border-doodle-text/20 hover:border-doodle-accent hover:text-doodle-accent"
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Reviews */}
              {sortedReviews.map((review) => (
                <ReviewCard
                  key={review.id}
                  review={review}
                  onMarkUseful={handleMarkUseful}
                  isMarkedByUser={
                    user ? hasUserMarkedUseful(review.id, user.id) : false
                  }
                />
              ))}
            </div>
          ) : (
            <div className="doodle-card p-8 text-center">
              <span className="text-4xl mb-2 block">📝</span>
              <h3 className="font-doodle text-lg font-bold text-doodle-text mb-1">
                {t("productReviews.noReviewsYet")}
              </h3>
              <p className="font-doodle text-doodle-text/60">
                {t("productReviews.beFirstToShare")}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};

export default ProductReviews;
