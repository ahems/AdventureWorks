import { graphqlClient } from "@/lib/graphql-client";
import { getRestApiUrl } from "@/lib/utils";
import {
  GET_CATEGORIES,
  GET_SUBCATEGORIES,
  GET_SUBCATEGORIES_BY_CATEGORY,
  GET_PRODUCTS,
  GET_PRODUCT_BY_ID,
  GET_PRODUCTS_BY_SUBCATEGORY,
  GET_PRODUCTS_BY_SUBCATEGORY_IDS,
  GET_CATEGORY_BY_ID,
  GET_SUBCATEGORY_BY_ID,
  GET_PRODUCT_PHOTOS_BATCH,
  GET_PHOTOS_BY_IDS,
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
    console.error("Error attaching descriptions to products:", error);
    return products;
  }
};

// Helper function to fetch and attach discounts to products
const attachDiscountsToProducts = async (
  products: Product[],
): Promise<Product[]> => {
  try {
    if (products.length === 0) return products;

    // Fetch all customer special offers
    const offersData = await graphqlClient.request<SpecialOffersResponse>(
      GET_CUSTOMER_SPECIAL_OFFERS,
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
    console.error("❌ [attachDiscountsToProducts] Error:", error);
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

    // Split into chunks of 20 to avoid memory issues with binary photo data
    const chunkSize = 20;
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
      const photoMappingsData =
        await graphqlClient.request<ProductPhotosResponse>(
          GET_PRODUCT_PHOTOS_BATCH,
          { productIds: chunk },
        );
      allPhotoMappings.push(...photoMappingsData.productProductPhotos.items);
    }

    if (allPhotoMappings.length === 0) return products;

    // Get unique photo IDs
    const photoIds = [
      ...new Set(allPhotoMappings.map((m) => m.ProductPhotoID)),
    ];

    // Fetch actual photo data (also in chunks if needed)
    const photoChunks: number[][] = [];
    for (let i = 0; i < photoIds.length; i += chunkSize) {
      photoChunks.push(photoIds.slice(i, i + chunkSize));
    }

    const allPhotos: ProductPhoto[] = [];
    for (const chunk of photoChunks) {
      const photoDataResponse = await graphqlClient.request<PhotoDataResponse>(
        GET_PHOTOS_BY_IDS,
        { photoIds: chunk },
      );
      allPhotos.push(...photoDataResponse.productPhotos.items);
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

    // Attach photos to products
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
    console.error("Error attaching photos to products:", error);
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
    console.error("❌ [attachInventoryToProducts] Error:", error);
    return products; // Return products without inventory on error
  }
};

// Helper function to add icon names to categories (since they're not in the database)
const addIconsToCategories = (
  categories: ProductCategory[],
): ProductCategory[] => {
  const iconMap: Record<string, string> = {
    Bikes: "bike",
    Components: "cog",
    Clothing: "shirt",
    Accessories: "backpack",
  };

  return categories.map((cat) => ({
    ...cat,
    IconName: iconMap[cat.Name] || "box",
  }));
};

// Fetch all categories
export const getCategories = async (): Promise<ProductCategory[]> => {
  try {
    const data =
      await graphqlClient.request<CategoriesResponse>(GET_CATEGORIES);
    return addIconsToCategories(data.productCategories.items);
  } catch (error) {
    console.error("Error fetching categories:", error);
    return [];
  }
};

// Fetch all subcategories
export const getSubcategories = async (): Promise<ProductSubcategory[]> => {
  try {
    const data =
      await graphqlClient.request<SubcategoriesResponse>(GET_SUBCATEGORIES);
    return data.productSubcategories.items;
  } catch (error) {
    console.error("Error fetching subcategories:", error);
    return [];
  }
};

// Fetch subcategories by category ID
export const getSubcategoriesByCategory = async (
  categoryId: number,
): Promise<ProductSubcategory[]> => {
  try {
    const data = await graphqlClient.request<SubcategoriesResponse>(
      GET_SUBCATEGORIES_BY_CATEGORY,
      { categoryId },
    );
    return data.productSubcategories.items;
  } catch (error) {
    console.error("Error fetching subcategories by category:", error);
    return [];
  }
};

// Fetch all products (with optional photo fetching)
export const getProducts = async (
  includePhotos: boolean = false,
): Promise<Product[]> => {
  try {
    const data = await graphqlClient.request<ProductsResponse>(GET_PRODUCTS);
    let products = data.products.items;

    // Always attach discounts and inventory
    products = await attachDiscountsToProducts(products);
    products = await attachInventoryToProducts(products);

    if (includePhotos) {
      return await attachPhotosToProducts(products);
    }
    return products;
  } catch (error) {
    console.error("Error fetching products:", error);
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
    );
    const productsWithInventory = await attachInventoryToProducts(
      productsWithDescriptions,
    );
    return productsWithInventory[0];
  } catch (error) {
    console.error("Error fetching product by ID:", error);
    return undefined;
  }
};

