export interface ShoppingCartItem {
  ShoppingCartItemID: number;
  ShoppingCartID: string;
  Quantity: number;
  ProductID: number;
  DateCreated: string;
  ModifiedDate: string;
}

export interface StaleCart {
  ShoppingCartID: string;
  customerEmail: string;
  customerName: string;
  items: ShoppingCartItem[];
  totalItems: number;
  totalValue: number;
  lastActivity: string;
  daysStale: number;
}
