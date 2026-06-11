import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { graphqlClient } from "@/lib/graphql-client";
import { gql } from "graphql-request";
import { Product, ProductCategory, ProductSubcategory } from "@/types/product";

// ─── Queries ──────────────────────────────────────────────────────────────────

const GET_CATEGORIES_ADMIN = gql`
  query GetCategoriesAdmin {
    productCategories(filter: { CultureID: { eq: "en" } }) {
      items {
        ProductCategoryID
        Name
      }
    }
  }
`;

const GET_CATEGORY_BY_ID_ADMIN = gql`
  query GetCategoryByIdAdmin($id: Int!) {
    productCategories(
      filter: {
        and: [{ ProductCategoryID: { eq: $id } }, { CultureID: { eq: "en" } }]
      }
    ) {
      items {
        ProductCategoryID
        Name
      }
    }
  }
`;

const GET_SUBCATEGORIES_BY_CATEGORY_ADMIN = gql`
  query GetSubcategoriesByCategoryAdmin($categoryId: Int!) {
    productSubcategories(
      filter: {
        and: [
          { ProductCategoryID: { eq: $categoryId } }
          { CultureID: { eq: "en" } }
        ]
      }
    ) {
      items {
        ProductSubcategoryID
        ProductCategoryID
        Name
      }
    }
  }
`;

const GET_PRODUCTS_BY_CATEGORY_ADMIN = gql`
  query GetProductsByCategoryAdmin($subcategoryIds: [Int!]!) {
    products(
      first: 1000
      filter: {
        and: [
          { FinishedGoodsFlag: { eq: true } }
          { ProductSubcategoryID: { in: $subcategoryIds } }
        ]
      }
    ) {
      items {
        ProductID
        Name
        ProductNumber
        Color
        ListPrice
        StandardCost
        Size
        Weight
        ProductSubcategoryID
        ProductModelID
        SellStartDate
        SellEndDate
        DiscontinuedDate
      }
    }
  }
`;

const GET_PRODUCTS_BY_SUBCATEGORY_ADMIN = gql`
  query GetProductsBySubcategoryAdmin($subcategoryId: Int!) {
    products(
      first: 1000
      filter: {
        and: [
          { FinishedGoodsFlag: { eq: true } }
          { ProductSubcategoryID: { eq: $subcategoryId } }
        ]
      }
    ) {
      items {
        ProductID
        Name
        ProductNumber
        Color
        ListPrice
        StandardCost
        Size
        Weight
        ProductSubcategoryID
        ProductModelID
        SellStartDate
        SellEndDate
        DiscontinuedDate
      }
    }
  }
`;

const GET_PRODUCT_BY_ID_ADMIN = gql`
  query GetProductByIdAdmin($id: Int!) {
    products(filter: { ProductID: { eq: $id } }) {
      items {
        ProductID
        Name
        ProductNumber
        Color
        ListPrice
        StandardCost
        Size
        Weight
        ProductLine
        Class
        Style
        ProductSubcategoryID
        ProductModelID
        SellStartDate
        SellEndDate
        DiscontinuedDate
      }
    }
  }
`;

const GET_ALL_PRODUCTS_ADMIN = gql`
  query GetAllProductsAdmin {
    products(first: 1000, filter: { FinishedGoodsFlag: { eq: true } }) {
      items {
        ProductID
        Name
        ProductNumber
        Color
        ListPrice
        StandardCost
        Size
        Weight
        ProductSubcategoryID
        ProductModelID
        SellStartDate
        SellEndDate
        DiscontinuedDate
      }
    }
  }
`;

// ─── Hooks ────────────────────────────────────────────────────────────────────

export const useAdminCategories = () =>
  useQuery<ProductCategory[]>({
    queryKey: ["admin", "categories"],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        productCategories?: { items: ProductCategory[] };
      }>(GET_CATEGORIES_ADMIN);
      return data.productCategories?.items ?? [];
    },
    staleTime: 10 * 60 * 1000,
  });

export const useAdminCategoryById = (categoryId: number) =>
  useQuery<ProductCategory | undefined>({
    queryKey: ["admin", "category", categoryId],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        productCategories?: { items: ProductCategory[] };
      }>(GET_CATEGORY_BY_ID_ADMIN, {
        id: categoryId,
      });
      return data.productCategories?.items?.[0];
    },
    enabled: !!categoryId,
    staleTime: 10 * 60 * 1000,
  });

export const useAdminSubcategoriesByCategory = (categoryId: number) =>
  useQuery<ProductSubcategory[]>({
    queryKey: ["admin", "subcategories", categoryId],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        productSubcategories?: { items: ProductSubcategory[] };
      }>(GET_SUBCATEGORIES_BY_CATEGORY_ADMIN, { categoryId });
      return data.productSubcategories?.items ?? [];
    },
    enabled: !!categoryId,
    staleTime: 10 * 60 * 1000,
  });

export const useAdminProductsBySubcategoryIds = (subcategoryIds: number[]) =>
  useQuery<Product[]>({
    queryKey: [
      "admin",
      "products",
      "subcategories",
      subcategoryIds.sort().join(","),
    ],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        products?: { items: Product[] };
      }>(GET_PRODUCTS_BY_CATEGORY_ADMIN, { subcategoryIds });
      return data.products?.items ?? [];
    },
    enabled: subcategoryIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });

export const useAdminProductsBySubcategory = (subcategoryId: number | null) =>
  useQuery<Product[]>({
    queryKey: ["admin", "products", "subcategory", subcategoryId],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        products?: { items: Product[] };
      }>(GET_PRODUCTS_BY_SUBCATEGORY_ADMIN, { subcategoryId });
      return data.products?.items ?? [];
    },
    enabled: !!subcategoryId,
    staleTime: 5 * 60 * 1000,
  });

export const useAdminProductById = (productId: number) =>
  useQuery<Product | undefined>({
    queryKey: ["admin", "product", productId],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        products?: { items: Product[] };
      }>(GET_PRODUCT_BY_ID_ADMIN, {
        id: productId,
      });
      return data.products?.items?.[0] ?? undefined;
    },
    enabled: !!productId,
    staleTime: 5 * 60 * 1000,
  });

// Lightweight sibling product type for variation conflict detection
export interface SiblingProduct {
  ProductID: number;
  Name: string;
  ProductNumber: string;
  Color: string | null;
  Style: string | null;
  Size: string | null;
}

const GET_SIBLINGS_BY_MODEL = gql`
  query GetSiblingsByModel($modelId: Int!, $productId: Int!) {
    products(
      filter: {
        ProductModelID: { eq: $modelId }
        ProductID: { neq: $productId }
        FinishedGoodsFlag: { eq: true }
      }
      first: 500
    ) {
      items {
        ProductID
        Name
        ProductNumber
        Color
        Style
        Size
      }
    }
  }
`;

/** Returns all sibling products that share the same ProductModelID (ignoring the current product). */
export const useAdminSiblingProducts = (
  productModelId: number | null | undefined,
  currentProductId: number,
) =>
  useQuery<SiblingProduct[]>({
    queryKey: ["admin", "siblings", productModelId, currentProductId],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        products?: { items: SiblingProduct[] };
      }>(GET_SIBLINGS_BY_MODEL, {
        modelId: productModelId,
        productId: currentProductId,
      });
      return data.products?.items ?? [];
    },
    enabled: !!productModelId && !!currentProductId,
    staleTime: 2 * 60 * 1000,
  });

export const useAdminAllProducts = () =>
  useQuery<Product[]>({
    queryKey: ["admin", "products", "all"],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        products?: { items: Product[] };
      }>(GET_ALL_PRODUCTS_ADMIN);
      return data.products?.items ?? [];
    },
    staleTime: 5 * 60 * 1000,
  });

const GET_ALL_SUBCATEGORIES_ADMIN = gql`
  query GetAllSubcategoriesAdmin {
    productSubcategories(filter: { CultureID: { eq: "en" } }) {
      items {
        ProductSubcategoryID
        ProductCategoryID
        Name
      }
    }
  }
`;

export const useAdminAllSubcategories = () =>
  useQuery<ProductSubcategory[]>({
    queryKey: ["admin", "subcategories", "all"],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        productSubcategories?: { items: ProductSubcategory[] };
      }>(GET_ALL_SUBCATEGORIES_ADMIN);
      return data.productSubcategories?.items ?? [];
    },
    staleTime: 10 * 60 * 1000,
  });

// ─── ProductPhoto ─────────────────────────────────────────────────────────────

export interface ProductPhoto {
  ProductPhotoID: number;
  ThumbNailPhoto: string | null;
  ThumbnailPhotoFileName: string | null;
  LargePhoto: string | null;
  LargePhotoFileName: string | null;
  ModifiedDate: string;
}

// Fetch only thumbnails for all photos — avoids OOM from loading multiple large images at once
const GET_PRODUCT_PHOTOS = gql`
  query GetProductPhotos($productId: Int!) {
    productProductPhotos(filter: { ProductID: { eq: $productId } }) {
      items {
        ProductPhotoID
        ProductID
        Primary
        productPhoto {
          ProductPhotoID
          ThumbNailPhoto
          ThumbnailPhotoFileName
          LargePhotoFileName
          ModifiedDate
        }
      }
    }
  }
`;

// Separate query to lazily fetch just the large photo for the selected image
const GET_LARGE_PHOTO = gql`
  query GetLargePhoto($photoId: Int!) {
    productPhotos(filter: { ProductPhotoID: { eq: $photoId } }) {
      items {
        ProductPhotoID
        LargePhoto
      }
    }
  }
`;

export interface ProductPhotoRecord {
  ProductPhotoID: number;
  ProductID: number;
  Primary: boolean;
  productPhoto: ProductPhoto;
}

export const useProductPhotos = (productId: number) =>
  useQuery<ProductPhotoRecord[]>({
    queryKey: ["product", "photos", productId],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        productProductPhotos?: { items: ProductPhotoRecord[] };
      }>(GET_PRODUCT_PHOTOS, { productId });
      return data.productProductPhotos?.items ?? [];
    },
    enabled: !!productId,
    staleTime: 0,
  });

export const useProductLargePhoto = (photoId: number | null) =>
  useQuery<string | null>({
    queryKey: ["product", "photo", "large", photoId],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        productPhotos?: {
          items: Array<{ ProductPhotoID: number; LargePhoto: string | null }>;
        };
      }>(GET_LARGE_PHOTO, { photoId });
      return data.productPhotos?.items?.[0]?.LargePhoto ?? null;
    },
    enabled: !!photoId,
    staleTime: 5 * 60 * 1000,
  });