// Fetch products by subcategory ID
export const getProductsBySubcategory = async (
  subcategoryId: number,
): Promise<Product[]> => {
  try {
    const data = await graphqlClient.request<ProductsResponse>(
      GET_PRODUCTS_BY_SUBCATEGORY,
      { subcategoryId },
    );
    let products = data.products.items;
    products = await attachDiscountsToProducts(products);
    products = await attachInventoryToProducts(products);
    return await attachPhotosToProducts(products);
  } catch (error) {
    console.error("Error fetching products by subcategory:", error);
    return [];
  }
};

// Fetch products by category ID (needs to get subcategories first)
export const getProductsByCategory = async (
  categoryId: number,
): Promise<Product[]> => {
  try {
    // First, get all subcategory IDs for this category
    const subcategories = await getSubcategoriesByCategory(categoryId);
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
    products = await attachDiscountsToProducts(products);
    products = await attachInventoryToProducts(products);
    return await attachPhotosToProducts(products);
  } catch (error) {
    console.error("Error fetching products by category:", error);
    console.error("Error details:", error);
    return [];
  }
};

// Fetch category by ID
export const getCategoryById = async (
  categoryId: number,
): Promise<ProductCategory | undefined> => {
  try {
    const data = await graphqlClient.request<CategoriesResponse>(
      GET_CATEGORY_BY_ID,
      { id: categoryId },
    );
    const categories = addIconsToCategories(data.productCategories.items);
    return categories[0];
  } catch (error) {
    console.error("Error fetching category by ID:", error);
    return undefined;
  }
};

// Fetch subcategory by ID
export const getSubcategoryById = async (
  subcategoryId: number,
): Promise<ProductSubcategory | undefined> => {
  try {
    const data = await graphqlClient.request<SubcategoriesResponse>(
      GET_SUBCATEGORY_BY_ID,
      { id: subcategoryId },
    );
    return data.productSubcategories.items[0];
  } catch (error) {
    console.error("Error fetching subcategory by ID:", error);
    return undefined;
  }
};

// Get featured products (first 6 products with photos)
export const getFeaturedProducts = async (): Promise<Product[]> => {
  try {
    // Load products WITHOUT photos first for better performance
    const products = await getProducts(false);
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
    console.error("Error fetching featured products:", error);
    return [];
  }
};

// Get sale products (products with Customer category discounts from SpecialOffer table)
export const getSaleProducts = async (): Promise<Product[]> => {
  try {
    // Load products WITHOUT photos first for better performance
    const products = await getProducts(false);

    // Filter to only products with discounts
    const saleProducts = products.filter(
      (p) => p.DiscountPct && p.DiscountPct > 0,
    );

    // NOW attach photos only to the sale products
    return await attachPhotosToProducts(saleProducts);
  } catch (error) {
    console.error("❌ [getSaleProducts] Error:", error);
    throw error; // Re-throw to let React Query handle it
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
    console.error("Error initializing data:", error);
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
    console.error("Error fetching shopping cart items:", error);
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
    console.error("Error creating cart item:", error);
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
    console.error("Error updating cart item:", error);
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
    console.error("Error deleting cart item:", error);
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
    console.error("Error clearing shopping cart:", error);
    return false;
  }
};
