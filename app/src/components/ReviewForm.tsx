import React, { useState } from 'react';
import { Star } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { Link } from 'react-router-dom';
import { useToast } from '@/hooks/use-toast';
import { z } from 'zod';

const reviewSchema = z.object({
  rating: z.number().min(1, 'Please select a rating').max(5),
  title: z.string().trim().min(1, 'Title is required').max(100, 'Title must be less than 100 characters'),
  comment: z.string().trim().min(10, 'Review must be at least 10 characters').max(500, 'Review must be less than 500 characters')
});

interface ReviewFormProps {
  productId: number;
  onSubmit: (review: { productId: number; userName: string; rating: number; title: string; comment: string }) => void;
}

const ReviewForm: React.FC<ReviewFormProps> = ({ productId, onSubmit }) => {
  const { user, isAuthenticated } = useAuth();
  const { toast } = useToast();
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [title, setTitle] = useState('');
  const [comment, setComment] = useState('');
  const [errors, setErrors] = useState<{ rating?: string; title?: string; comment?: string }>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isAuthenticated) {
    return (
      <div className="doodle-card p-6 text-center">
        <span className="text-4xl mb-2 block">✍️</span>
        <h3 className="font-doodle text-lg font-bold text-doodle-text mb-2">
          Want to write a review?
        </h3>
        <p className="font-doodle text-doodle-text/70 mb-4">
          Sign in to share your thoughts about this product.
        </p>
        <Link to="/auth" className="doodle-button doodle-button-primary inline-block">
          Sign In to Review
        </Link>
      </div>
    );
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    const result = reviewSchema.safeParse({ rating, title, comment });
    
    if (!result.success) {
      const fieldErrors: { rating?: string; title?: string; comment?: string } = {};
      result.error.errors.forEach(err => {
        const field = err.path[0] as 'rating' | 'title' | 'comment';
        fieldErrors[field] = err.message;
      });
      setErrors(fieldErrors);
      return;
    }

    setIsSubmitting(true);

    onSubmit({
      productId,
      userName: `${user!.firstName} ${user!.lastName[0]}.`,
      rating: result.data.rating,
      title: result.data.title,
      comment: result.data.comment
    });

    // Reset form
    setRating(0);
    setTitle('');
    setComment('');
    setIsSubmitting(false);

    toast({
      title: "Review submitted!",
      description: "Thanks for sharing your feedback.",
    });
  };

  return (
    <div className="doodle-card p-6">
      <h3 className="font-doodle text-xl font-bold text-doodle-text mb-4">
        Write a Review
      </h3>
      
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Rating */}
        <div>
          <label className="font-doodle text-sm text-doodle-text/70 block mb-2">
            Your Rating *
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
                      ? 'text-doodle-accent fill-current'
                      : 'text-doodle-text/20'
                  }`}
                />
              </button>
            ))}
            {rating > 0 && (
              <span className="font-doodle text-sm text-doodle-text/60 ml-2">
                {rating === 1 && 'Poor'}
                {rating === 2 && 'Fair'}
                {rating === 3 && 'Good'}
                {rating === 4 && 'Very Good'}
                {rating === 5 && 'Excellent'}
              </span>
            )}
          </div>
          {errors.rating && (
            <p className="font-doodle text-sm text-doodle-accent mt-1">{errors.rating}</p>
          )}
        </div>

        {/* Title */}
        <div>
          <label htmlFor="review-title" className="font-doodle text-sm text-doodle-text/70 block mb-2">
            Review Title *
          </label>
          <input
            id="review-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Summarize your experience"
            className="w-full doodle-border-light px-4 py-2 font-doodle bg-doodle-bg focus:outline-none focus:border-doodle-accent"
            maxLength={100}
          />
          {errors.title && (
            <p className="font-doodle text-sm text-doodle-accent mt-1">{errors.title}</p>
          )}
        </div>

        {/* Comment */}
        <div>
          <label htmlFor="review-comment" className="font-doodle text-sm text-doodle-text/70 block mb-2">
            Your Review *
          </label>
          <textarea
            id="review-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Tell others about your experience with this product..."
            rows={4}
            className="w-full doodle-border-light px-4 py-2 font-doodle bg-doodle-bg focus:outline-none focus:border-doodle-accent resize-none"
            maxLength={500}
          />
          <div className="flex justify-between items-center mt-1">
            {errors.comment ? (
              <p className="font-doodle text-sm text-doodle-accent">{errors.comment}</p>
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
          {isSubmitting ? 'Submitting...' : 'Submit Review'}
        </button>
      </form>
    </div>
  );
};

export default ReviewForm;