const CREATE_PRODUCT_PHOTO = gql`
  mutation CreateProductPhoto(
    $thumbNail: String
    $thumbFilename: String
    $largePhoto: String
    $largeFilename: String
    $modifiedDate: DateTime!
  ) {
    createProductPhoto(
      item: {
        ThumbNailPhoto: $thumbNail
        ThumbnailPhotoFileName: $thumbFilename
        LargePhoto: $largePhoto
        LargePhotoFileName: $largeFilename
        ModifiedDate: $modifiedDate
      }
    ) {
      ProductPhotoID
    }
  }
`;

const CREATE_PRODUCT_PRODUCT_PHOTO = gql`
  mutation CreateProductProductPhoto(
    $productId: Int!
    $photoId: Int!
    $primary: Boolean!
    $modifiedDate: DateTime!
  ) {
    createProductProductPhoto(
      item: {
        ProductID: $productId
        ProductPhotoID: $photoId
        Primary: $primary
        ModifiedDate: $modifiedDate
      }
    ) {
      ProductID
      ProductPhotoID
    }
  }
`;

const DELETE_PRODUCT_PRODUCT_PHOTO = gql`
  mutation DeleteProductProductPhoto($productId: Int!, $photoId: Int!) {
    deleteProductProductPhoto(ProductID: $productId, ProductPhotoID: $photoId) {
      ProductID
      ProductPhotoID
    }
  }
`;

interface CreatePhotoVars {
  productId: number;
  thumbNail: string;
  thumbFilename: string;
  largePhoto: string;
  largeFilename: string;
  primary?: boolean;
}

export const useAddProductPhoto = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: CreatePhotoVars) => {
      const modifiedDate = new Date().toISOString();

      // 1. Insert the photo record
      const photoResult = await graphqlClient.request<{
        createProductPhoto: { ProductPhotoID: number };
      }>(CREATE_PRODUCT_PHOTO, {
        thumbNail: vars.thumbNail,
        thumbFilename: vars.thumbFilename,
        largePhoto: vars.largePhoto,
        largeFilename: vars.largeFilename,
        modifiedDate,
      });
      const photoId = photoResult.createProductPhoto.ProductPhotoID;

      // 2. Link photo to product
      await graphqlClient.request(CREATE_PRODUCT_PRODUCT_PHOTO, {
        productId: vars.productId,
        photoId,
        primary: vars.primary ?? false,
        modifiedDate,
      });

      return photoId;
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({
        queryKey: ["product", "photos", vars.productId],
      });
    },
  });
};

export const useDeleteProductPhoto = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { productId: number; productPhotoId: number }) => {
      await graphqlClient.request(DELETE_PRODUCT_PRODUCT_PHOTO, {
        productId: vars.productId,
        photoId: vars.productPhotoId,
      });
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({
        queryKey: ["product", "photos", vars.productId],
      });
    },
  });
};

// ─── Batch Photo Fetch (for product lists) ────────────────────────────────────

const GET_PRODUCT_PHOTOS_BATCH = gql`
  query GetProductPhotosBatch($productIds: [Int!]!) {
    productProductPhotos(
      filter: {
        and: [{ ProductID: { in: $productIds } }, { Primary: { eq: true } }]
      }
    ) {
      items {
        ProductID
        productPhoto {
          ThumbNailPhoto
          ThumbnailPhotoFileName
        }
      }
    }
  }
`;

export const useAdminProductPhotoBatch = (productIds: number[]) =>
  useQuery<Map<number, string>>({
    queryKey: ["admin", "photos", "batch", [...productIds].sort().join(",")],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        productProductPhotos?: {
          items: Array<{
            ProductID: number;
            productPhoto: { ThumbNailPhoto: string | null } | null;
          }>;
        };
      }>(GET_PRODUCT_PHOTOS_BATCH, { productIds });
      const map = new Map<number, string>();
      for (const item of data.productProductPhotos?.items ?? []) {
        if (item.productPhoto?.ThumbNailPhoto) {
          map.set(
            item.ProductID,
            `data:image/jpeg;base64,${item.productPhoto.ThumbNailPhoto}`,
          );
        }
      }
      return map;
    },
    enabled: productIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });

// ─── English Product Description ─────────────────────────────────────────────

const GET_PRODUCT_DESCRIPTION_BY_MODEL = gql`
  query GetProductDescriptionByModel($modelId: Int!) {
    productModelProductDescriptionCultures(
      filter: {
        and: [{ ProductModelID: { eq: $modelId } }, { CultureID: { eq: "en" } }]
      }
    ) {
      items {
        ProductModelID
        ProductDescriptionID
        productDescription {
          ProductDescriptionID
          Description
        }
      }
    }
  }
`;

export interface EnglishDescriptionResult {
  productDescriptionId: number | null;
  description: string;
}

export const useAdminProductEnglishDescription = (
  productModelId: number | null,
) =>
  useQuery<EnglishDescriptionResult>({
    queryKey: ["admin", "description", "en", productModelId],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        productModelProductDescriptionCultures?: {
          items: Array<{
            ProductModelID: number;
            ProductDescriptionID: number;
            productDescription: {
              ProductDescriptionID: number;
              Description: string;
            } | null;
          }>;
        };
      }>(GET_PRODUCT_DESCRIPTION_BY_MODEL, { modelId: productModelId });
      const item = data.productModelProductDescriptionCultures?.items?.[0];
      return {
        productDescriptionId: item?.ProductDescriptionID ?? null,
        description: item?.productDescription?.Description ?? "",
      };
    },
    enabled: !!productModelId,
    staleTime: 5 * 60 * 1000,
  });

// ─── Update Product ───────────────────────────────────────────────────────────

