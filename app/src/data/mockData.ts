import { Product, ProductCategory, ProductSubcategory } from "@/types/product";

export const categories: ProductCategory[] = [
  { ProductCategoryID: 1, Name: "Bikes", IconName: "bike" },
  { ProductCategoryID: 2, Name: "Components", IconName: "cog" },
  { ProductCategoryID: 3, Name: "Clothing", IconName: "shirt" },
  { ProductCategoryID: 4, Name: "Accessories", IconName: "backpack" },
];

export const subcategories: ProductSubcategory[] = [
  { ProductSubcategoryID: 1, ProductCategoryID: 1, Name: "Mountain Bikes" },
  { ProductSubcategoryID: 2, ProductCategoryID: 1, Name: "Road Bikes" },
  { ProductSubcategoryID: 3, ProductCategoryID: 1, Name: "Touring Bikes" },
  { ProductSubcategoryID: 4, ProductCategoryID: 2, Name: "Handlebars" },
  { ProductSubcategoryID: 5, ProductCategoryID: 2, Name: "Wheels" },
  { ProductSubcategoryID: 6, ProductCategoryID: 2, Name: "Pedals" },
  { ProductSubcategoryID: 7, ProductCategoryID: 2, Name: "Frames" },
  { ProductSubcategoryID: 8, ProductCategoryID: 3, Name: "Jerseys" },
  { ProductSubcategoryID: 9, ProductCategoryID: 3, Name: "Shorts" },
  { ProductSubcategoryID: 10, ProductCategoryID: 3, Name: "Gloves" },
  { ProductSubcategoryID: 11, ProductCategoryID: 4, Name: "Helmets" },
  { ProductSubcategoryID: 12, ProductCategoryID: 4, Name: "Bottles & Cages" },
  { ProductSubcategoryID: 13, ProductCategoryID: 4, Name: "Bike Racks" },
];

