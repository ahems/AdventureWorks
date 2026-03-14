import { graphqlClient } from "@/lib/graphql-client";
import { getRestApiUrl } from "@/lib/utils";
import { trackError } from "@/lib/appInsights";
import {
  GET_CATEGORIES,
  GET_SUBCATEGORIES,
  GET_SUBCATEGORIES_BY_CATEGORY,
  GET_PRODUCTS,
  GET_PRODUCTS_BY_IDS,
  GET_PRODUCT_BY_ID,
  GET_PRODUCTS_BY_SUBCATEGORY,
  GET_PRODUCTS_BY_SUBCATEGORY_IDS,
  GET_CATEGORY_BY_ID,
  GET_SUBCATEGORY_BY_ID,
  GET_PRODUCT_PHOTOS_BATCH,
  GET_PHOTOS_BY_IDS,
  GET_LARGE_PHOTO,
  GET_PRODUCT_DESCRIPTION,
  GET_DESCRIPTION_TEXT,
  GET_CUSTOMER_SPECIAL_OFFERS,
  GET_SPECIAL_OFFER_PRODUCTS,
  GET_PRODUCTS_INVENTORY,
} from "@/lib/graphql-queries";
import {
  Product,
  ProductCategory,
  ProductSubcategory,
  ProductPhoto,
  ProductProductPhoto,
  SpecialOffer,
  SpecialOfferProduct,
  ProductInventory,
} from "@/types/product";

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

// Extended Product type for GraphQL response with nested relationships
interface ProductWithPhotosRelationship extends Product {
  productProductPhotos?: GraphQLResponse<ProductProductPhoto>;
}

interface ProductsResponse {
  products: GraphQLResponse<ProductWithPhotosRelationship>;
}

interface ProductPhotosResponse {
  productProductPhotos: GraphQLResponse<ProductProductPhoto>;
}

interface PhotoDataResponse {
  productPhotos: GraphQLResponse<ProductPhoto>;
}

interface ProductDescriptionMappingResponse {
  productModelProductDescriptionCultures: GraphQLResponse<{
    ProductDescriptionID: number;
  }>;
}

interface DescriptionTextResponse {
  productDescriptions: GraphQLResponse<{
    Description: string;
  }>;
}

interface SpecialOffersResponse {
  specialOffers: GraphQLResponse<SpecialOffer>;
}

interface SpecialOfferProductsResponse {
  specialOfferProducts: GraphQLResponse<SpecialOfferProduct>;
}

interface ProductInventoriesResponse {
  productInventories: GraphQLResponse<ProductInventory>;
}

// Helper function to fetch and attach descriptions to products
const attachDescriptionsToProducts = async (
  products: Product[],
  cultureId: string = "en",
): Promise<Product[]> => {
  try {
    if (products.length === 0) return products;

    // Pad culture ID to match database format (6 chars with spaces)
    const paddedCultureId = cultureId.padEnd(6, " ");

    // Get unique ProductModelIDs
    const modelIds = [
      ...new Set(products.map((p) => p.ProductModelID).filter(Boolean)),
    ];

    if (modelIds.length === 0) return products;

    // Fetch description mappings for all models
    const descriptionMappings = await Promise.all(
      modelIds.map(async (modelId) => {
        try {
          const data =
            await graphqlClient.request<ProductDescriptionMappingResponse>(
              GET_PRODUCT_DESCRIPTION,
              { productModelId: modelId, cultureId: paddedCultureId },
            );
          const descId =
            data.productModelProductDescriptionCultures.items[0]
              ?.ProductDescriptionID;
          return { modelId, descId };
        } catch {
          return { modelId, descId: null };
        }
      }),
    );

    // Get unique description IDs
    const descriptionIds = [
      ...new Set(descriptionMappings.map((m) => m.descId).filter(Boolean)),
    ] as number[];

    if (descriptionIds.length === 0) return products;

    // Fetch actual descriptions
    const descriptions = await Promise.all(
      descriptionIds.map(async (descId) => {
        try {
          const data = await graphqlClient.request<DescriptionTextResponse>(
            GET_DESCRIPTION_TEXT,
            { descriptionId: descId },
          );
          return {
            descId,
            text: data.productDescriptions.items[0]?.Description,
          };
        } catch {
          return { descId, text: null };
        }
      }),
    );

    // Create maps
    const modelToDescId = new Map(
      descriptionMappings.map((m) => [m.modelId, m.descId]),
    );
    const descIdToText = new Map(descriptions.map((d) => [d.descId, d.text]));

    // Attach descriptions to products
    return products.map((product) => {
      if (product.ProductModelID) {
        const descId = modelToDescId.get(product.ProductModelID);
        if (descId) {
          const description = descIdToText.get(descId);
          if (description) {
            return { ...product, Description: description };
          }
        }
      }
      return product;
    });
  } catch (error) {
    trackError("Error attaching descriptions to products", error, {
      service: "apiService",
      function: "attachDescriptionsToProducts",
    });
    return products;
  }
};

