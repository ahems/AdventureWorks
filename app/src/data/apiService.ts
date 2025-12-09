import { graphqlClient } from '@/lib/graphql-client';
import {
  GET_CATEGORIES,
  GET_SUBCATEGORIES,
  GET_SUBCATEGORIES_BY_CATEGORY,
  GET_PRODUCTS,
  GET_PRODUCT_BY_ID,
  GET_PRODUCTS_BY_SUBCATEGORY,
  GET_CATEGORY_BY_ID,
  GET_SUBCATEGORY_BY_ID,
} from '@/lib/graphql-queries';
import { Product, ProductCategory, ProductSubcategory } from '@/types/product';

// Type definitions for GraphQL responses
interface GraphQLResponse<T> {
  items: T[];
}

interface CategoriesResponse {
  productCategories: GraphQLResponse<ProductCategory>;
}

interface SubcategoriesResponse {
  productSubcategories: GraphQLResponse<ProductSubcategory>;
}

interface ProductsResponse {
  products: GraphQLResponse<Product>;
}

// Helper function to add icon names to categories (since they're not in the database)
const addIconsToCategories = (categories: ProductCategory[]): ProductCategory[] => {
  const iconMap: Record<string, string> = {
    'Bikes': 'bike',
    'Components': 'cog',
    'Clothing': 'shirt',
    'Accessories': 'backpack',
  };

  return categories.map(cat => ({
    ...cat,
    IconName: iconMap[cat.Name] || 'box',
  }));
};

// Fetch all categories
export const getCategories = async (): Promise<ProductCategory[]> => {
  try {
    const data = await graphqlClient.request<CategoriesResponse>(GET_CATEGORIES);
    return addIconsToCategories(data.productCategories.items);
  } catch (error) {
    console.error('Error fetching categories:', error);
    return [];
  }
};

// Fetch all subcategories
export const getSubcategories = async (): Promise<ProductSubcategory[]> => {
  try {
    const data = await graphqlClient.request<SubcategoriesResponse>(GET_SUBCATEGORIES);
    return data.productSubcategories.items;
  } catch (error) {
    console.error('Error fetching subcategories:', error);
    return [];
  }
};

// Fetch subcategories by category ID
export const getSubcategoriesByCategory = async (categoryId: number): Promise<ProductSubcategory[]> => {
  try {
    const data = await graphqlClient.request<SubcategoriesResponse>(
      GET_SUBCATEGORIES_BY_CATEGORY,
      { categoryId }
    );
    return data.productSubcategories.items;
  } catch (error) {
    console.error('Error fetching subcategories by category:', error);
    return [];
  }
};

// Fetch all products
export const getProducts = async (): Promise<Product[]> => {
  try {
    const data = await graphqlClient.request<ProductsResponse>(GET_PRODUCTS);
    return data.products.items;
  } catch (error) {
    console.error('Error fetching products:', error);
    return [];
  }
};

// Fetch product by ID
export const getProductById = async (productId: number): Promise<Product | undefined> => {
  try {
    const data = await graphqlClient.request<ProductsResponse>(GET_PRODUCT_BY_ID, { id: productId });
    return data.products.items[0];
  } catch (error) {
    console.error('Error fetching product by ID:', error);
    return undefined;
  }
};

// Fetch products by subcategory ID
export const getProductsBySubcategory = async (subcategoryId: number): Promise<Product[]> => {
  try {
    const data = await graphqlClient.request<ProductsResponse>(
      GET_PRODUCTS_BY_SUBCATEGORY,
      { subcategoryId }
    );
    return data.products.items;
  } catch (error) {
    console.error('Error fetching products by subcategory:', error);
    return [];
  }
};

// Fetch products by category ID (needs to get subcategories first)
export const getProductsByCategory = async (categoryId: number): Promise<Product[]> => {
  try {
    const subcategories = await getSubcategoriesByCategory(categoryId);
    const subcategoryIds = subcategories.map(s => s.ProductSubcategoryID);
    
    // Fetch all products and filter by subcategory IDs
    const allProducts = await getProducts();
    return allProducts.filter(
      p => p.ProductSubcategoryID && subcategoryIds.includes(p.ProductSubcategoryID)
    );
  } catch (error) {
    console.error('Error fetching products by category:', error);
    return [];
  }
};

// Fetch category by ID
export const getCategoryById = async (categoryId: number): Promise<ProductCategory | undefined> => {
  try {
    const data = await graphqlClient.request<CategoriesResponse>(GET_CATEGORY_BY_ID, { id: categoryId });
    const categories = addIconsToCategories(data.productCategories.items);
    return categories[0];
  } catch (error) {
    console.error('Error fetching category by ID:', error);
    return undefined;
  }
};

// Fetch subcategory by ID
export const getSubcategoryById = async (subcategoryId: number): Promise<ProductSubcategory | undefined> => {
  try {
    const data = await graphqlClient.request<SubcategoriesResponse>(GET_SUBCATEGORY_BY_ID, { id: subcategoryId });
    return data.productSubcategories.items[0];
  } catch (error) {
    console.error('Error fetching subcategory by ID:', error);
    return undefined;
  }
};

// Get featured products (first 6 products)
export const getFeaturedProducts = async (): Promise<Product[]> => {
  try {
    const products = await getProducts();
    return products.slice(0, 6);
  } catch (error) {
    console.error('Error fetching featured products:', error);
    return [];
  }
};

// Get sale products (products with discount - we'll need to add this logic)
// Since the API doesn't have discount info, we'll return an empty array for now
// You may need to extend the database schema or use a different approach
export const getSaleProducts = async (): Promise<Product[]> => {
  try {
    // For now, return empty array since sale info is not in the database
    // You could add a SalePrice field to the database or implement this differently
    return [];
  } catch (error) {
    console.error('Error fetching sale products:', error);
    return [];
  }
};

// Export arrays for backwards compatibility (these will be loaded asynchronously)
export let categories: ProductCategory[] = [];
export let subcategories: ProductSubcategory[] = [];
export let products: Product[] = [];

// Initialize data on module load
(async () => {
  try {
    [categories, subcategories, products] = await Promise.all([
      getCategories(),
      getSubcategories(),
      getProducts(),
    ]);
  } catch (error) {
    console.error('Error initializing data:', error);
  }
})();