const UPDATE_PRODUCT = gql`
  mutation UpdateProduct(
    $id: Int!
    $name: String!
    $listPrice: Decimal!
    $standardCost: Decimal!
    $color: String
    $size: String
    $weight: Decimal
    $productLine: String
    $class: String
    $style: String
    $productSubcategoryId: Int
    $productModelId: Int
    $modifiedDate: DateTime!
  ) {
    updateProduct(
      ProductID: $id
      item: {
        Name: $name
        ListPrice: $listPrice
        StandardCost: $standardCost
        Color: $color
        Size: $size
        Weight: $weight
        ProductLine: $productLine
        Class: $class
        Style: $style
        ProductSubcategoryID: $productSubcategoryId
        ProductModelID: $productModelId
        ModifiedDate: $modifiedDate
      }
    ) {
      ProductID
      Name
      ListPrice
      StandardCost
      Color
      Size
      Weight
      ProductLine
      Class
      Style
    }
  }
`;

export const useUpdateProduct = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      ProductID: number;
      Name: string;
      ListPrice: number;
      StandardCost: number;
      Color?: string | null;
      Size?: string | null;
      Weight?: number | null;
      ProductLine?: string | null;
      Class?: string | null;
      Style?: string | null;
      ProductSubcategoryID?: number | null;
      ProductModelID?: number | null;
    }) => {
      await graphqlClient.request(UPDATE_PRODUCT, {
        id: vars.ProductID,
        name: vars.Name,
        listPrice: vars.ListPrice,
        standardCost: vars.StandardCost,
        color: vars.Color ?? null,
        size: vars.Size ?? null,
        weight: vars.Weight ?? null,
        productLine: vars.ProductLine ?? null,
        class: vars.Class ?? null,
        style: vars.Style ?? null,
        productSubcategoryId: vars.ProductSubcategoryID ?? null,
        productModelId: vars.ProductModelID ?? null,
        modifiedDate: new Date().toISOString(),
      });
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({
        queryKey: ["admin", "product", vars.ProductID],
      });
      queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
    },
  });
};

// ─── Update Product Price ────────────────────────────────────────────────────

const UPDATE_PRODUCT_PRICE = gql`
  mutation UpdateProductPrice(
    $id: Int!
    $listPrice: Decimal!
    $modifiedDate: DateTime!
  ) {
    updateProduct(
      ProductID: $id
      item: { ListPrice: $listPrice, ModifiedDate: $modifiedDate }
    ) {
      ProductID
      ListPrice
    }
  }
`;

export const useUpdateProductPrice = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { ProductID: number; ListPrice: number }) => {
      await graphqlClient.request(UPDATE_PRODUCT_PRICE, {
        id: vars.ProductID,
        listPrice: vars.ListPrice,
        modifiedDate: new Date().toISOString(),
      });
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({
        queryKey: ["admin", "product", vars.ProductID],
      });
      queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
      queryClient.invalidateQueries({
        queryKey: ["reporting", "product-profitability-detail"],
      });
    },
  });
};

// ─── Discontinue Product ─────────────────────────────────────────────────────

const DISCONTINUE_PRODUCT = gql`
  mutation DiscontinueProduct(
    $id: Int!
    $discontinuedDate: DateTime
    $modifiedDate: DateTime!
  ) {
    updateProduct(
      ProductID: $id
      item: { DiscontinuedDate: $discontinuedDate, ModifiedDate: $modifiedDate }
    ) {
      ProductID
      DiscontinuedDate
    }
  }
`;

export const useDiscontinueProduct = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      ProductID: number;
      DiscontinuedDate: string | null;
    }) => {
      await graphqlClient.request(DISCONTINUE_PRODUCT, {
        id: vars.ProductID,
        discontinuedDate: vars.DiscontinuedDate,
        modifiedDate: new Date().toISOString(),
      });
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({
        queryKey: ["admin", "product", vars.ProductID],
      });
      queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
      queryClient.invalidateQueries({
        queryKey: ["reporting", "product-profitability-detail"],
      });
    },
  });
};

// ─── Create Product Model ────────────────────────────────────────────────────

const CREATE_PRODUCT_MODEL = gql`
  mutation CreateProductModel($name: String!, $modifiedDate: DateTime!) {
    createProductModel(item: { Name: $name, ModifiedDate: $modifiedDate }) {
      ProductModelID
    }
  }
`;

export const useCreateProductModel = () =>
  useMutation({
    mutationFn: async (vars: { name: string }) => {
      const data = await graphqlClient.request<{
        createProductModel: { ProductModelID: number };
      }>(CREATE_PRODUCT_MODEL, {
        name: vars.name,
        modifiedDate: new Date().toISOString(),
      });
      return data.createProductModel.ProductModelID;
    },
  });

// ─── Update/Create Product Description ───────────────────────────────────────

const UPDATE_PRODUCT_DESCRIPTION = gql`
  mutation UpdateProductDescription(
    $id: Int!
    $description: String!
    $modifiedDate: DateTime!
  ) {
    updateProductDescription(
      ProductDescriptionID: $id
      item: { Description: $description, ModifiedDate: $modifiedDate }
    ) {
      ProductDescriptionID
      Description
    }
  }
`;

const CREATE_PRODUCT_DESCRIPTION_MUTATION = gql`
  mutation CreateProductDescriptionMut(
    $description: String!
    $modifiedDate: DateTime!
  ) {
    createProductDescription(
      item: { Description: $description, ModifiedDate: $modifiedDate }
    ) {
      ProductDescriptionID
    }
  }
`;

