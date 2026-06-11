import { PRODUCT_SIZE_INDEX } from "./product-constants";

export interface VariationConfig {
  /** Base product fields */
  baseName: string;
  baseStandardCost: number;
  baseListPrice: number;
  productSubcategoryID: number;
  description: string;
  weight: number | null;
  productLine: string | null;
  class_: string | null;
  baseStyle: string | null;
  initialQuantity: number;

  /** Variation dimensions */
  colors: string[];
  sizes: string[];
  styles: string[]; // empty → use baseStyle only
}

export interface VariationRow {
  Name: string;
  ProductNumber: string;
  StandardCost: number;
  ListPrice: number;
  ProductSubcategoryID: number;
  Color: string | null;
  Size: string | null;
  Weight: number | null;
  ProductLine: string | null;
  Class: string | null;
  Style: string | null;
  InitialQuantity: number;
  Description?: string;
}

/** Generate a short GUID-derived SKU safe for the 25-char DB column. */
const generateSku = (): string => {
  const hex = () =>
    Math.floor(Math.random() * 0x10000)
      .toString(16)
      .toUpperCase()
      .padStart(4, "0");
  return `${hex()}-${hex()}-${hex()}`;
};

/**
 * Generate the cartesian product of selected variation dimensions.
 *
 * Cost escalation: StandardCost increases by 5% for each size step
 * relative to the smallest selected size. ListPrice is always 120% of
 * the resulting StandardCost.
 */
export function generateVariations(config: VariationConfig): VariationRow[] {
  const {
    baseName,
    baseStandardCost,
    productSubcategoryID,
    weight,
    productLine,
    class_,
    baseStyle,
    initialQuantity,
    colors,
    sizes,
    styles,
  } = config;

  const effectiveColors = colors.length > 0 ? colors : [null];
  const effectiveSizes = sizes.length > 0 ? sizes : [null];
  const effectiveStyles =
    styles.length > 0 ? styles.map((s) => s) : [baseStyle];

  // Find the minimum size index among selected sizes for relative escalation
  const sizeIndices = sizes.map((s) => PRODUCT_SIZE_INDEX[s] ?? 0);
  const minSizeIndex = sizeIndices.length > 0 ? Math.min(...sizeIndices) : 0;

  const rows: VariationRow[] = [];

  for (const color of effectiveColors) {
    for (const size of effectiveSizes) {
      for (const style of effectiveStyles) {
        const sizeIdx = size != null ? (PRODUCT_SIZE_INDEX[size] ?? 0) : 0;
        const sizeStep = size != null ? sizeIdx - minSizeIndex : 0;
        const cost = +(baseStandardCost * (1 + 0.05 * sizeStep)).toFixed(2);
        const price = +(cost * 1.2).toFixed(2);

        rows.push({
          Name: baseName,
          ProductNumber: generateSku(),
          StandardCost: cost,
          ListPrice: price,
          ProductSubcategoryID: productSubcategoryID,
          Color: color,
          Size: size,
          Weight: weight,
          ProductLine: productLine,
          Class: class_,
          Style: style,
          InitialQuantity: initialQuantity,
          Description: config.description || undefined,
        });
      }
    }
  }

  return rows;
}
