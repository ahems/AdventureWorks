import {
  Product,
  ProductModelGroup,
  isProductModelGroup,
} from "@/types/product";

export { isProductModelGroup };

/**
 * Groups products by ProductModelID. Products with no model are returned
 * individually. Result is sorted: groups first (by group name), then singles.
 */
export const groupProductsByModel = (
  products: Product[],
): (ProductModelGroup | Product)[] => {
  const withModel = products.filter((p) => p.ProductModelID != null);
  const withoutModel = products.filter((p) => p.ProductModelID == null);

  const modelMap = new Map<number, Product[]>();
  for (const p of withModel) {
    const id = p.ProductModelID!;
    if (!modelMap.has(id)) modelMap.set(id, []);
    modelMap.get(id)!.push(p);
  }

  const groups: ProductModelGroup[] = Array.from(modelMap.entries()).map(
    ([modelId, variants]) => {
      const sorted = [...variants].sort((a, b) => a.ProductID - b.ProductID);
      const base = sorted[0];
      const colors = [
        ...new Set(
          variants.map((v) => v.Color).filter((c): c is string => c != null),
        ),
      ].sort();
      const sizes = [
        ...new Set(
          variants.map((v) => v.Size).filter((s): s is string => s != null),
        ),
      ].sort(sizeComparator);
      const prices = variants.map((v) => v.ListPrice);
      return {
        ProductModelID: modelId,
        modelName: extractModelName(base.Name),
        baseProduct: base,
        variants: sorted,
        colors,
        sizes,
        priceRange: { min: Math.min(...prices), max: Math.max(...prices) },
      };
    },
  );

  return [...groups, ...withoutModel];
};

const extractModelName = (name: string): string =>
  name
    .replace(
      /\s+(Black|Silver|Red|Blue|Yellow|Multi|White|Gold|Green|Grey|Pink|Purple|Orange),?\s*.*$/i,
      "",
    )
    .replace(/,\s*\w+$/, "")
    .trim();

const sizeComparator = (a: string, b: string): number => {
  const numA = parseFloat(a);
  const numB = parseFloat(b);
  if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
  const order: Record<string, number> = {
    XS: 1,
    S: 2,
    M: 3,
    L: 4,
    XL: 5,
    XXL: 6,
  };
  const oA = order[a.toUpperCase()] ?? 999;
  const oB = order[b.toUpperCase()] ?? 999;
  return oA !== oB ? oA - oB : a.localeCompare(b);
};