// Helper function to fetch and attach discounts to products
const attachDiscountsToProducts = async (
  products: Product[],
  cultureId: string = "en",
): Promise<Product[]> => {
  try {
    if (products.length === 0) return products;

    const paddedCultureId = cultureId.padEnd(6, " ");

    // Fetch customer special offers for the given culture
    const offersData = await graphqlClient.request<SpecialOffersResponse>(
      GET_CUSTOMER_SPECIAL_OFFERS,
      { cultureId: paddedCultureId },
    );
    const specialOffers = offersData.specialOffers.items;

    if (specialOffers.length === 0) {
      return products;
    }

    // Get the offer IDs
    const offerIds = specialOffers.map((offer) => offer.SpecialOfferID);

    // Fetch product-offer mappings
    const mappingsData =
      await graphqlClient.request<SpecialOfferProductsResponse>(
        GET_SPECIAL_OFFER_PRODUCTS,
        { offerIds },
      );
    const offerProducts = mappingsData.specialOfferProducts.items;

    if (offerProducts.length === 0) {
      return products;
    }

    // Create maps for quick lookups
    const productToOfferId = new Map(
      offerProducts.map((op) => [op.ProductID, op.SpecialOfferID]),
    );
    const offerIdToOffer = new Map(
      specialOffers.map((offer) => [offer.SpecialOfferID, offer]),
    );

    // Attach discount info to products
    const result = products.map((product) => {
      const offerId = productToOfferId.get(product.ProductID);
      if (offerId) {
        const offer = offerIdToOffer.get(offerId);
        if (offer) {
          return {
            ...product,
            SpecialOfferID: offer.SpecialOfferID,
            DiscountPct: offer.DiscountPct,
            SpecialOfferDescription: offer.Description,
          };
        }
      }
      return product;
    });

    return result;
  } catch (error) {
    trackError("Error attaching discounts to products", error, {
      service: "apiService",
      function: "attachDiscountsToProducts",
    });
    return products; // Return products without discounts on error
  }
};

