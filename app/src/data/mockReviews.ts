import { Review } from '@/types/review';

export const mockReviews: Review[] = [
  // Road-150 Red, 62 (ProductID: 749)
  {
    id: 'r1',
    productId: 749,
    userName: 'Mike T.',
    rating: 5,
    title: 'Best road bike I have ever owned!',
    comment: 'The Road-150 is absolutely incredible. The lightweight frame and smooth ride make every trip enjoyable. Worth every penny!',
    createdAt: '2024-11-15',
    helpful: 12,
    markedUsefulBy: []
  },
  {
    id: 'r2',
    productId: 749,
    userName: 'Sarah L.',
    rating: 4,
    title: 'Great bike, minor assembly issues',
    comment: 'Love the bike once it was set up. The instructions could be clearer, but the end result is fantastic.',
    createdAt: '2024-10-22',
    helpful: 8,
    markedUsefulBy: []
  },
  {
    id: 'r3',
    productId: 749,
    userName: 'John D.',
    rating: 5,
    title: 'Professional quality',
    comment: 'I use this for training and it performs beautifully. Highly recommend for serious cyclists.',
    createdAt: '2024-09-18',
    helpful: 15,
    markedUsefulBy: []
  },
  // Mountain-100 Silver, 38 (ProductID: 751)
  {
    id: 'r4',
    productId: 751,
    userName: 'Alex K.',
    rating: 5,
    title: 'Handles any trail',
    comment: 'Took this on some serious mountain trails and it handled everything perfectly. The suspension is top-notch.',
    createdAt: '2024-11-01',
    helpful: 20,
    markedUsefulBy: []
  },
  {
    id: 'r5',
    productId: 751,
    userName: 'Emma W.',
    rating: 4,
    title: 'Solid mountain bike',
    comment: 'Great performance on rough terrain. A bit heavy for uphill climbs but overall excellent.',
    createdAt: '2024-10-15',
    helpful: 6,
    markedUsefulBy: []
  },
  // Sport-100 Helmet, Blue (ProductID: 900)
  {
    id: 'r6',
    productId: 900,
    userName: 'Chris P.',
    rating: 5,
    title: 'Comfortable and safe',
    comment: 'Fits perfectly and feels very secure. Great ventilation too!',
    createdAt: '2024-11-10',
    helpful: 4,
    markedUsefulBy: []
  },
  {
    id: 'r7',
    productId: 900,
    userName: 'Lisa M.',
    rating: 3,
    title: 'Good but runs small',
    comment: 'Quality is good but I had to exchange for a larger size. Order one size up!',
    createdAt: '2024-09-28',
    helpful: 11,
    markedUsefulBy: []
  },
  // Short-Sleeve Classic Jersey (ProductID: 850)
  {
    id: 'r8',
    productId: 850,
    userName: 'David R.',
    rating: 5,
    title: 'Perfect for summer rides',
    comment: 'Super breathable and the pockets are really useful. Great value for the price especially on sale!',
    createdAt: '2024-11-20',
    helpful: 7,
    markedUsefulBy: []
  }
];

export const getReviewsByProductId = (productId: number): Review[] => {
  return mockReviews.filter(r => r.productId === productId);
};

export const getAverageRating = (productId: number): number => {
  const reviews = getReviewsByProductId(productId);
  if (reviews.length === 0) return 0;
  const sum = reviews.reduce((acc, r) => acc + r.rating, 0);
  return sum / reviews.length;
};

export const getReviewCount = (productId: number): number => {
  return getReviewsByProductId(productId).length;
};