const CREATE_PRODUCT_MODEL_CULTURE_LINK = gql`
  mutation CreateProductModelCultureLink(
    $productModelId: Int!
    $productDescriptionId: Int!
    $cultureId: String!
    $modifiedDate: DateTime!
  ) {
    createProductModelProductDescriptionCulture(
      item: {
        ProductModelID: $productModelId
        ProductDescriptionID: $productDescriptionId
        CultureID: $cultureId
        ModifiedDate: $modifiedDate
      }
    ) {
      ProductModelID
      ProductDescriptionID
      CultureID
    }
  }
`;

export const useUpdateProductDescription = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      productModelId: number;
      productDescriptionId: number | null;
      description: string;
    }) => {
      const modifiedDate = new Date().toISOString();
      if (vars.productDescriptionId) {
        await graphqlClient.request(UPDATE_PRODUCT_DESCRIPTION, {
          id: vars.productDescriptionId,
          description: vars.description,
          modifiedDate,
        });
        return vars.productDescriptionId;
      } else {
        const createResult = await graphqlClient.request<{
          createProductDescription: { ProductDescriptionID: number };
        }>(CREATE_PRODUCT_DESCRIPTION_MUTATION, {
          description: vars.description,
          modifiedDate,
        });
        const newId =
          createResult.createProductDescription.ProductDescriptionID;
        await graphqlClient.request(CREATE_PRODUCT_MODEL_CULTURE_LINK, {
          productModelId: vars.productModelId,
          productDescriptionId: newId,
          cultureId: "en",
          modifiedDate,
        });
        return newId;
      }
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({
        queryKey: ["admin", "description", "en", vars.productModelId],
      });
    },
  });
};

// ─── Create Product ───────────────────────────────────────────────────────────

const CREATE_PRODUCT_MUTATION = gql`
  mutation CreateProductMut(
    $name: String!
    $productNumber: String!
    $listPrice: Decimal!
    $standardCost: Decimal!
    $productSubcategoryId: Int!
    $safetyStockLevel: Short!
    $reorderPoint: Short!
    $daysToManufacture: Int!
    $sellStartDate: DateTime!
    $modifiedDate: DateTime!
    $color: String
    $size: String
    $weight: Decimal
    $productLine: String
    $class: String
    $style: String
    $productModelId: Int
  ) {
    createProduct(
      item: {
        Name: $name
        ProductNumber: $productNumber
        ListPrice: $listPrice
        StandardCost: $standardCost
        ProductSubcategoryID: $productSubcategoryId
        SafetyStockLevel: $safetyStockLevel
        ReorderPoint: $reorderPoint
        DaysToManufacture: $daysToManufacture
        FinishedGoodsFlag: true
        MakeFlag: false
        SellStartDate: $sellStartDate
        ModifiedDate: $modifiedDate
        Color: $color
        Size: $size
        Weight: $weight
        ProductLine: $productLine
        Class: $class
        Style: $style
        ProductModelID: $productModelId
      }
    ) {
      ProductID
      Name
      ProductModelID
    }
  }
`;

const CREATE_PRODUCT_INVENTORY = gql`
  mutation CreateProductInventory(
    $productId: Int!
    $quantity: Short
    $modifiedDate: DateTime!
  ) {
    createProductInventory(
      item: {
        ProductID: $productId
        LocationID: 1
        Shelf: "N/A"
        Bin: 0
        Quantity: $quantity
        ModifiedDate: $modifiedDate
      }
    ) {
      ProductID
      LocationID
      Quantity
    }
  }
`;

export interface CreateProductVars {
  Name: string;
  ProductNumber: string;
  ListPrice: number;
  StandardCost: number;
  ProductSubcategoryID: number;
  SafetyStockLevel?: number;
  ReorderPoint?: number;
  DaysToManufacture?: number;
  SellStartDate?: string;
  Color?: string | null;
  Size?: string | null;
  Weight?: number | null;
  ProductLine?: string | null;
  Class?: string | null;
  Style?: string | null;
  InitialQuantity?: number;
  Description?: string; // used to create ProductModel + description on creation
  ProductModelID?: number | null; // if already known (e.g. batch shares one model)
}

/** Internal helper: create a ProductModel + English description and return the model ID */
async function createProductModelWithDescription(
  name: string,
  description: string,
  modifiedDate: string,
): Promise<number> {
  const modelResult = await graphqlClient.request<{
    createProductModel: { ProductModelID: number };
  }>(CREATE_PRODUCT_MODEL, { name, modifiedDate });
  const productModelId = modelResult.createProductModel.ProductModelID;

  const descResult = await graphqlClient.request<{
    createProductDescription: { ProductDescriptionID: number };
  }>(CREATE_PRODUCT_DESCRIPTION_MUTATION, { description, modifiedDate });
  const descId = descResult.createProductDescription.ProductDescriptionID;

  await graphqlClient.request(CREATE_PRODUCT_MODEL_CULTURE_LINK, {
    productModelId,
    productDescriptionId: descId,
    cultureId: "en",
    modifiedDate,
  });

  return productModelId;
}