// Helper function to fetch and attach photos to products
const attachPhotosToProducts = async (
  products: Product[],
): Promise<Product[]> => {
  try {
    if (products.length === 0) return products;

    const productIds = products.map((p) => p.ProductID);

    // Split into smaller chunks to avoid memory issues with binary photo data
    // Even thumbnails can cause OutOfMemoryException with large batches
    const chunkSize = 10;
    const chunks: number[][] = [];
    for (let i = 0; i < productIds.length; i += chunkSize) {
      chunks.push(productIds.slice(i, i + chunkSize));
    }

    // Fetch product-photo mappings in batches
    const allPhotoMappings: Array<{
      ProductID: number;
      ProductPhotoID: number;
    }> = [];
    for (const chunk of chunks) {
      try {
        const photoMappingsData =
          await graphqlClient.request<ProductPhotosResponse>(
            GET_PRODUCT_PHOTOS_BATCH,
            { productIds: chunk },
          );
        allPhotoMappings.push(...photoMappingsData.productProductPhotos.items);
      } catch (chunkError) {
        trackError("Failed to fetch photo mappings for chunk", chunkError, {
          service: "apiService",
          function: "attachPhotosToProducts",
          context: "photoMappings",
        });
        // Continue with other chunks even if one fails
      }
    }

    if (allPhotoMappings.length === 0) return products;

    // Get unique photo IDs
    const photoIds = [
      ...new Set(allPhotoMappings.map((m) => m.ProductPhotoID)),
    ];

    // Fetch actual photo data in even smaller chunks (thumbnails only)
    const photoChunkSize = 5;
    const photoChunks: number[][] = [];
    for (let i = 0; i < photoIds.length; i += photoChunkSize) {
      photoChunks.push(photoIds.slice(i, i + photoChunkSize));
    }

    const allPhotos: ProductPhoto[] = [];
    for (const chunk of photoChunks) {
      try {
        const photoDataResponse =
          await graphqlClient.request<PhotoDataResponse>(GET_PHOTOS_BY_IDS, {
            photoIds: chunk,
          });
        allPhotos.push(...photoDataResponse.productPhotos.items);
      } catch (photoError) {
        trackError("Failed to fetch photos for chunk", photoError, {
          service: "apiService",
          function: "attachPhotosToProducts",
          context: "photoData",
        });
        // Continue with other chunks even if one fails
      }
    }
    const photos = allPhotos;

    // Create a map of ProductID -> Photo
    const photoMap = new Map<number, ProductPhoto>();
    allPhotoMappings.forEach((mapping) => {
      const photo = photos.find(
        (p) => p.ProductPhotoID === mapping.ProductPhotoID,
      );
      if (photo) {
        photoMap.set(mapping.ProductID, photo);
      }
    });

    // Attach photos to products (thumbnails only to avoid memory issues)
    return products.map((product) => {
      const photo = photoMap.get(product.ProductID);
      if (photo) {
        return {
          ...product,
          ThumbNailPhoto: photo.ThumbNailPhoto,
          ThumbnailPhotoFileName: photo.ThumbnailPhotoFileName,
        };
      }
      return product;
    });
  } catch (error) {
    trackError("Error attaching photos to products", error, {
      service: "apiService",
      function: "attachPhotosToProducts",
    });
    return products; // Return products without photos on error
  }
};

// Helper function to fetch and attach inventory to products
const attachInventoryToProducts = async (
  products: Product[],
): Promise<Product[]> => {
  try {
    if (products.length === 0) return products;

    const productIds = products.map((p) => p.ProductID);

    // Split into chunks of 20 to avoid API limit
    const chunkSize = 20;
    const chunks: number[][] = [];
    for (let i = 0; i < productIds.length; i += chunkSize) {
      chunks.push(productIds.slice(i, i + chunkSize));
    }

    // Fetch inventory data in batches
    const allInventories: ProductInventory[] = [];
    for (const chunk of chunks) {
      const inventoryData =
        await graphqlClient.request<ProductInventoriesResponse>(
          GET_PRODUCTS_INVENTORY,
          { productIds: chunk },
        );
      allInventories.push(...inventoryData.productInventories.items);
    }

    // Create a map of ProductID -> Total Quantity (sum across all locations)
    const inventoryMap = new Map<number, number>();
    allInventories.forEach((inv) => {
      const currentQty = inventoryMap.get(inv.ProductID) || 0;
      inventoryMap.set(inv.ProductID, currentQty + inv.Quantity);
    });

    // Attach inventory info to products
    const result = products.map((product) => {
      const quantity = inventoryMap.get(product.ProductID);

      if (quantity === undefined) {
        // No inventory records for this product
        return {
          ...product,
          quantityAvailable: 0,
          inStock: false,
        };
      }

      return {
        ...product,
        quantityAvailable: quantity,
        inStock: quantity > 0,
      };
    });

    return result;
  } catch (error) {
    trackError("Error attaching inventory to products", error, {
      service: "apiService",
      function: "attachInventoryToProducts",
    });
    return products; // Return products without inventory on error
  }
};

