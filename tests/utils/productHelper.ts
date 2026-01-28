import { testEnv } from "./env";

/**
 * Product data structure from the database
 */
export interface Product {
  ProductID: number;
  Name: string;
  ProductNumber?: string;
  Color?: string;
  ListPrice?: number;
  Size?: string;
  Weight?: number;
  ProductCategoryID?: number;
  ProductModelID?: number;
  SellStartDate?: string;
  SellEndDate?: string;
  DiscontinuedDate?: string;
  FinishedGoodsFlag?: boolean;
  MakeFlag?: boolean;
}

/**
 * Fetch all products from the database across multiple pages
 * DAB API uses cursor-based pagination with $after parameter and nextLink
 * We follow the nextLink URLs until there are no more pages
 * @param includeComponents If false (default), only returns finished goods for e-commerce display
 */
export const fetchAllProducts = async (
  includeComponents = false,
): Promise<Product[]> => {
  const baseUrl = testEnv.restApiBaseUrl;
  const allProducts: Product[] = [];
  let nextUrl: string | null = `${baseUrl}/Product`;
  const maxPages = 10; // Safety limit to avoid infinite loops

  try {
    let pageCount = 0;

    while (nextUrl && pageCount < maxPages) {
      const response: Response = await fetch(nextUrl);

      if (!response.ok) {
        console.warn(`⚠️  Failed to fetch products: ${response.statusText}`);
        break;
      }

      const data: { value?: Product[]; nextLink?: string } =
        await response.json();
      let products = data.value || [];

      // Filter to finished goods only if requested (default behavior)
      if (!includeComponents) {
        products = products.filter(
          (p: Product) => p.FinishedGoodsFlag === true,
        );
      }

      allProducts.push(...products);

      // Check if there's a next page
      nextUrl = data.nextLink || null;
      pageCount++;

      if (!nextUrl) {
        // No more pages
        break;
      }
    }

    return allProducts;
  } catch (error) {
    console.error("Error fetching products:", error);
    return [];
  }
};

/**
 * Get random products from the database
 * @param count Number of random products to retrieve
 * @param filter Optional filter function to select specific products
 * @param includeComponents If false (default), only returns finished goods
 */
export const getRandomProducts = async (
  count: number,
  filter?: (product: Product) => boolean,
  includeComponents = false,
): Promise<Product[]> => {
  const allProducts = await fetchAllProducts(includeComponents);

  if (allProducts.length === 0) {
    throw new Error("No products available in the database");
  }

  // Apply filter if provided
  const filteredProducts = filter ? allProducts.filter(filter) : allProducts;

  if (filteredProducts.length === 0) {
    throw new Error("No products match the filter criteria");
  }

  // If we need more products than available, return all filtered products
  if (count >= filteredProducts.length) {
    return [...filteredProducts].sort(() => Math.random() - 0.5);
  }

  // Select random products without replacement
  const randomProducts: Product[] = [];
  const availableIndices = Array.from(
    { length: filteredProducts.length },
    (_, i) => i,
  );

  for (let i = 0; i < count; i++) {
    const randomIndex = Math.floor(Math.random() * availableIndices.length);
    const productIndex = availableIndices[randomIndex];
    randomProducts.push(filteredProducts[productIndex]);
    availableIndices.splice(randomIndex, 1);
  }

  return randomProducts;
};

/**
 * Get random product IDs from the database
 * @param count Number of random product IDs to retrieve
 * @param filter Optional filter function to select specific products
 * @param includeComponents If false (default), only returns finished goods
 */
export const getRandomProductIds = async (
  count: number,
  filter?: (product: Product) => boolean,
  includeComponents = false,
): Promise<number[]> => {
  const products = await getRandomProducts(count, filter, includeComponents);
  return products.map((p) => p.ProductID);
};

/**
 * Get products that are likely in stock (have sell dates and not discontinued)
 */
export const getInStockProducts = async (count: number): Promise<Product[]> => {
  return getRandomProducts(count, (product) => {
    // Product should have a sell start date and no discontinued date
    return (
      !!product.SellStartDate &&
      !product.DiscontinuedDate &&
      (!product.SellEndDate || new Date(product.SellEndDate) > new Date())
    );
  });
};

/**
 * Get product IDs that are likely in stock
 */
export const getInStockProductIds = async (
  count: number,
): Promise<number[]> => {
  const products = await getInStockProducts(count);
  return products.map((p) => p.ProductID);
};

/**
 * Get products by color
 */
export const getProductsByColor = async (
  color: string,
  count: number,
): Promise<Product[]> => {
  return getRandomProducts(count, (product) => {
    return (
      product.Color?.toLowerCase() === color.toLowerCase() ||
      product.Name?.toLowerCase().includes(color.toLowerCase())
    );
  });
};

/**
 * Cache for all products to avoid repeated API calls
 * This is reset between test runs
 */
let productsCache: Product[] | null = null;
let cacheTimestamp: number = 0;
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get all products with caching
 * @param includeComponents If false (default), only returns finished goods
 */
export const getAllProductsCached = async (
  includeComponents = false,
): Promise<Product[]> => {
  const now = Date.now();

  // Return cached products if cache is still valid
  if (
    productsCache &&
    productsCache.length > 0 &&
    now - cacheTimestamp < CACHE_DURATION_MS
  ) {
    return productsCache;
  }

  // Fetch fresh data
  productsCache = await fetchAllProducts(includeComponents);
  cacheTimestamp = now;

  console.log(`📦 Loaded ${productsCache.length} products from database`);

  return productsCache;
};

/**
 * Clear the products cache
 */
export const clearProductsCache = (): void => {
  productsCache = null;
  cacheTimestamp = 0;
};
