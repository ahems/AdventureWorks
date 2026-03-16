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
          LargePhoto
          LargePhotoFileName
          ModifiedDate
        }
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
    staleTime: 5 * 60 * 1000,
  });

const CREATE_PRODUCT_PHOTO = gql`
  mutation CreateProductPhoto(
    $thumbNail: String
    $thumbFilename: String
    $largePhoto: String
    $largeFilename: String
    $modifiedDate: String!
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
    $modifiedDate: String!
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