// Helper function to add icon names to categories (since they're not in the database)
// Maps by ProductCategoryID so it works regardless of the translated Name.
const addIconsToCategories = (
  categories: ProductCategory[],
): ProductCategory[] => {
  const iconMap: Record<number, string> = {
    1: "bike",       // Bikes
    2: "cog",        // Components
    3: "shirt",      // Clothing
    4: "backpack",   // Accessories
  };

  return categories.map((cat) => ({
    ...cat,
    IconName: iconMap[cat.ProductCategoryID] || "box",
  }));
};

// Fetch all categories for the given culture (padded to 6 chars for nchar(6) DB column)
export const getCategories = async (
  cultureId: string = "en",
): Promise<ProductCategory[]> => {
  try {
    const paddedCultureId = cultureId.padEnd(6, " ");
    const data = await graphqlClient.request<CategoriesResponse>(
      GET_CATEGORIES,
      { cultureId: paddedCultureId },
    );
    return addIconsToCategories(data.productCategories.items);
  } catch (error) {
    trackError("Error fetching categories", error, {
      service: "apiService",
      function: "getCategories",
    });
    return [];
  }
};

// Fetch all subcategories for the given culture (padded to 6 chars for nchar(6) DB column)
export const getSubcategories = async (
  cultureId: string = "en",
): Promise<ProductSubcategory[]> => {
  try {
    const paddedCultureId = cultureId.padEnd(6, " ");
    const data = await graphqlClient.request<SubcategoriesResponse>(
      GET_SUBCATEGORIES,
      { cultureId: paddedCultureId },
    );
    return data.productSubcategories.items;
  } catch (error) {
    trackError("Error fetching subcategories", error, {
      service: "apiService",
      function: "getSubcategories",
    });
    return [];
  }
};

// Fetch subcategories by category ID for the given culture (padded to 6 chars)
export const getSubcategoriesByCategory = async (
  categoryId: number,
  cultureId: string = "en",
): Promise<ProductSubcategory[]> => {
  try {
    const paddedCultureId = cultureId.padEnd(6, " ");
    const data = await graphqlClient.request<SubcategoriesResponse>(
      GET_SUBCATEGORIES_BY_CATEGORY,
      { categoryId, cultureId: paddedCultureId },
    );
    return data.productSubcategories.items;
  } catch (error) {
    trackError("Error fetching subcategories by category", error, {
      service: "apiService",
      function: "getSubcategoriesByCategory",
      categoryId: categoryId,
    });
    return [];
  }
};

// Fetch all products (with optional photo fetching and optional culture for discount descriptions)
export const getProducts = async (
  includePhotos: boolean = false,
  cultureId: string = "en",
): Promise<Product[]> => {
  try {
    const data = await graphqlClient.request<ProductsResponse>(GET_PRODUCTS);
    let products = data.products.items;

    // Always attach discounts (in given culture) and inventory
    products = await attachDiscountsToProducts(products, cultureId);
    products = await attachInventoryToProducts(products);

    if (includePhotos) {
      return await attachPhotosToProducts(products);
    }
    return products;
  } catch (error) {
    trackError("Error fetching products", error, {
      service: "apiService",
      function: "getProducts",
    });
    return [];
  }
};

// Fetch product by ID
export const getProductById = async (
  productId: number,
  cultureId: string = "en",
): Promise<Product | undefined> => {
  try {
    const data = await graphqlClient.request<ProductsResponse>(
      GET_PRODUCT_BY_ID,
      { id: productId },
    );
    const product = data.products.items[0];
    if (!product) return undefined;

    // Extract multiple photos from the relationship
    const productPhotos: ProductPhoto[] = [];
    if (product.productProductPhotos?.items) {
      // Sort by Primary flag (primary first), then by ProductPhotoID
      const sortedPhotoMappings = [...product.productProductPhotos.items].sort(
        (a, b) => {
          if (a.Primary && !b.Primary) return -1;
          if (!a.Primary && b.Primary) return 1;
          return a.ProductPhotoID - b.ProductPhotoID;
        },
      );

      // Extract photo data from nested relationship
      for (const mapping of sortedPhotoMappings) {
        if (mapping.productPhoto) {
          productPhotos.push(mapping.productPhoto);
        }
      }
    }

    // Set primary photo (first photo) as legacy single photo fields for backward compatibility
    // Note: Only thumbnails are loaded initially. LargePhoto must be fetched on-demand using getLargePhoto()
    const primaryPhoto = productPhotos[0];
    const productWithPhotos = {
      ...product,
      productPhotos: productPhotos.length > 0 ? productPhotos : undefined,
      ThumbNailPhoto: primaryPhoto?.ThumbNailPhoto,
      ThumbnailPhotoFileName: primaryPhoto?.ThumbnailPhotoFileName,
    };

    // Fetch description, discount, and inventory for single product
    let productsWithDescriptions = await attachDescriptionsToProducts(
      [productWithPhotos],
      cultureId,
    );
    productsWithDescriptions = await attachDiscountsToProducts(
      productsWithDescriptions,
      cultureId,
    );
    const productsWithInventory = await attachInventoryToProducts(
      productsWithDescriptions,
    );
    return productsWithInventory[0];
  } catch (error) {
    trackError("Error fetching product by ID", error, {
      service: "apiService",
      function: "getProductById",
      productId: productId,
    });
    return undefined;
  }
};

