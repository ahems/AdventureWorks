// ── Product lookup tables derived from live AdventureWorks database data ──────

export const PRODUCT_COLORS = [
  "Black",
  "Blue",
  "Grey",
  "Multi",
  "Red",
  "Silver",
  "Silver/Black",
  "White",
  "Yellow",
];

export const PRODUCT_LINES: { value: string; label: string }[] = [
  { value: "M", label: "Mountain" },
  { value: "R", label: "Road" },
  { value: "S", label: "Specialty / Sport" },
  { value: "T", label: "Touring" },
];

export const PRODUCT_CLASSES: { value: string; label: string }[] = [
  { value: "H", label: "High-end (HL)" },
  { value: "M", label: "Mid-range (ML)" },
  { value: "L", label: "Entry-level (LL)" },
];

export const PRODUCT_STYLES: { value: string; label: string }[] = [
  { value: "U", label: "Universal" },
  { value: "M", label: "Men's" },
  { value: "W", label: "Women's" },
];

export const PRODUCT_SIZES = [
  "XS",
  "S",
  "M",
  "L",
  "XL",
  "38",
  "40",
  "42",
  "44",
  "46",
  "48",
  "50",
  "52",
  "54",
  "56",
  "58",
  "60",
  "62",
  "70",
];

/** Ordered index of sizes for cost escalation (5% bump per step). */
export const PRODUCT_SIZE_INDEX: Record<string, number> = Object.fromEntries(
  PRODUCT_SIZES.map((s, i) => [s, i]),
);
