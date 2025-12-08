// Types based on AdventureWorks schema
export interface UnavailableVariant {
  size?: string;
  color?: string;
}

export interface Product {
  ProductID: number;
  Name: string;
  ProductNumber: string;
  Color: string | null;
  ListPrice: number;
  Size: string | null;
  Weight: number | null;
  ProductSubcategoryID: number | null;
  ProductModelID: number | null;
  Description?: string;
  ImageUrl?: string;
  salePercent?: number; // Optional discount percentage (e.g., 20 for 20% off)
  // Clothing variant options
  availableSizes?: string[];
  availableColors?: string[];
  // Out of stock combinations
  unavailableVariants?: UnavailableVariant[];
}

export const getSalePrice = (product: Product): number | null => {
  if (product.salePercent && product.salePercent > 0) {
    return product.ListPrice * (1 - product.salePercent / 100);
  }
  return null;
};

// Check if a specific size/color combination is available
export const isVariantAvailable = (
  product: Product,
  selectedSize?: string,
  selectedColor?: string
): boolean => {
  if (!product.unavailableVariants || product.unavailableVariants.length === 0) {
    return true;
  }

  return !product.unavailableVariants.some(variant => {
    const sizeMatch = !variant.size || variant.size === selectedSize;
    const colorMatch = !variant.color || variant.color === selectedColor;
    return sizeMatch && colorMatch;
  });
};

export interface ProductCategory {
  ProductCategoryID: number;
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
