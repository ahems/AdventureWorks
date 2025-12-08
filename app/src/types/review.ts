export interface Review {
  id: string;
  productId: number;
  userName: string;
  rating: number; // 1-5
  title: string;
  comment: string;
  createdAt: string;
  helpful: number;
  markedUsefulBy: string[]; // User IDs who marked this as useful
}
