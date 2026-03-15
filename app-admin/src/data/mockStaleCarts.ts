import { StaleCart, ShoppingCartItem } from "@/types/shoppingCart";

const now = new Date();

const createDate = (daysAgo: number): string => {
  const date = new Date(now);
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString();
};

export const mockShoppingCartItems: ShoppingCartItem[] = [
  { ShoppingCartItemID: 1, ShoppingCartID: "CART-001", Quantity: 2, ProductID: 680, DateCreated: createDate(15), ModifiedDate: createDate(15) },
  { ShoppingCartItemID: 2, ShoppingCartID: "CART-001", Quantity: 1, ProductID: 706, DateCreated: createDate(15), ModifiedDate: createDate(14) },
  { ShoppingCartItemID: 3, ShoppingCartID: "CART-002", Quantity: 3, ProductID: 707, DateCreated: createDate(30), ModifiedDate: createDate(28) },
  { ShoppingCartItemID: 4, ShoppingCartID: "CART-003", Quantity: 1, ProductID: 708, DateCreated: createDate(7), ModifiedDate: createDate(7) },
  { ShoppingCartItemID: 5, ShoppingCartID: "CART-003", Quantity: 2, ProductID: 709, DateCreated: createDate(7), ModifiedDate: createDate(5) },
  { ShoppingCartItemID: 6, ShoppingCartID: "CART-004", Quantity: 1, ProductID: 710, DateCreated: createDate(45), ModifiedDate: createDate(45) },
  { ShoppingCartItemID: 7, ShoppingCartID: "CART-004", Quantity: 4, ProductID: 711, DateCreated: createDate(45), ModifiedDate: createDate(42) },
  { ShoppingCartItemID: 8, ShoppingCartID: "CART-004", Quantity: 1, ProductID: 712, DateCreated: createDate(45), ModifiedDate: createDate(40) },
  { ShoppingCartItemID: 9, ShoppingCartID: "CART-005", Quantity: 2, ProductID: 713, DateCreated: createDate(10), ModifiedDate: createDate(8) },
  { ShoppingCartItemID: 10, ShoppingCartID: "CART-006", Quantity: 1, ProductID: 714, DateCreated: createDate(60), ModifiedDate: createDate(58) },
  { ShoppingCartItemID: 11, ShoppingCartID: "CART-007", Quantity: 5, ProductID: 715, DateCreated: createDate(21), ModifiedDate: createDate(21) },
  { ShoppingCartItemID: 12, ShoppingCartID: "CART-008", Quantity: 1, ProductID: 716, DateCreated: createDate(3), ModifiedDate: createDate(3) },
];

export const mockStaleCarts: StaleCart[] = [
  {
    ShoppingCartID: "CART-001",
    customerEmail: "john.doe@example.com",
    customerName: "John Doe",
    items: mockShoppingCartItems.filter(i => i.ShoppingCartID === "CART-001"),
    totalItems: 3,
    totalValue: 1249.99,
    lastActivity: createDate(14),
    daysStale: 14,
  },
  {
    ShoppingCartID: "CART-002",
    customerEmail: "jane.smith@example.com",
    customerName: "Jane Smith",
    items: mockShoppingCartItems.filter(i => i.ShoppingCartID === "CART-002"),
    totalItems: 3,
    totalValue: 899.97,
    lastActivity: createDate(28),
    daysStale: 28,
  },
  {
    ShoppingCartID: "CART-003",
    customerEmail: "mike.wilson@example.com",
    customerName: "Mike Wilson",
    items: mockShoppingCartItems.filter(i => i.ShoppingCartID === "CART-003"),
    totalItems: 3,
    totalValue: 549.99,
    lastActivity: createDate(5),
    daysStale: 5,
  },
  {
    ShoppingCartID: "CART-004",
    customerEmail: "sarah.johnson@example.com",
    customerName: "Sarah Johnson",
    items: mockShoppingCartItems.filter(i => i.ShoppingCartID === "CART-004"),
    totalItems: 6,
    totalValue: 2399.94,
    lastActivity: createDate(40),
    daysStale: 40,
  },
  {
    ShoppingCartID: "CART-005",
    customerEmail: "david.brown@example.com",
    customerName: "David Brown",
    items: mockShoppingCartItems.filter(i => i.ShoppingCartID === "CART-005"),
    totalItems: 2,
    totalValue: 349.98,
    lastActivity: createDate(8),
    daysStale: 8,
  },
  {
    ShoppingCartID: "CART-006",
    customerEmail: "emily.davis@example.com",
    customerName: "Emily Davis",
    items: mockShoppingCartItems.filter(i => i.ShoppingCartID === "CART-006"),
    totalItems: 1,
    totalValue: 199.99,
    lastActivity: createDate(58),
    daysStale: 58,
  },
  {
    ShoppingCartID: "CART-007",
    customerEmail: "chris.martinez@example.com",
    customerName: "Chris Martinez",
    items: mockShoppingCartItems.filter(i => i.ShoppingCartID === "CART-007"),
    totalItems: 5,
    totalValue: 749.95,
    lastActivity: createDate(21),
    daysStale: 21,
  },
  {
    ShoppingCartID: "CART-008",
    customerEmail: "lisa.anderson@example.com",
    customerName: "Lisa Anderson",
    items: mockShoppingCartItems.filter(i => i.ShoppingCartID === "CART-008"),
    totalItems: 1,
    totalValue: 129.99,
    lastActivity: createDate(3),
    daysStale: 3,
  },
];