// Fetch products by multiple IDs (optimized for cart)
export const getProductsByIds = async (
  productIds: number[],
  cultureId: string = "en",
): Promise<Product[]> => {
  try {
    if (productIds.length === 0) return [];
    
    const data = await graphqlClient.request<ProductsResponse>(
      GET_PRODUCTS_BY_IDS,
      { ids: productIds },
    );
    let products = data.products.items;

    // Always attach discounts (in given culture) and inventory
    products = await attachDiscountsToProducts(products, cultureId);
    products = await attachInventoryToProducts(products);
    
    return products;
  } catch (error) {
    trackError("Error fetching products by IDs", error, {
      service: "apiService",
      function: "getProductsByIds",
      productIds: productIds.join(","),
    });
    return [];
  }
};

// Fetch products by subcategory ID
export const getProductsBySubcategory = async (
  subcategoryId: number,
  cultureId: string = "en",
): Promise<Product[]> => {
  try {
    const data = await graphqlClient.request<ProductsResponse>(
      GET_PRODUCTS_BY_SUBCATEGORY,
      { subcategoryId },
    );
    let products = data.products.items;
    products = await attachDiscountsToProducts(products, cultureId);
    products = await attachInventoryToProducts(products);
    return await attachPhotosToProducts(products);
  } catch (error) {
    trackError("Error fetching products by subcategory", error, {
      service: "apiService",
      function: "getProductsBySubcategory",
      subcategoryId: subcategoryId,
    });
    return [];
  }
};

// Fetch products by category ID (needs to get subcategories first for the given culture)
export const getProductsByCategory = async (
  categoryId: number,
  cultureId: string = "en",
): Promise<Product[]> => {
  try {
    // First, get all subcategory IDs for this category in the given culture
    const subcategories = await getSubcategoriesByCategory(categoryId, cultureId);
    const subcategoryIds = subcategories.map((s) => s.ProductSubcategoryID);

    // If no subcategories, return empty array
    if (subcategoryIds.length === 0) {
      return [];
    }

    // Then fetch products that belong to any of these subcategories using the 'in' filter
    const data = await graphqlClient.request<ProductsResponse>(
      GET_PRODUCTS_BY_SUBCATEGORY_IDS,
      { subcategoryIds },
    );
    let products = data.products.items;
    products = await attachDiscountsToProducts(products, cultureId);
    products = await attachInventoryToProducts(products);
    return await attachPhotosToProducts(products);
  } catch (error) {
    trackError("Error fetching products by category", error, {
      service: "apiService",
      function: "getProductsByCategory",
      categoryId: categoryId,
    });
    return [];
  }
};

// Fetch category by ID for the given culture (padded to 6 chars for nchar(6) DB column)
export const getCategoryById = async (
  categoryId: number,
  cultureId: string = "en",
): Promise<ProductCategory | undefined> => {
  try {
    const paddedCultureId = cultureId.padEnd(6, " ");
    const data = await graphqlClient.request<CategoriesResponse>(
      GET_CATEGORY_BY_ID,
      { id: categoryId, cultureId: paddedCultureId },
    );
    const categories = addIconsToCategories(data.productCategories.items);
    return categories[0];
  } catch (error) {
    trackError("Error fetching category by ID", error, {
      service: "apiService",
      function: "getCategoryById",
      categoryId: categoryId,
    });
    return undefined;
  }
};