export const products: Product[] = [
  // Bikes - Road
  {
    ProductID: 749,
    Name: "Road-150",
    ProductNumber: "BK-R93R",
    Color: null,
    ListPrice: 3578.27,
    Size: null,
    Weight: 13.77,
    ProductSubcategoryID: 2,
    ProductModelID: 25,
    Description: "Top-of-the-line aluminum frame makes every ride an adventure. Perfect for serious cyclists who demand performance.",
    ImageUrl: "/placeholder.svg",
    salePercent: 15,
    availableSizes: ["44", "48", "52", "56", "62"],
    availableColors: ["Red", "Black", "White"],
    unavailableVariants: [
      { size: "44", color: "White" },
      { size: "62", color: "Red" },
      { size: "52", color: "Black" }
    ]
  },
  // Bikes - Mountain
  {
    ProductID: 751,
    Name: "Mountain-100",
    ProductNumber: "BK-M82",
    Color: null,
    ListPrice: 3399.99,
    Size: null,
    Weight: 20.35,
    ProductSubcategoryID: 1,
    ProductModelID: 19,
    Description: "Our top-of-the-line competition mountain bike. Performance-enhancing options include front suspension and target derailleur.",
    ImageUrl: "/placeholder.svg",
    salePercent: 20,
    availableSizes: ["38", "42", "46", "48"],
    availableColors: ["Silver", "Black", "Blue"]
  },
  // Bikes - Touring
  {
    ProductID: 753,
    Name: "Touring-1000",
    ProductNumber: "BK-T79U",
    Color: null,
    ListPrice: 2384.07,
    Size: null,
    Weight: 25.13,
    ProductSubcategoryID: 3,
    ProductModelID: 18,
    Description: "Perfect for long-distance adventures. Comfortable geometry and reliable components for endless exploration.",
    ImageUrl: "/placeholder.svg",
    availableSizes: ["46", "50", "54", "58"],
    availableColors: ["Blue", "Green", "Black"]
  },
  {
    ProductID: 754,
    Name: "Touring-2000",
    ProductNumber: "BK-T44U",
    Color: null,
    ListPrice: 1214.85,
    Size: null,
    Weight: 27.90,
    ProductSubcategoryID: 3,
    ProductModelID: 17,
    Description: "Entry-level touring bike with all the essentials for comfortable long rides.",
    ImageUrl: "/placeholder.svg",
    availableSizes: ["46", "50", "54", "58"],
    availableColors: ["Blue", "Red"]
  },
  // Components
  {
    ProductID: 801,
    Name: "HL Mountain Handlebars",
    ProductNumber: "HB-M918",
    Color: null,
    ListPrice: 120.27,
    Size: null,
    Weight: 0.68,
    ProductSubcategoryID: 4,
    ProductModelID: 45,
    Description: "Lightweight aluminum handlebars designed for aggressive mountain biking.",
    ImageUrl: "/placeholder.svg"
  },
  {
    ProductID: 802,
    Name: "ML Road Frame",
    ProductNumber: "FR-R72R",
    Color: null,
    ListPrice: 594.83,
    Size: null,
    Weight: 2.72,
    ProductSubcategoryID: 7,
    ProductModelID: 16,
    Description: "Mid-level road frame with excellent weight-to-strength ratio.",
    ImageUrl: "/placeholder.svg",
    availableSizes: ["52", "56", "58", "60"],
    availableColors: ["Red", "Black"]
  },
  {
    ProductID: 803,
    Name: "HL Road Pedal",
    ProductNumber: "PD-R563",
    Color: "Silver/Black",
    ListPrice: 80.99,
    Size: null,
    Weight: 0.34,
    ProductSubcategoryID: 6,
    ProductModelID: 52,
    Description: "Professional-grade clipless pedals for maximum power transfer.",
    ImageUrl: "/placeholder.svg"
  },
  {
    ProductID: 804,
    Name: "Road-750 Wheels",
    ProductNumber: "WH-R750",
    Color: null,
    ListPrice: 539.99,
    Size: null,
    Weight: 1.88,
    ProductSubcategoryID: 5,
    ProductModelID: 36,
    Description: "Aerodynamic wheelset for road racing. Tubeless-ready with ceramic bearings.",
    ImageUrl: "/placeholder.svg",
    availableColors: ["Black", "Silver"]
  },
  {
    ProductID: 850,
    Name: "Short-Sleeve Classic Jersey",
    ProductNumber: "SJ-0194",
    Color: null,
    ListPrice: 53.99,
    Size: null,
    Weight: 0.20,
    ProductSubcategoryID: 8,
    ProductModelID: 33,
    Description: "Breathable fabric keeps you cool on hot rides. Three rear pockets for essentials.",
    ImageUrl: "/placeholder.svg",
    salePercent: 25,
    availableSizes: ["S", "M", "L", "XL"],
    availableColors: ["Yellow", "Red", "Blue", "Black"],
    unavailableVariants: [
      { size: "S", color: "Yellow" },
      { size: "XL", color: "Blue" },
      { size: "M", color: "Red" }
    ]
  },
  {
    ProductID: 851,
    Name: "Long-Sleeve Logo Jersey",
    ProductNumber: "LJ-0192",
    Color: null,
    ListPrice: 49.99,
    Size: null,
    Weight: 0.25,
    ProductSubcategoryID: 8,
    ProductModelID: 34,
    Description: "Stylish long-sleeve jersey with Adventure Works logo. Perfect for cooler weather.",
    ImageUrl: "/placeholder.svg",
    availableSizes: ["S", "M", "L", "XL"],
    availableColors: ["Multi", "Black", "White"]
  },
  {
    ProductID: 852,
    Name: "Men's Bib-Shorts",
    ProductNumber: "SB-M891",
    Color: null,
    ListPrice: 89.99,
    Size: null,
    Weight: 0.28,
    ProductSubcategoryID: 9,
    ProductModelID: 35,
    Description: "Premium chamois padding for all-day comfort. Moisture-wicking fabric.",
    ImageUrl: "/placeholder.svg",
    availableSizes: ["S", "M", "L", "XL"],
    availableColors: ["Black", "Navy"]
  },
  {
    ProductID: 853,
    Name: "Half-Finger Gloves",
    ProductNumber: "GL-H102",
    Color: null,
    ListPrice: 24.49,
    Size: null,
    Weight: 0.08,
    ProductSubcategoryID: 10,
    ProductModelID: 37,
    Description: "Gel-padded palms reduce vibration. Breathable mesh back.",
    ImageUrl: "/placeholder.svg",
    availableSizes: ["S", "M", "L", "XL"],
    availableColors: ["Black", "Gray", "Red"]
  },
  // Accessories
  {
    ProductID: 900,
    Name: "Sport-100 Helmet",
    ProductNumber: "HL-U509",
    Color: null,
    ListPrice: 34.99,
    Size: null,
    Weight: 0.32,
    ProductSubcategoryID: 11,
    ProductModelID: 40,
    Description: "Lightweight protection with excellent ventilation. CPSC certified. Adjustable fit system.",
    ImageUrl: "/placeholder.svg",
    salePercent: 10,
    availableColors: ["Blue", "Red", "Black", "White"]
  },
  {
    ProductID: 902,
    Name: "Water Bottle - 30 oz.",
    ProductNumber: "WB-H098",
    Color: "Clear",
    ListPrice: 9.99,
    Size: null,
    Weight: 0.12,
    ProductSubcategoryID: 12,
    ProductModelID: 42,
    Description: "BPA-free bottle with easy-squeeze design. Dishwasher safe.",
    ImageUrl: "/placeholder.svg"
  },
  {
    ProductID: 903,
    Name: "Mountain Bottle Cage",
    ProductNumber: "BC-M005",
    Color: null,
    ListPrice: 9.99,
    Size: null,
    Weight: 0.05,
    ProductSubcategoryID: 12,
    ProductModelID: 43,
    Description: "Lightweight aluminum cage with secure grip. Fits standard bottles.",
    ImageUrl: "/placeholder.svg",
    availableColors: ["Black", "Silver", "Red"]
  },
  {
    ProductID: 904,
    Name: "Hitch Rack - 4-Bike",
    ProductNumber: "RA-H123",
    Color: "Black",
    ListPrice: 120.00,
    Size: null,
    Weight: 12.50,
    ProductSubcategoryID: 13,
    ProductModelID: 44,
    Description: "Carry up to 4 bikes securely. Fits 2-inch receiver hitches.",
    ImageUrl: "/placeholder.svg"
  },
];