export const useCreateProduct = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: CreateProductVars) => {
      const modifiedDate = new Date().toISOString();

      // Auto-create a ProductModel so variants/description can be linked later
      let productModelId = vars.ProductModelID ?? null;
      if (!productModelId && vars.Description?.trim()) {
        productModelId = await createProductModelWithDescription(
          vars.Name,
          vars.Description,
          modifiedDate,
        );
      }

      const result = await graphqlClient.request<{
        createProduct: {
          ProductID: number;
          Name: string;
          ProductModelID: number | null;
        };
      }>(CREATE_PRODUCT_MUTATION, {
        name: vars.Name,
        productNumber: vars.ProductNumber,
        listPrice: vars.ListPrice,
        standardCost: vars.StandardCost,
        productSubcategoryId: vars.ProductSubcategoryID,
        safetyStockLevel: vars.SafetyStockLevel ?? 100,
        reorderPoint: vars.ReorderPoint ?? 75,
        daysToManufacture: vars.DaysToManufacture ?? 0,
        sellStartDate: vars.SellStartDate ?? modifiedDate,
        modifiedDate,
        color: vars.Color ?? null,
        size: vars.Size ?? null,
        weight: vars.Weight ?? null,
        productLine: vars.ProductLine ?? null,
        class: vars.Class ?? null,
        style: vars.Style ?? null,
        productModelId,
      });
      const productId = result.createProduct.ProductID;
      // Create an inventory record at the default location (ID=1)
      await graphqlClient.request(CREATE_PRODUCT_INVENTORY, {
        productId,
        quantity: vars.InitialQuantity ?? 0,
        modifiedDate,
      });
      return {
        ...result.createProduct,
        ProductModelID: result.createProduct.ProductModelID ?? productModelId,
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
    },
  });
};

// ─── Create Product Batch (for variation wizard) ──────────────────────────────

export interface BatchProgress {
  completed: number;
  total: number;
}

export const useCreateProductBatch = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      items,
      onProgress,
    }: {
      items: CreateProductVars[];
      onProgress?: (p: BatchProgress) => void;
    }) => {
      const results: Array<{ ProductID: number; Name: string }> = [];

      // Create one shared ProductModel for the whole batch so all variants
      // are properly grouped when displayed on the category page.
      let sharedModelId: number | null = null;
      const firstDescription = items[0]?.Description?.trim();
      if (items.length > 0 && firstDescription) {
        const modifiedDate = new Date().toISOString();
        sharedModelId = await createProductModelWithDescription(
          items[0].Name,
          firstDescription,
          modifiedDate,
        );
      }

      for (let i = 0; i < items.length; i++) {
        const vars = items[i];
        const modifiedDate = new Date().toISOString();
        const result = await graphqlClient.request<{
          createProduct: { ProductID: number; Name: string };
        }>(CREATE_PRODUCT_MUTATION, {
          name: vars.Name,
          productNumber: vars.ProductNumber,
          listPrice: vars.ListPrice,
          standardCost: vars.StandardCost,
          productSubcategoryId: vars.ProductSubcategoryID,
          safetyStockLevel: vars.SafetyStockLevel ?? 100,
          reorderPoint: vars.ReorderPoint ?? 75,
          daysToManufacture: vars.DaysToManufacture ?? 0,
          sellStartDate: vars.SellStartDate ?? modifiedDate,
          modifiedDate,
          color: vars.Color ?? null,
          size: vars.Size ?? null,
          weight: vars.Weight ?? null,
          productLine: vars.ProductLine ?? null,
          class: vars.Class ?? null,
          style: vars.Style ?? null,
          productModelId: sharedModelId,
        });
        const productId = result.createProduct.ProductID;
        await graphqlClient.request(CREATE_PRODUCT_INVENTORY, {
          productId,
          quantity: vars.InitialQuantity ?? 0,
          modifiedDate,
        });
        results.push(result.createProduct);
        onProgress?.({ completed: i + 1, total: items.length });
      }
      return { results, sharedModelId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
    },
  });
};

// ─── Category / Subcategory counts ────────────────────────────────────────────
// Used by Products landing page and Categories management page

export const useAdminProductCountsBySubcategory = (subcategoryIds: number[]) =>
  useQuery<Map<number, number>>({
    queryKey: ["admin", "productcounts", [...subcategoryIds].sort().join(",")],
    queryFn: async () => {
      if (subcategoryIds.length === 0) return new Map();
      const data = await graphqlClient.request<{
        products?: { items: Array<{ ProductSubcategoryID: number | null }> };
      }>(
        gql`
          query GetProductCountsBySubcat($ids: [Int!]!) {
            products(
              first: 1000
              filter: {
                and: [
                  { FinishedGoodsFlag: { eq: true } }
                  { ProductSubcategoryID: { in: $ids } }
                ]
              }
            ) {
              items {
                ProductSubcategoryID
              }
            }
          }
        `,
        { ids: subcategoryIds },
      );
      const map = new Map<number, number>();
      for (const p of data.products?.items ?? []) {
        if (p.ProductSubcategoryID != null) {
          map.set(
            p.ProductSubcategoryID,
            (map.get(p.ProductSubcategoryID) ?? 0) + 1,
          );
        }
      }
      return map;
    },
    enabled: subcategoryIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });

// ─── Product Inventory ────────────────────────────────────────────────────────

const GET_PRODUCT_INVENTORY = gql`
  query GetProductInventory($productId: Int!) {
    productInventories(filter: { ProductID: { eq: $productId } }) {
      items {
        ProductID
        LocationID
        Quantity
      }
    }
  }
`;

const UPDATE_PRODUCT_INVENTORY = gql`
  mutation UpdateProductInventory(
    $productId: Int!
    $locationId: Short!
    $quantity: Short
    $modifiedDate: DateTime!
  ) {
    updateProductInventory(
      ProductID: $productId
      LocationID: $locationId
      item: { Quantity: $quantity, ModifiedDate: $modifiedDate }
    ) {
      ProductID
      LocationID
      Quantity
    }
  }
`;

