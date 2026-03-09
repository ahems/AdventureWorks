// Types based on AdventureWorks schema
export interface UnavailableVariant {
  size?: string;
  color?: string;
}

export interface ProductPhoto {
  ProductPhotoID: number;
  ThumbNailPhoto: string | null; // Base64 encoded
  ThumbnailPhotoFileName: string | null;
  LargePhoto: string | null; // Base64 encoded
  LargePhotoFileName: string | null;
}

export interface ProductProductPhoto {
  ProductID: number;
  ProductPhotoID: number;
  Primary: boolean;
  productPhoto?: ProductPhoto; // Nested photo data from relationship
}

export interface SpecialOffer {
  SpecialOfferID: number;
  Description: string;
  DiscountPct: number;
  Type: string;
  Category: string;
  MinQty: number;
  MaxQty: number | null;
  StartDate: string;
  EndDate: string;
}

export interface SpecialOfferProduct {
  SpecialOfferID: number;
  ProductID: number;
}

export interface ProductInventory {
  ProductID: number;
  LocationID: number;
  Shelf: string;
  Bin: number;
  Quantity: number;
}

export interface Product {
  ProductID: number;
  Name: string;
  ProductNumber: string;
  Color: string | null;
  ListPrice: number;
  StandardCost?: number;
  Size: string | null;
  SizeUnitMeasureCode: string | null;
  Weight: number | null;
  WeightUnitMeasureCode: string | null;
  ProductSubcategoryID: number | null;
  ProductModelID: number | null;
  ProductLine?: string | null;
  Class?: string | null;
  Style?: string | null;
  Description?: string;
  ImageUrl?: string;
  // Discount data from SpecialOffer
  SpecialOfferID?: number;
  DiscountPct?: number; // Decimal format (e.g., 0.5 for 50% off)
  SpecialOfferDescription?: string;
  // Photo data (single photo - legacy support)
  ThumbNailPhoto?: string | null;
  LargePhoto?: string | null;
  ThumbnailPhotoFileName?: string | null;
  LargePhotoFileName?: string | null;
  // Multiple photos support
  productPhotos?: ProductPhoto[]; // Array of all photos for this product
  // Clothing variant options
  availableSizes?: string[];
  availableColors?: string[];
  // Out of stock combinations
  unavailableVariants?: UnavailableVariant[];
  // Inventory data
  quantityAvailable?: number; // Total quantity across all locations
  inStock?: boolean; // Whether the product has any inventory available
  // Dates
  SellStartDate?: string; // Date when product became available for sale
  SellEndDate?: string;
  DiscontinuedDate?: string | null;
}

export const getSalePrice = (product: Product): number | null => {
  // Use DiscountPct from API (decimal format: 0.5 = 50%)
  if (product.DiscountPct && product.DiscountPct > 0) {
    return product.ListPrice * (1 - product.DiscountPct);
  }
  return null;
};

// Check if a specific size/color combination is available
export const isVariantAvailable = (
  product: Product,
  selectedSize?: string,
  selectedColor?: string
): boolean => {
  if (
    !product.unavailableVariants ||
    product.unavailableVariants.length === 0
  ) {
    return true;
  }

  return !product.unavailableVariants.some((variant) => {
    const sizeMatch = !variant.size || variant.size === selectedSize;
    const colorMatch = !variant.color || variant.color === selectedColor;
    return sizeMatch && colorMatch;
  });
};

export interface ProductCategory {
  ProductCategoryID: number;
  CultureID?: string;
  Name: string;
  IconName?: string;
}

export interface ProductSubcategory {
  ProductSubcategoryID: number;
  ProductCategoryID: number;
  Name: string;
}

export interface ShoppingCartItem {
  ShoppingCartItemID: number;
  ShoppingCartID: string;
  Quantity: number;
  ProductID: number;
  Product?: Product;
}

export interface CartItem extends Product {
  quantity: number;
  selectedSize?: string;
  selectedColor?: string;
}

// Product Model Group - groups multiple product variants by their model
export interface ProductModelGroup {
  ProductModelID: number;
  modelName: string; // Base name without size/color (e.g., "Mountain-100")
  baseProduct: Product; // Representative product (first variant)
  variants: Product[]; // All product variants
  colors: string[]; // Available colors
  sizes: string[]; // Available sizes
  priceRange: {
    min: number;
    max: number;
  };
}