export const getProductsByCategory = (categoryId: number): Product[] => {
  const subcategoryIds = subcategories
    .filter(s => s.ProductCategoryID === categoryId)
    .map(s => s.ProductSubcategoryID);
  return products.filter(p => p.ProductSubcategoryID && subcategoryIds.includes(p.ProductSubcategoryID));
};

export const getProductsBySubcategory = (subcategoryId: number): Product[] => {
  return products.filter(p => p.ProductSubcategoryID === subcategoryId);
};

export const getProductById = (productId: number): Product | undefined => {
  return products.find(p => p.ProductID === productId);
};

export const getFeaturedProducts = (): Product[] => {
  return products.slice(0, 6);
};

export const getCategoryById = (categoryId: number): ProductCategory | undefined => {
  return categories.find(c => c.ProductCategoryID === categoryId);
};

export const getSubcategoryById = (subcategoryId: number): ProductSubcategory | undefined => {
  return subcategories.find(s => s.ProductSubcategoryID === subcategoryId);
};

export const getSubcategoriesByCategory = (categoryId: number): ProductSubcategory[] => {
  return subcategories.filter(s => s.ProductCategoryID === categoryId);
};

export const getSaleProducts = (): Product[] => {
  return products.filter(p => p.salePercent && p.salePercent > 0);
};
