import { testEnv } from "./env";

const graphqlUrl = testEnv.restApiBaseUrl.replace(/\/api\/?$/, "/graphql");

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

const FETCH_RETRIES = 3;
const FETCH_RETRY_DELAY_MS = 2000;

/**
 * Fetch with retries for transient failures (e.g. EAI_AGAIN from cross-region DNS).
 */
async function fetchWithRetry(
  url: string,
  retries = FETCH_RETRIES,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok || attempt === retries) return response;
      lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        console.warn(
          `⚠️  Fetch failed (attempt ${attempt}/${retries}), retrying in ${FETCH_RETRY_DELAY_MS}ms:`,
          err instanceof Error ? err.message : err,
        );
        await new Promise((r) => setTimeout(r, FETCH_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError;
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
      const response: Response = await fetchWithRetry(nextUrl);

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

    if (allProducts.length === 0) {
      console.warn(
        "⚠️  REST API returned no products; check REST_API_BASE_URL and network.",
      );
    }
    return allProducts;
  } catch (error) {
    console.error("Error fetching products:", error);
    console.warn(
      "⚠️  REST API returned no products; check REST_API_BASE_URL and network.",
    );
    return [];
  }
};

/** Fallback product IDs when REST API is unreachable (e.g. on Azure workers without env). Used so tests that need 'any product' can still run. */
const FALLBACK_PRODUCT_IDS = [680, 706, 707, 708, 723];

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
    console.warn(
      "⚠️  REST API returned no products; using fallback IDs so tests can continue.",
    );
    // Fallback minimal products so tests that need "any product" don't fail when REST is unreachable (e.g. Azure workers).
    const fallbackProducts: Product[] = FALLBACK_PRODUCT_IDS.map((id) => ({
      ProductID: id,
      Name: `Product ${id}`,
      FinishedGoodsFlag: true,
      SellStartDate: "2008-01-01",
    }));
    const filtered =
      filter ? fallbackProducts.filter(filter) : fallbackProducts;
    if (filtered.length === 0) {
      throw new Error("No products match the filter criteria");
    }
    const take = Math.min(count, filtered.length);
    return [...filtered].sort(() => Math.random() - 0.5).slice(0, take);
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
 * Get product IDs that have at least one product-photo mapping and are finished goods (valid for image tests).
 * Accepts both base images (ProductPhotoID < 1000) and PNG images (ProductPhotoID >= 1000); no filter on photo ID.
 */
export const getProductIdsWithPhotos = async (
  limit = 15,
): Promise<number[]> => {
  try {
    // 1) All product-photo mappings (base + PNG); variance in IDs allowed
    const mapRes = await fetch(graphqlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `
          query {
            productProductPhotos(first: 300) {
              items { ProductID ProductPhotoID }
            }
          }
        `,
      }),
    });
    if (!mapRes.ok) return [680, 706, 707, 708, 723];
    const mapJson = (await mapRes.json()) as {
      data?: { productProductPhotos?: { items?: { ProductID: number; ProductPhotoID: number }[] } };
      errors?: unknown[];
    };
    if (mapJson.errors?.length) return [680, 706, 707, 708, 723];
    const candidateIds = [...new Set((mapJson.data?.productProductPhotos?.items ?? []).map((i) => i.ProductID))];
    if (candidateIds.length === 0) return [680, 706, 707, 708, 723];

    // 2) Restrict to finished goods only (FinishedGoodsFlag = true)
    const chunkSize = 100;
    const finishedGoodIds: number[] = [];
    for (let i = 0; i < candidateIds.length; i += chunkSize) {
      const chunk = candidateIds.slice(i, i + chunkSize);
      const prodRes = await fetch(graphqlUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            query($ids: [Int!]!) {
              products(filter: { ProductID: { in: $ids }, FinishedGoodsFlag: { eq: true } }) {
                items { ProductID }
              }
            }
          `,
          variables: { ids: chunk },
        }),
      });
      if (!prodRes.ok) continue;
      const prodJson = (await prodRes.json()) as {
        data?: { products?: { items?: { ProductID: number }[] } };
        errors?: unknown[];
      };
      if (prodJson.errors?.length) continue;
      const items = prodJson.data?.products?.items ?? [];
      finishedGoodIds.push(...items.map((p) => p.ProductID));
    }

    const ids = finishedGoodIds.slice(0, limit);
    if (ids.length > 0) return ids;
  } catch {
    // ignore
  }
  return [680, 706, 707, 708, 723];
};

/**
 * Get one product ID that has a product-photo mapping (convenience wrapper).
 */
export const getProductIdWithPhoto = async (): Promise<number> => {
  const ids = await getProductIdsWithPhotos(1);
  return ids[0] ?? 680;
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
