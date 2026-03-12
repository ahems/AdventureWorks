import { useQuery } from "@tanstack/react-query";
import * as apiService from "@/data/apiService";
import { Product, ProductCategory, ProductSubcategory } from "@/types/product";

// Hook to fetch all categories for the given culture
export const useCategories = (cultureId: string = "en") => {
  return useQuery<ProductCategory[]>({
    queryKey: ["categories", cultureId],
    queryFn: () => apiService.getCategories(cultureId),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
};

// Hook to fetch all subcategories for the given culture
export const useSubcategories = (cultureId: string = "en") => {
  return useQuery<ProductSubcategory[]>({
    queryKey: ["subcategories", cultureId],
    queryFn: () => apiService.getSubcategories(cultureId),
    staleTime: 5 * 60 * 1000,
  });
};

// Hook to fetch subcategories by category ID for the given culture
export const useSubcategoriesByCategory = (
  categoryId: number,
  cultureId: string = "en",
) => {
  return useQuery<ProductSubcategory[]>({
    queryKey: ["subcategories", "category", categoryId, cultureId],
    queryFn: () =>
      apiService.getSubcategoriesByCategory(categoryId, cultureId),
    enabled: !!categoryId,
    staleTime: 5 * 60 * 1000,
  });
};

// Hook to fetch all products
export const useProducts = () => {
  return useQuery<Product[]>({
    queryKey: ["products"],
    queryFn: () => apiService.getProducts(true),
    staleTime: 2 * 60 * 1000, // 2 minutes
  });
};

// Hook to fetch a product by ID
export const useProduct = (productId: number, cultureId?: string) => {
  return useQuery<Product | undefined>({
    queryKey: ["product", productId, cultureId],
    queryFn: () => apiService.getProductById(productId, cultureId),
    enabled: !!productId,
    staleTime: 2 * 60 * 1000,
  });
};

// Hook to fetch products by multiple IDs (optimized for cart)
export const useProductsByIds = (
  productIds: number[],
  cultureId: string = "en",
) => {
  return useQuery<Product[]>({
    queryKey: ["products", "byIds", productIds.sort().join(","), cultureId],
    queryFn: () => apiService.getProductsByIds(productIds, cultureId),
    enabled: productIds.length > 0,
    staleTime: 2 * 60 * 1000,
  });
};

// Hook to fetch products by category ID for the given culture
export const useProductsByCategory = (
  categoryId: number,
  cultureId: string = "en",
) => {
  return useQuery<Product[]>({
    queryKey: ["products", "category", categoryId, cultureId],
    queryFn: () => apiService.getProductsByCategory(categoryId, cultureId),
    enabled: !!categoryId,
    staleTime: 2 * 60 * 1000,
  });
};

// Hook to fetch products by subcategory ID
export const useProductsBySubcategory = (
  subcategoryId: number,
  cultureId: string = "en",
) => {
  return useQuery<Product[]>({
    queryKey: ["products", "subcategory", subcategoryId, cultureId],
    queryFn: () =>
      apiService.getProductsBySubcategory(subcategoryId, cultureId),
    enabled: !!subcategoryId,
    staleTime: 2 * 60 * 1000,
  });
};

// Hook to fetch category by ID for the given culture
export const useCategory = (categoryId: number, cultureId: string = "en") => {
  return useQuery<ProductCategory | undefined>({
    queryKey: ["category", categoryId, cultureId],
    queryFn: () => apiService.getCategoryById(categoryId, cultureId),
    enabled: !!categoryId,
    staleTime: 5 * 60 * 1000,
  });
};

// Hook to fetch subcategory by ID for the given culture
export const useSubcategory = (
  subcategoryId: number,
  cultureId: string = "en",
) => {
  return useQuery<ProductSubcategory | undefined>({
    queryKey: ["subcategory", subcategoryId, cultureId],
    queryFn: () => apiService.getSubcategoryById(subcategoryId, cultureId),
    enabled: !!subcategoryId,
    staleTime: 5 * 60 * 1000,
  });
};

// Hook to fetch featured products
export const useFeaturedProducts = () => {
  return useQuery<Product[]>({
    queryKey: ["products", "featured"],
    queryFn: apiService.getFeaturedProducts,
    staleTime: 2 * 60 * 1000,
  });
};

// Hook to fetch sale products
export const useSaleProducts = (cultureId: string = "en") => {
  return useQuery<Product[]>({
    queryKey: ["products", "sale", cultureId],
    queryFn: () => apiService.getSaleProducts(cultureId),
    staleTime: 2 * 60 * 1000,
  });
};