// Fetch subcategory by ID for the given culture (padded to 6 chars)
export const getSubcategoryById = async (
  subcategoryId: number,
  cultureId: string = "en",
): Promise<ProductSubcategory | undefined> => {
  try {
    const paddedCultureId = cultureId.padEnd(6, " ");
    const data = await graphqlClient.request<SubcategoriesResponse>(
      GET_SUBCATEGORY_BY_ID,
      { id: subcategoryId, cultureId: paddedCultureId },
    );
    return data.productSubcategories.items[0];
  } catch (error) {
    trackError("Error fetching subcategory by ID", error, {
      service: "apiService",
      function: "getSubcategoryById",
      subcategoryId: subcategoryId,
    });
    return undefined;
  }
};

// Get featured products (first 6 products with photos). Uses cultureId for localized discount/special offer text.
export const getFeaturedProducts = async (
  cultureId: string = "en",
): Promise<Product[]> => {
  try {
    // Load products WITHOUT photos first, with discount descriptions in the given culture
    const products = await getProducts(false, cultureId);
    // Filter to only in-stock products
    const inStockProducts = products.filter((p) => p.inStock);

    // Separate sale and non-sale products
    const saleProducts = inStockProducts.filter(
      (p) => p.DiscountPct && p.DiscountPct > 0,
    );
    const nonSaleProducts = inStockProducts.filter(
      (p) => !p.DiscountPct || p.DiscountPct === 0,
    );

    // Get 1 random sale product
    const shuffledSale = [...saleProducts].sort(() => Math.random() - 0.5);
    const featuredSale = shuffledSale.slice(0, 1);

    // Get 5 random non-sale products
    const shuffledNonSale = [...nonSaleProducts].sort(
      () => Math.random() - 0.5,
    );
    const featuredNonSale = shuffledNonSale.slice(0, 5);

    // Combine: sale item first, then non-sale items
    const selectedProducts = [...featuredSale, ...featuredNonSale];

    // NOW attach photos only to the 6 selected products
    return await attachPhotosToProducts(selectedProducts);
  } catch (error) {
    trackError("Error fetching featured products", error, {
      service: "apiService",
      function: "getFeaturedProducts",
    });
    return [];
  }
};

// Get sale products (products with Customer category discounts from SpecialOffer table)
export const getSaleProducts = async (
  cultureId: string = "en",
): Promise<Product[]> => {
  try {
    // Load products WITHOUT photos first, with discount descriptions in the given culture
    const products = await getProducts(false, cultureId);

    // Filter to only products with discounts
    const saleProducts = products.filter(
      (p) => p.DiscountPct && p.DiscountPct > 0,
    );

    // NOW attach photos only to the sale products
    return await attachPhotosToProducts(saleProducts);
  } catch (error) {
    trackError("Error fetching sale products", error, {
      service: "apiService",
      function: "getSaleProducts",
    });
    throw error; // Re-throw to let React Query handle it
  }
};

// Export arrays for backwards compatibility (these will be loaded asynchronously)
export let categories: ProductCategory[] = [];
export let subcategories: ProductSubcategory[] = [];
export let products: Product[] = [];

// Initialize data on module load (default culture "en" for categories/subcategories)
(async () => {
  try {
    [categories, subcategories, products] = await Promise.all([
      getCategories("en"),
      getSubcategories("en"),
      getProducts(),
    ]);
  } catch (error) {
    trackError("Error initializing data", error, {
      service: "apiService",
      context: "moduleInitialization",
    });
  }
})();

// Shopping Cart API Functions
import {
  GET_SHOPPING_CART_ITEMS,
  CREATE_CART_ITEM,
  UPDATE_CART_ITEM,
  DELETE_CART_ITEM,
} from "@/lib/graphql-queries";
import { ShoppingCartItem } from "@/types/product";

