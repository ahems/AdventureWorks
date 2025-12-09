import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Review, ProductReview } from '@/types/review';
import { graphqlClient } from '@/lib/graphql-client';
import { GET_PRODUCT_REVIEWS, GET_ALL_REVIEWS } from '@/lib/graphql-queries';

const STORAGE_KEY = 'adventureworks_user_reviews';

// Convert API ProductReview to app Review format
const convertProductReview = (pr: ProductReview): Review => ({
  id: `api_${pr.ProductReviewID}`,
  productId: pr.ProductID,
  userName: pr.ReviewerName,
  rating: pr.Rating,
  title: '', // API doesn't have separate title field
  comment: pr.Comments,
  createdAt: new Date(pr.ReviewDate).toISOString().split('T')[0],
  helpful: 0, // Will be tracked in localStorage
  markedUsefulBy: []
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
        const userReviews: Review[] = storedReviews ? JSON.parse(storedReviews) : [];
        const productUserReviews = userReviews.filter(r => r.productId === productId);
        
        // Load helpful marks from localStorage
        const helpfulMarks = localStorage.getItem(`${STORAGE_KEY}_helpful`);
        const helpfulData: Record<string, { helpful: number; markedUsefulBy: string[] }> = 
          helpfulMarks ? JSON.parse(helpfulMarks) : {};
        
        // Apply helpful marks to API reviews
        const reviewsWithHelpful = apiReviews.map(review => ({
          ...review,
          helpful: helpfulData[review.id]?.helpful || 0,
          markedUsefulBy: helpfulData[review.id]?.markedUsefulBy || []
        }));
        
        // Combine and sort: user reviews first, then API reviews by date
        const allReviews = [...productUserReviews, ...reviewsWithHelpful]
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        
        setReviews(allReviews);
      } catch (error) {
        console.error('Error fetching reviews:', error);
        setReviews([]);
      } finally {
        setIsLoading(false);
      }
    };
    
    if (productId) {
      fetchReviews();
    }
  }, [productId]);

  const addReview = (review: Omit<Review, 'id' | 'createdAt' | 'helpful' | 'markedUsefulBy'>) => {
    const newReview: Review = {
      ...review,
      id: `user_${Date.now()}`,
      createdAt: new Date().toISOString().split('T')[0],
      helpful: 0,
      markedUsefulBy: []
    };

    // Store only user-submitted reviews
    const storedReviews = localStorage.getItem(STORAGE_KEY);
    const userReviews: Review[] = storedReviews ? JSON.parse(storedReviews) : [];
    
    userReviews.unshift(newReview);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(userReviews));
    
    setReviews(prev => [newReview, ...prev]);
    
    return newReview;
  };

  const markAsUseful = (reviewId: string, userId: string) => {
    // Load helpful marks
    const helpfulMarks = localStorage.getItem(`${STORAGE_KEY}_helpful`);
    const helpfulData: Record<string, { helpful: number; markedUsefulBy: string[] }> = 
      helpfulMarks ? JSON.parse(helpfulMarks) : {};
    
    const currentData = helpfulData[reviewId] || { helpful: 0, markedUsefulBy: [] };
    const markedUsefulBy = currentData.markedUsefulBy || [];
    
    // Check if user already marked this review
    if (markedUsefulBy.includes(userId)) {
      // Remove the mark
      helpfulData[reviewId] = {
        helpful: Math.max(0, currentData.helpful - 1),
        markedUsefulBy: markedUsefulBy.filter(id => id !== userId)
      };
    } else {
      // Add the mark
      helpfulData[reviewId] = {
        helpful: currentData.helpful + 1,
        markedUsefulBy: [...markedUsefulBy, userId]
      };
    }
    
    localStorage.setItem(`${STORAGE_KEY}_helpful`, JSON.stringify(helpfulData));
    
    // Update local state
    setReviews(prev => prev.map(r => 
      r.id === reviewId ? {
        ...r,
        helpful: helpfulData[reviewId].helpful,
        markedUsefulBy: helpfulData[reviewId].markedUsefulBy
      } : r
    ));
    
    return true;
  };

  const hasUserMarkedUseful = (reviewId: string, userId: string): boolean => {
    const review = reviews.find(r => r.id === reviewId);
    return review?.markedUsefulBy?.includes(userId) || false;
  };

  const averageRating = reviews.length > 0
    ? reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length
    : 0;

  return {
    reviews,
    isLoading,
    addReview,
    markAsUseful,
    hasUserMarkedUseful,
    averageRating,
    reviewCount: reviews.length
  };
};

// Hook to fetch all reviews for all products
export const useAllReviews = () => {
  return useQuery({
    queryKey: ['allReviews'],
    queryFn: async () => {
      const data = await graphqlClient.request<{ productReviews: { items: ProductReview[] } }>(
        GET_ALL_REVIEWS
      );
      return data.productReviews.items;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
};
