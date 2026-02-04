import React, { useState } from "react";
import { Star } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { Link } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { z } from "zod";
import { useTranslation } from "react-i18next";

interface ReviewFormProps {
  productId: number;
  onSubmit: (review: {
    productId: number;
    userName: string;
    rating: number;
    title: string;
    comment: string;
  }) => Promise<void>;
  hasUserReviewed?: boolean;
}

const ReviewForm: React.FC<ReviewFormProps> = ({
  productId,
  onSubmit,
  hasUserReviewed = false,
}) => {
  const { user, isAuthenticated } = useAuth();
  const { toast } = useToast();
  const { t } = useTranslation("common");

  const reviewSchema = z.object({
    rating: z.number().min(1, t("reviewForm.pleaseSelectRating")).max(5),
    title: z
      .string()
      .trim()
      .min(1, t("reviewForm.titleRequired"))
      .max(100, t("reviewForm.titleMustBeLessThan100Characters")),
    comment: z
      .string()
      .trim()
      .min(10, t("reviewForm.reviewMustBeAtLeast10Characters"))
      .max(500, t("reviewForm.reviewMustBeLessThan500Characters")),
  });
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [title, setTitle] = useState("");
  const [comment, setComment] = useState("");
  const [errors, setErrors] = useState<{
    rating?: string;
    title?: string;
    comment?: string;
  }>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isAuthenticated) {
    return (
      <div className="doodle-card p-6 text-center">
        <span className="text-4xl mb-2 block">✍️</span>
        <h3 className="font-doodle text-lg font-bold text-doodle-text mb-2">
          {t("reviewForm.wantToWriteReview")}
        </h3>
        <p className="font-doodle text-doodle-text/70 mb-4">
          {t("reviewForm.signInToShareThoughts")}
        </p>
        <Link
          to="/auth"
          className="doodle-button doodle-button-primary inline-block"
        >
          {t("reviewForm.signInToReview")}
        </Link>
      </div>
    );
  }

  if (hasUserReviewed) {
    return (
      <div className="doodle-card p-6 text-center">
        <span className="text-4xl mb-2 block">✅</span>
        <h3 className="font-doodle text-lg font-bold text-doodle-text mb-2">
          {t("reviewForm.alreadyReviewed")}
        </h3>
        <p className="font-doodle text-doodle-text/70">
          {t("reviewForm.thankYouForReview")}
        </p>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    const result = reviewSchema.safeParse({ rating, title, comment });

    if (!result.success) {
      const fieldErrors: { rating?: string; title?: string; comment?: string } =
        {};
      result.error.errors.forEach((err) => {
        const field = err.path[0] as "rating" | "title" | "comment";
        fieldErrors[field] = err.message;
      });
      setErrors(fieldErrors);
      return;
    }

    setIsSubmitting(true);

    try {
      await onSubmit({
        productId,
        userName: `${user!.firstName} ${user!.lastName[0]}.`,
        rating: result.data.rating,
        title: result.data.title,
        comment: result.data.comment,
      });

      // Reset form
      setRating(0);
      setTitle("");
      setComment("");

      toast({
        title: t("reviewForm.reviewSubmitted"),
        description: t("reviewForm.thankYouForFeedback"),
      });
    } catch (error) {
      toast({
        title: t("reviewForm.error"),
        description: t("reviewForm.failedToSubmit"),
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="doodle-card p-6">
      <h3 className="font-doodle text-xl font-bold text-doodle-text mb-4">
        {t("reviewForm.writeAReview")}
      </h3>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Rating */}
        <div>
          <label className="font-doodle text-sm text-doodle-text/70 block mb-2">
            {t("reviewForm.yourRating")} *
          </label>
          <div className="flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                onClick={() => setRating(star)}
                onMouseEnter={() => setHoverRating(star)}
                onMouseLeave={() => setHoverRating(0)}
                className="p-1 transition-transform hover:scale-110"
              >
                <Star
                  className={`w-8 h-8 ${
                    star <= (hoverRating || rating)
                      ? "text-doodle-accent fill-current"
                      : "text-doodle-text/20"
                  }`}
                />
              </button>
            ))}
            {rating > 0 && (
              <span className="font-doodle text-sm text-doodle-text/60 ml-2">
                {rating === 1 && t("reviewForm.poor")}
                {rating === 2 && t("reviewForm.fair")}
                {rating === 3 && t("reviewForm.good")}
                {rating === 4 && t("reviewForm.veryGood")}
                {rating === 5 && t("reviewForm.excellent")}
              </span>
            )}
          </div>
          {errors.rating && (
            <p className="font-doodle text-sm text-doodle-accent mt-1">
              {errors.rating}
            </p>
          )}
        </div>

        {/* Title */}
        <div>
          <label
            htmlFor="review-title"
            className="font-doodle text-sm text-doodle-text/70 block mb-2"
          >
            {t("reviewForm.reviewTitle")} *
          </label>
          <input
            id="review-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("reviewForm.summarizeYourExperience")}
            className="w-full doodle-border-light px-4 py-2 font-doodle bg-doodle-bg focus:outline-none focus:border-doodle-accent"
            maxLength={100}
          />
          {errors.title && (
            <p className="font-doodle text-sm text-doodle-accent mt-1">
              {errors.title}
            </p>
          )}
        </div>

        {/* Comment */}
        <div>
          <label
            htmlFor="review-comment"
            className="font-doodle text-sm text-doodle-text/70 block mb-2"
          >
            {t("reviewForm.yourReview")} *
          </label>
          <textarea
            id="review-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t("reviewForm.tellOthersAboutExperience")}
            rows={4}
            className="w-full doodle-border-light px-4 py-2 font-doodle bg-doodle-bg focus:outline-none focus:border-doodle-accent resize-none"
            maxLength={500}
          />
          <div className="flex justify-between items-center mt-1">
            {errors.comment ? (
              <p className="font-doodle text-sm text-doodle-accent">
                {errors.comment}
              </p>
            ) : (
              <span />
            )}
            <span className="font-doodle text-xs text-doodle-text/50">
              {comment.length}/500
            </span>
          </div>
        </div>

        {/* Submit */}
        <button
          type="submit"
          disabled={isSubmitting}
          className="doodle-button doodle-button-primary w-full py-3"
        >
          {isSubmitting
            ? t("reviewForm.submitting")
            : t("reviewForm.submitReview")}
        </button>
      </form>
    </div>
  );
};

export default ReviewForm;
