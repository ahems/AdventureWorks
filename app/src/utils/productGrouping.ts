import { Product, ProductModelGroup } from "@/types/product";

/**
 * Groups products by their ProductModelID
 * Products without a ProductModelID are returned as individual groups
 */
export const groupProductsByModel = (
  products: Product[]
): (ProductModelGroup | Product)[] => {
  // Separate products with and without models
  const productsWithModels = products.filter(
    (p) => p.ProductModelID !== null && p.ProductModelID !== undefined
  );
  const productsWithoutModels = products.filter(
    (p) => p.ProductModelID === null || p.ProductModelID === undefined
  );

  // Group products by ProductModelID
  const modelGroups = new Map<number, Product[]>();

  productsWithModels.forEach((product) => {
    const modelId = product.ProductModelID!;
    if (!modelGroups.has(modelId)) {
      modelGroups.set(modelId, []);
    }
    modelGroups.get(modelId)!.push(product);
  });

  // Convert to ProductModelGroup array
  const groupedProducts: ProductModelGroup[] = Array.from(
    modelGroups.entries()
  ).map(([modelId, variants]) => {
    // Sort variants to ensure consistent base product selection
    const sortedVariants = [...variants].sort(
      (a, b) => a.ProductID - b.ProductID
    );
    const baseProduct = sortedVariants[0];

    // Extract unique colors and sizes
    const colors = [
      ...new Set(
        variants.map((v) => v.Color).filter((c): c is string => c !== null)
      ),
    ];
    const sizes = [
      ...new Set(
        variants.map((v) => v.Size).filter((s): s is string => s !== null)
      ),
    ];

    // Calculate price range
    const prices = variants.map((v) => v.ListPrice);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);

    // Extract model name (remove size and color suffixes)
    // E.g., "Mountain-100 Silver, 38" -> "Mountain-100"
    const modelName = extractModelName(baseProduct.Name);

    return {
      ProductModelID: modelId,
      modelName,
      baseProduct,
      variants: sortedVariants,
      colors: colors.sort(),
      sizes: sizes.sort(sizeComparator),
      priceRange: {
        min: minPrice,
        max: maxPrice,
      },
    };
  });

  // Combine grouped products with individual products (no model)
  // Return as mixed array for rendering
  return [...groupedProducts, ...productsWithoutModels];
};

/**
 * Extracts the base model name from a product name
 * E.g., "Mountain-100 Silver, 38" -> "Mountain-100"
 * E.g., "Full-Finger Gloves, S" -> "Full-Finger Gloves"
 */
const extractModelName = (productName: string): string => {
  // Remove patterns like ", 38", " Silver,", " Black," etc.
  // This regex removes comma and everything after it, or removes color followed by comma
  return productName
    .replace(/\s+(Black|Silver|Red|Blue|Yellow|Multi|White),?\s*.*$/i, "")
    .replace(/,\s*\w+$/, "")
    .trim();
};

/**
 * Custom comparator for sorting sizes
 * Handles numeric sizes (38, 42) and text sizes (S, M, L, XL)
 */
const sizeComparator = (a: string, b: string): number => {
  // Try to parse as numbers first
  const numA = parseFloat(a);
  const numB = parseFloat(b);

  if (!isNaN(numA) && !isNaN(numB)) {
    return numA - numB;
  }

  // Use predefined order for text sizes
  const sizeOrder: Record<string, number> = {
    XS: 1,
    S: 2,
    M: 3,
    L: 4,
    XL: 5,
    XXL: 6,
  };

  const orderA = sizeOrder[a.toUpperCase()] ?? 999;
  const orderB = sizeOrder[b.toUpperCase()] ?? 999;

  if (orderA !== orderB) {
    return orderA - orderB;
  }

  // Fallback to alphabetical
  return a.localeCompare(b);
};

/**
 * Checks if an item is a ProductModelGroup
 */
export const isProductModelGroup = (
  item: ProductModelGroup | Product
): item is ProductModelGroup => {
  return "variants" in item;
};

/**
 * Gets the appropriate product to display based on selected variants
 */
export const getProductVariant = (
  group: ProductModelGroup,
  selectedColor?: string,
  selectedSize?: string
): Product => {
  // If no selections, return base product
  if (!selectedColor && !selectedSize) {
    return group.baseProduct;
  }

  // Find exact match
  const exactMatch = group.variants.find((v) => {
    const colorMatch = !selectedColor || v.Color === selectedColor;
    const sizeMatch = !selectedSize || v.Size === selectedSize;
    return colorMatch && sizeMatch;
  });

  if (exactMatch) {
    return exactMatch;
  }

  // Find partial match (only color or only size)
  const partialMatch = group.variants.find((v) => {
    if (selectedColor && v.Color === selectedColor) return true;
    if (selectedSize && v.Size === selectedSize) return true;
    return false;
  });

  return partialMatch || group.baseProduct;
};