export interface ProductInventoryRecord {
  ProductID: number;
  LocationID: number;
  Quantity: number;
}

export const useProductInventory = (productId: number) =>
  useQuery<ProductInventoryRecord[]>({
    queryKey: ["admin", "inventory", productId],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        productInventories?: { items: ProductInventoryRecord[] };
      }>(GET_PRODUCT_INVENTORY, { productId });
      return data.productInventories?.items ?? [];
    },
    enabled: !!productId,
    staleTime: 2 * 60 * 1000,
  });

export const useUpdateProductInventory = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      productId: number;
      locationId: number;
      quantity: number;
    }) => {
      await graphqlClient.request(UPDATE_PRODUCT_INVENTORY, {
        productId: vars.productId,
        locationId: vars.locationId,
        quantity: vars.quantity,
        modifiedDate: new Date().toISOString(),
      });
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({
        queryKey: ["admin", "inventory", vars.productId],
      });
    },
  });
};

// ─── Delete Product (cascade) ─────────────────────────────────────────────────

const GET_REVIEWS_FOR_DELETE = gql`
  query GetReviewsForDelete($productId: Int!) {
    productReviews(filter: { ProductID: { eq: $productId } }) {
      items {
        ProductReviewID
      }
    }
  }
`;

const GET_REPLIES_FOR_DELETE = gql`
  query GetRepliesForDelete($reviewId: Int!) {
    productReviewReplies(filter: { ProductReviewID: { eq: $reviewId } }) {
      items {
        ProductReviewReplyID
      }
    }
  }
`;

const GET_PHOTO_LINKS_FOR_DELETE = gql`
  query GetPhotoLinksForDelete($productId: Int!) {
    productProductPhotos(filter: { ProductID: { eq: $productId } }) {
      items {
        ProductPhotoID
      }
    }
  }
`;

const GET_INVENTORY_FOR_DELETE = gql`
  query GetInventoryForDelete($productId: Int!) {
    productInventories(filter: { ProductID: { eq: $productId } }) {
      items {
        LocationID
      }
    }
  }
`;

const GET_SPECIAL_OFFERS_FOR_DELETE = gql`
  query GetSpecialOffersForDelete($productId: Int!) {
    specialOfferProducts(filter: { ProductID: { eq: $productId } }) {
      items {
        SpecialOfferID
      }
    }
  }
`;

const GET_COST_HISTORY_FOR_DELETE = gql`
  query GetCostHistoryForDelete($productId: Int!) {
    productCostHistories(filter: { ProductID: { eq: $productId } }) {
      items {
        StartDate
      }
    }
  }
`;

const GET_PRICE_HISTORY_FOR_DELETE = gql`
  query GetPriceHistoryForDelete($productId: Int!) {
    productListPriceHistories(filter: { ProductID: { eq: $productId } }) {
      items {
        StartDate
      }
    }
  }
`;

const GET_MODEL_CULTURES_FOR_DELETE = gql`
  query GetModelCulturesForDelete($modelId: Int!) {
    productModelProductDescriptionCultures(
      filter: { ProductModelID: { eq: $modelId } }
    ) {
      items {
        ProductDescriptionID
        CultureID
      }
    }
  }
`;

const DELETE_REVIEW_REPLY_MUT = gql`
  mutation DeleteReviewReplyMut($id: Int!) {
    deleteProductReviewReply(ProductReviewReplyID: $id) {
      ProductReviewReplyID
    }
  }
`;

const DELETE_REVIEW_MUT = gql`
  mutation DeleteReviewMut($id: Int!) {
    deleteProductReview(ProductReviewID: $id) {
      ProductReviewID
    }
  }
`;

const DELETE_INVENTORY_MUT = gql`
  mutation DeleteInventoryMut($productId: Int!, $locationId: Short!) {
    deleteProductInventory(ProductID: $productId, LocationID: $locationId) {
      ProductID
    }
  }
`;

const DELETE_SPECIAL_OFFER_PRODUCT_MUT = gql`
  mutation DeleteSpecialOfferProductMut(
    $specialOfferId: Int!
    $productId: Int!
  ) {
    deleteSpecialOfferProduct(
      SpecialOfferID: $specialOfferId
      ProductID: $productId
    ) {
      SpecialOfferID
    }
  }
`;

const DELETE_COST_HISTORY_MUT = gql`
  mutation DeleteCostHistoryMut($productId: Int!, $startDate: DateTime!) {
    deleteProductCostHistory(ProductID: $productId, StartDate: $startDate) {
      ProductID
    }
  }
`;

const DELETE_PRICE_HISTORY_MUT = gql`
  mutation DeletePriceHistoryMut($productId: Int!, $startDate: DateTime!) {
    deleteProductListPriceHistory(
      ProductID: $productId
      StartDate: $startDate
    ) {
      ProductID
    }
  }
`;

const DELETE_PRODUCT_MUT = gql`
  mutation DeleteProductMut($productId: Int!) {
    deleteProduct(ProductID: $productId) {
      ProductID
    }
  }
`;

const DELETE_MODEL_CULTURE_LINK_MUT = gql`
  mutation DeleteModelCultureLinkMut(
    $modelId: Int!
    $descId: Int!
    $cultureId: String!
  ) {
    deleteProductModelProductDescriptionCulture(
      ProductModelID: $modelId
      ProductDescriptionID: $descId
      CultureID: $cultureId
    ) {
      ProductModelID
    }
  }
`;

