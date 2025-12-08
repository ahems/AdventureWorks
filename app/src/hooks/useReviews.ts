import { useState, useEffect } from 'react';
import { Review } from '@/types/review';
import { mockReviews } from '@/data/mockReviews';

const STORAGE_KEY = 'adventureworks_reviews';

export const useReviews = (productId: number) => {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Load reviews from localStorage, falling back to mock data
    const storedReviews = localStorage.getItem(STORAGE_KEY);
    let allReviews: Review[];
    
    if (storedReviews) {
      allReviews = JSON.parse(storedReviews);
    } else {
      allReviews = [...mockReviews];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(allReviews));
    }
    
    const productReviews = allReviews
      .filter(r => r.productId === productId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    
    setReviews(productReviews);
    setIsLoading(false);
  }, [productId]);

  const addReview = (review: Omit<Review, 'id' | 'createdAt' | 'helpful' | 'markedUsefulBy'>) => {
    const newReview: Review = {
      ...review,
      id: `user_${Date.now()}`,
      createdAt: new Date().toISOString().split('T')[0],
      helpful: 0,
      markedUsefulBy: []
    };

    const storedReviews = localStorage.getItem(STORAGE_KEY);
    const allReviews: Review[] = storedReviews ? JSON.parse(storedReviews) : [...mockReviews];
    
    allReviews.unshift(newReview);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(allReviews));
    
    setReviews(prev => [newReview, ...prev]);
    
    return newReview;
  };

  const markAsUseful = (reviewId: string, userId: string) => {
    const storedReviews = localStorage.getItem(STORAGE_KEY);
    const allReviews: Review[] = storedReviews ? JSON.parse(storedReviews) : [...mockReviews];
    
    const reviewIndex = allReviews.findIndex(r => r.id === reviewId);
    if (reviewIndex === -1) return false;
    
    const review = allReviews[reviewIndex];
    const markedUsefulBy = review.markedUsefulBy || [];
    
    // Check if user already marked this review
    if (markedUsefulBy.includes(userId)) {
      // Remove the mark
      allReviews[reviewIndex] = {
        ...review,
        helpful: Math.max(0, review.helpful - 1),
        markedUsefulBy: markedUsefulBy.filter(id => id !== userId)
      };
    } else {
      // Add the mark
      allReviews[reviewIndex] = {
        ...review,
        helpful: review.helpful + 1,
        markedUsefulBy: [...markedUsefulBy, userId]
      };
    }
    
    localStorage.setItem(STORAGE_KEY, JSON.stringify(allReviews));
    
    // Update local state
    setReviews(prev => prev.map(r => 
      r.id === reviewId ? allReviews[reviewIndex] : r
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
