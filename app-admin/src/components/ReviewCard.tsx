import React from 'react';
import { Star, ThumbsUp } from 'lucide-react';
import { Review } from '@/types/review';
import { useAuth } from '@/context/AuthContext';

interface ReviewCardProps {
  review: Review;
  onMarkUseful?: (reviewId: string) => void;
  isMarkedByUser?: boolean;
}

const ReviewCard: React.FC<ReviewCardProps> = ({ review, onMarkUseful, isMarkedByUser }) => {
  const { isAuthenticated } = useAuth();
  
  const formattedDate = new Date(review.createdAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });

  return (
    <div className="doodle-card p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            {/* Star Rating */}
            <div className="flex items-center gap-0.5">
              {[...Array(5)].map((_, i) => (
                <Star
                  key={i}
                  className={`w-4 h-4 ${
                    i < review.rating
                      ? 'text-doodle-accent fill-current'
                      : 'text-doodle-text/20'
                  }`}
                />
              ))}
            </div>
            <span className="font-doodle text-sm font-bold text-doodle-text">
              {review.userName}
            </span>
          </div>
          <h4 className="font-doodle font-bold text-doodle-text">
            {review.title}
          </h4>
        </div>
        <span className="font-doodle text-xs text-doodle-text/50 whitespace-nowrap">
          {formattedDate}
        </span>
      </div>

      {/* Comment */}
      <p className="font-doodle text-doodle-text/80 leading-relaxed">
        {review.comment}
      </p>

      {/* Footer */}
      <div className="flex items-center justify-between pt-2 border-t border-dashed border-doodle-text/20">
        <div className="flex items-center gap-1 text-doodle-text/50">
          <ThumbsUp className="w-3 h-3" />
          <span className="font-doodle text-xs">
            {review.helpful > 0 
              ? `${review.helpful} ${review.helpful === 1 ? 'person' : 'people'} found this helpful`
              : 'Be the first to find this helpful'
            }
          </span>
        </div>
        
        {isAuthenticated && onMarkUseful && (
          <button
            onClick={() => onMarkUseful(review.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 font-doodle text-xs border-2 transition-all ${
              isMarkedByUser
                ? 'border-doodle-accent bg-doodle-accent text-white'
                : 'border-doodle-text/30 hover:border-doodle-accent hover:text-doodle-accent'
            }`}
          >
            <ThumbsUp className={`w-3 h-3 ${isMarkedByUser ? 'fill-current' : ''}`} />
            {isMarkedByUser ? 'Marked Helpful' : 'Mark as Helpful'}
          </button>
        )}
      </div>
    </div>
  );
};

export default ReviewCard;