interface ShoppingCartItemsResponse {
  shoppingCartItems: GraphQLResponse<ShoppingCartItem>;
}

interface CreateCartItemResponse {
  createShoppingCartItem: ShoppingCartItem;
}

interface UpdateCartItemResponse {
  updateShoppingCartItem: ShoppingCartItem;
}

interface DeleteCartItemResponse {
  deleteShoppingCartItem: { ShoppingCartItemID: number };
}

// Get shopping cart items for a user
export const getShoppingCartItems = async (
  shoppingCartId: string,
): Promise<ShoppingCartItem[]> => {
  try {
    const data = await graphqlClient.request<ShoppingCartItemsResponse>(
      GET_SHOPPING_CART_ITEMS,
      { shoppingCartId },
    );
    return data.shoppingCartItems.items;
  } catch (error) {
    trackError("Error fetching shopping cart items", error, {
      service: "apiService",
      function: "getShoppingCartItems",
    });
    return [];
  }
};

// Create a new shopping cart item
export const createCartItem = async (
  shoppingCartId: string,
  productId: number,
  quantity: number,
): Promise<ShoppingCartItem | null> => {
  try {
    // Use REST API instead of GraphQL to avoid DateTime default value issues
    const restApiUrl = getRestApiUrl();

    const response = await fetch(`${restApiUrl}/ShoppingCartItem`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ShoppingCartID: shoppingCartId,
        ProductID: productId,
        Quantity: quantity,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    // REST API returns { value: [...] }
    return data.value && data.value.length > 0 ? data.value[0] : null;
  } catch (error) {
    trackError("Error creating cart item", error, {
      service: "apiService",
      function: "createCartItem",
      productId: productId,
    });
    return null;
  }
};

// Update cart item quantity
export const updateCartItemQuantity = async (
  shoppingCartItemId: number,
  quantity: number,
): Promise<ShoppingCartItem | null> => {
  try {
    const data = await graphqlClient.request<UpdateCartItemResponse>(
      UPDATE_CART_ITEM,
      {
        shoppingCartItemId,
        item: {
          Quantity: quantity,
        },
      },
    );
    return data.updateShoppingCartItem;
  } catch (error) {
    trackError("Error updating cart item", error, {
      service: "apiService",
      function: "updateCartItemQuantity",
      shoppingCartItemId: shoppingCartItemId,
    });
    return null;
  }
};

// Delete a cart item
export const deleteCartItem = async (
  shoppingCartItemId: number,
): Promise<boolean> => {
  try {
    await graphqlClient.request<DeleteCartItemResponse>(DELETE_CART_ITEM, {
      shoppingCartItemId,
    });
    return true;
  } catch (error) {
    trackError("Error deleting cart item", error, {
      service: "apiService",
      function: "deleteCartItem",
      shoppingCartItemId: shoppingCartItemId,
    });
    return false;
  }
};

// Delete all cart items for a user
export const clearShoppingCart = async (
  shoppingCartId: string,
): Promise<boolean> => {
  try {
    const items = await getShoppingCartItems(shoppingCartId);
    await Promise.all(
      items.map((item) => deleteCartItem(item.ShoppingCartItemID)),
    );
    return true;
  } catch (error) {
    trackError("Error clearing shopping cart", error, {
      service: "apiService",
      function: "clearShoppingCart",
    });
    return false;
  }
};

// Fetch a single large photo on-demand (for fullscreen view)
// This avoids OutOfMemoryException by loading large photos only when needed
export const getLargePhoto = async (
  photoId: number,
): Promise<{ LargePhoto?: string; LargePhotoFileName?: string } | null> => {
  try {
    const data = await graphqlClient.request<{
      productPhotos: { items: ProductPhoto[] };
    }>(GET_LARGE_PHOTO, { photoId });

    const photo = data.productPhotos.items[0];
    if (!photo) return null;

    return {
      LargePhoto: photo.LargePhoto,
      LargePhotoFileName: photo.LargePhotoFileName,
    };
  } catch (error) {
    trackError("Error fetching large photo", error, {
      service: "apiService",
      function: "getLargePhoto",
      photoId: photoId,
    });
    return null;
  }
};
