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

// Hook to fetch all subcategories
export const useSubcategories = () => {
  return useQuery<ProductSubcategory[]>({
    queryKey: ["subcategories"],
    queryFn: apiService.getSubcategories,
    staleTime: 5 * 60 * 1000,
  });
};

// Hook to fetch subcategories by category ID
export const useSubcategoriesByCategory = (categoryId: number) => {
  return useQuery<ProductSubcategory[]>({
    queryKey: ["subcategories", "category", categoryId],
    queryFn: () => apiService.getSubcategoriesByCategory(categoryId),
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
export const useProductsByIds = (productIds: number[]) => {
  return useQuery<Product[]>({
    queryKey: ["products", "byIds", productIds.sort().join(",")],
    queryFn: () => apiService.getProductsByIds(productIds),
    enabled: productIds.length > 0,
    staleTime: 2 * 60 * 1000,
  });
};

// Hook to fetch products by category ID
export const useProductsByCategory = (categoryId: number) => {
  return useQuery<Product[]>({
    queryKey: ["products", "category", categoryId],
    queryFn: () => apiService.getProductsByCategory(categoryId),
    enabled: !!categoryId,
    staleTime: 2 * 60 * 1000,
  });
};

// Hook to fetch products by subcategory ID
export const useProductsBySubcategory = (subcategoryId: number) => {
  return useQuery<Product[]>({
    queryKey: ["products", "subcategory", subcategoryId],
    queryFn: () => apiService.getProductsBySubcategory(subcategoryId),
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

// Hook to fetch subcategory by ID
export const useSubcategory = (subcategoryId: number) => {
  return useQuery<ProductSubcategory | undefined>({
    queryKey: ["subcategory", subcategoryId],
    queryFn: () => apiService.getSubcategoryById(subcategoryId),
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
export const useSaleProducts = () => {
  return useQuery<Product[]>({
    queryKey: ["products", "sale"],
    queryFn: apiService.getSaleProducts,
    staleTime: 2 * 60 * 1000,
  });
};