const DELETE_PRODUCT_DESCRIPTION_MUT = gql`
  mutation DeleteProductDescriptionMut($id: Int!) {
    deleteProductDescription(ProductDescriptionID: $id) {
      ProductDescriptionID
    }
  }
`;

const DELETE_PRODUCT_MODEL_MUT = gql`
  mutation DeleteProductModelMut($id: Int!) {
    deleteProductModel(ProductModelID: $id) {
      ProductModelID
    }
  }
`;

/**
 * Cascade-delete a single product: reviews, replies, photo links, inventory,
 * special offers, cost/price history, then the product row itself.
 */
async function deleteProductCascade(productId: number): Promise<void> {
  // 1. Reviews + replies
  const reviewsRes = await graphqlClient.request<{
    productReviews?: { items: { ProductReviewID: number }[] };
  }>(GET_REVIEWS_FOR_DELETE, { productId });
  for (const review of reviewsRes.productReviews?.items ?? []) {
    const repliesRes = await graphqlClient.request<{
      productReviewReplies?: { items: { ProductReviewReplyID: number }[] };
    }>(GET_REPLIES_FOR_DELETE, { reviewId: review.ProductReviewID });
    for (const reply of repliesRes.productReviewReplies?.items ?? []) {
      await graphqlClient.request(DELETE_REVIEW_REPLY_MUT, {
        id: reply.ProductReviewReplyID,
      });
    }
    await graphqlClient.request(DELETE_REVIEW_MUT, {
      id: review.ProductReviewID,
    });
  }

  // 2. Photo links (join table only — actual photo rows may be shared)
  const photosRes = await graphqlClient.request<{
    productProductPhotos?: { items: { ProductPhotoID: number }[] };
  }>(GET_PHOTO_LINKS_FOR_DELETE, { productId });
  for (const photo of photosRes.productProductPhotos?.items ?? []) {
    await graphqlClient.request(DELETE_PRODUCT_PRODUCT_PHOTO, {
      productId,
      photoId: photo.ProductPhotoID,
    });
  }

  // 3. Inventory
  const inventoryRes = await graphqlClient.request<{
    productInventories?: { items: { LocationID: number }[] };
  }>(GET_INVENTORY_FOR_DELETE, { productId });
  for (const inv of inventoryRes.productInventories?.items ?? []) {
    await graphqlClient.request(DELETE_INVENTORY_MUT, {
      productId,
      locationId: inv.LocationID,
    });
  }

  // 4. Special offer products
  const sofpRes = await graphqlClient.request<{
    specialOfferProducts?: { items: { SpecialOfferID: number }[] };
  }>(GET_SPECIAL_OFFERS_FOR_DELETE, { productId });
  for (const sofp of sofpRes.specialOfferProducts?.items ?? []) {
    await graphqlClient.request(DELETE_SPECIAL_OFFER_PRODUCT_MUT, {
      specialOfferId: sofp.SpecialOfferID,
      productId,
    });
  }

  // 5. Cost history
  const costRes = await graphqlClient.request<{
    productCostHistories?: { items: { StartDate: string }[] };
  }>(GET_COST_HISTORY_FOR_DELETE, { productId });
  for (const cost of costRes.productCostHistories?.items ?? []) {
    await graphqlClient.request(DELETE_COST_HISTORY_MUT, {
      productId,
      startDate: cost.StartDate,
    });
  }

  // 6. Price history
  const priceRes = await graphqlClient.request<{
    productListPriceHistories?: { items: { StartDate: string }[] };
  }>(GET_PRICE_HISTORY_FOR_DELETE, { productId });
  for (const price of priceRes.productListPriceHistories?.items ?? []) {
    await graphqlClient.request(DELETE_PRICE_HISTORY_MUT, {
      productId,
      startDate: price.StartDate,
    });
  }

  // 7. Product row
  await graphqlClient.request(DELETE_PRODUCT_MUT, { productId });
}

/**
 * Cascade-delete a full product group: all variant products, then the shared
 * ProductModel and its descriptions.
 */
async function deleteProductGroupCascade(
  productModelId: number,
  productIds: number[],
): Promise<void> {
  for (const productId of productIds) {
    await deleteProductCascade(productId);
  }
  // Model descriptions + culture links
  const culturesRes = await graphqlClient.request<{
    productModelProductDescriptionCultures?: {
      items: { ProductDescriptionID: number; CultureID: string }[];
    };
  }>(GET_MODEL_CULTURES_FOR_DELETE, { modelId: productModelId });
  for (const cult of culturesRes.productModelProductDescriptionCultures
    ?.items ?? []) {
    await graphqlClient.request(DELETE_MODEL_CULTURE_LINK_MUT, {
      modelId: productModelId,
      descId: cult.ProductDescriptionID,
      cultureId: cult.CultureID,
    });
    await graphqlClient.request(DELETE_PRODUCT_DESCRIPTION_MUT, {
      id: cult.ProductDescriptionID,
    });
  }
  await graphqlClient.request(DELETE_PRODUCT_MODEL_MUT, {
    id: productModelId,
  });
}

export const useDeleteProduct = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (productId: number) => deleteProductCascade(productId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
    },
  });
};

export const useDeleteProductGroup = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      productModelId,
      productIds,
    }: {
      productModelId: number;
      productIds: number[];
    }) => deleteProductGroupCascade(productModelId, productIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
    },
  });
};
