import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { graphqlClient } from "@/lib/graphql-client";
import { gql } from "graphql-request";
import { Culture } from "@/types/culture";
import { Currency, CurrencyRate } from "@/types/currency";
import { ShoppingCartItem, StaleCart } from "@/types/shoppingCart";

// ─── Cultures ─────────────────────────────────────────────────────────────────

const GET_CULTURES_ADMIN = gql`
  query GetCulturesAdmin {
    cultures(first: 1000, orderBy: { Name: ASC }) {
      items {
        CultureID
        Name
        ModifiedDate
      }
    }
  }
`;

export const useAdminCultures = () =>
  useQuery<Culture[]>({
    queryKey: ["admin", "cultures"],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        cultures?: { items: Culture[] };
      }>(GET_CULTURES_ADMIN);
      return data.cultures?.items ?? [];
    },
    staleTime: 10 * 60 * 1000,
  });

// ─── Currencies ───────────────────────────────────────────────────────────────

const GET_CURRENCIES_ADMIN = gql`
  query GetCurrenciesAdmin {
    currencies(first: 1000, orderBy: { Name: ASC }) {
      items {
        CurrencyCode
        Name
        ModifiedDate
      }
    }
  }
`;

const GET_CURRENCY_RATES_ADMIN = gql`
  query GetCurrencyRatesAdmin($after: String) {
    currencyRates(
      first: 100
      after: $after
      orderBy: { CurrencyRateDate: DESC }
    ) {
      items {
        CurrencyRateID
        CurrencyRateDate
        FromCurrencyCode
        ToCurrencyCode
        AverageRate
        EndOfDayRate
        ModifiedDate
      }
      hasNextPage
      endCursor
    }
  }
`;

export const useAdminCurrencies = () =>
  useQuery<Currency[]>({
    queryKey: ["admin", "currencies"],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        currencies?: { items: Currency[] };
      }>(GET_CURRENCIES_ADMIN);
      return data.currencies?.items ?? [];
    },
    staleTime: 10 * 60 * 1000,
  });

export interface PagedCurrencyRates {
  items: CurrencyRate[];
  hasNextPage: boolean;
  endCursor: string;
}

export const useAdminCurrencyRates = (after?: string | null) =>
  useQuery<PagedCurrencyRates>({
    queryKey: ["admin", "currencyRates", after ?? null],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        currencyRates?: {
          items: CurrencyRate[];
          hasNextPage?: boolean;
          endCursor?: string;
        };
      }>(GET_CURRENCY_RATES_ADMIN, { after: after ?? null });
      return {
        items: data.currencyRates?.items ?? [],
        hasNextPage: data.currencyRates?.hasNextPage ?? false,
        endCursor: data.currencyRates?.endCursor ?? "",
      };
    },
    staleTime: 5 * 60 * 1000,
  });

// ─── Shopping Carts ───────────────────────────────────────────────────────────

const GET_SHOPPING_CARTS_ADMIN = gql`
  query GetShoppingCartsAdmin {
    shoppingCartItems(first: 1000, orderBy: { ModifiedDate: ASC }) {
      items {
        ShoppingCartItemID
        ShoppingCartID
        Quantity
        ProductID
        DateCreated
        ModifiedDate
      }
    }
  }
`;

/** Group ShoppingCartItems by cart ID and build StaleCart objects. */
const groupIntoCarts = (items: ShoppingCartItem[]): StaleCart[] => {
  const now = Date.now();
  const cartMap = new Map<string, ShoppingCartItem[]>();

  for (const item of items) {
    const list = cartMap.get(item.ShoppingCartID) ?? [];
    list.push(item);
    cartMap.set(item.ShoppingCartID, list);
  }

  const carts: StaleCart[] = [];
  for (const [cartId, cartItems] of cartMap.entries()) {
    const lastActivity = cartItems.reduce((latest, i) => {
      const d = new Date(i.ModifiedDate).getTime();
      return d > latest ? d : latest;
    }, 0);
    const daysStale = Math.floor((now - lastActivity) / (1000 * 60 * 60 * 24));
    const totalItems = cartItems.reduce((sum, i) => sum + i.Quantity, 0);

    carts.push({
      ShoppingCartID: cartId,
      customerEmail: "",
      customerName: cartId,
      items: cartItems,
      totalItems,
      totalValue: 0, // Price lookup would require product join
      lastActivity: new Date(lastActivity).toISOString(),
      daysStale,
    });
  }

  // Sort by lastActivity ascending (most stale first)
  return carts.sort((a, b) => a.daysStale - b.daysStale);
};

export const useAdminShoppingCarts = () =>
  useQuery<StaleCart[]>({
    queryKey: ["admin", "shoppingCarts"],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        shoppingCartItems?: { items: ShoppingCartItem[] };
      }>(GET_SHOPPING_CARTS_ADMIN);
      const items: ShoppingCartItem[] = data.shoppingCartItems?.items ?? [];
      return groupIntoCarts(items);
    },
    staleTime: 2 * 60 * 1000,
  });

// ─── Product Localization (cultures × product models) ─────────────────────────

const GET_LOCALIZATION_COUNTS = gql`
  query GetLocalizationCounts {
    productModelProductDescriptionCultures(first: 1000) {
      items {
        CultureID
      }
    }
  }
`;

/** Returns a map of CultureID → number of localized product descriptions. */
export const useAdminLocalizationCounts = () =>
  useQuery<Record<string, number>>({
    queryKey: ["admin", "localizationCounts"],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        productModelProductDescriptionCultures?: {
          items: { CultureID: string }[];
        };
      }>(GET_LOCALIZATION_COUNTS);
      const counts: Record<string, number> = {};
      for (const item of data.productModelProductDescriptionCultures?.items ??
        []) {
        counts[item.CultureID] = (counts[item.CultureID] ?? 0) + 1;
      }
      return counts;
    },
    staleTime: 10 * 60 * 1000,
  });

const GET_PRODUCT_MODELS_ADMIN = gql`
  query GetProductModelsAdmin {
    productModels(first: 1000, orderBy: { Name: ASC }) {
      items {
        ProductModelID
        Name
      }
    }
  }
`;

export interface AdminProductModel {
  ProductModelID: number;
  Name: string;
}

export const useAdminProductModels = () =>
  useQuery<AdminProductModel[]>({
    queryKey: ["admin", "productModels"],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        productModels?: { items: AdminProductModel[] };
      }>(GET_PRODUCT_MODELS_ADMIN);
      return data.productModels?.items ?? [];
    },
    staleTime: 10 * 60 * 1000,
  });

const GET_LOCALIZATIONS_FOR_CULTURE = gql`
  query GetLocalizationsForCulture($cultureId: String!) {
    productModelProductDescriptionCultures(
      first: 1000
      filter: { CultureID: { eq: $cultureId } }
    ) {
      items {
        ProductModelID
        ProductDescriptionID
        CultureID
        ModifiedDate
      }
    }
  }
`;

export interface LocalizationLink {
  ProductModelID: number;
  ProductDescriptionID: number;
  CultureID: string;
  ModifiedDate: string;
}

export const useAdminLocalizationsForCulture = (cultureId: string | null) =>
  useQuery<LocalizationLink[]>({
    queryKey: ["admin", "localizations", cultureId],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        productModelProductDescriptionCultures?: { items: LocalizationLink[] };
      }>(GET_LOCALIZATIONS_FOR_CULTURE, { cultureId });
      return data.productModelProductDescriptionCultures?.items ?? [];
    },
    enabled: !!cultureId,
    staleTime: 5 * 60 * 1000,
  });

// ─── ProductDescription CRUD ───────────────────────────────────────────────

const GET_PRODUCT_DESCRIPTIONS_BY_IDS = gql`
  query GetProductDescriptionsByIds($ids: [Int]) {
    productDescriptions(
      first: 1000
      filter: { ProductDescriptionID: { in: $ids } }
    ) {
      items {
        ProductDescriptionID
        Description
        ModifiedDate
      }
    }
  }
`;

export interface AdminProductDescription {
  ProductDescriptionID: number;
  Description: string;
  ModifiedDate: string;
}

export const useProductDescriptionsByIds = (ids: number[]) =>
  useQuery<AdminProductDescription[]>({
    queryKey: ["admin", "productDescriptions", ids],
    queryFn: async () => {
      const data = await graphqlClient.request<{
        productDescriptions?: { items: AdminProductDescription[] };
      }>(GET_PRODUCT_DESCRIPTIONS_BY_IDS, { ids });
      return data.productDescriptions?.items ?? [];
    },
    enabled: ids.length > 0,
    staleTime: 5 * 60 * 1000,
  });

const CREATE_PRODUCT_DESCRIPTION = gql`
  mutation CreateProductDescription(
    $description: String!
    $modifiedDate: String!
  ) {
    createProductDescription(
      item: { Description: $description, ModifiedDate: $modifiedDate }
    ) {
      ProductDescriptionID
    }
  }
`;

const CREATE_LOCALIZATION_LINK = gql`
  mutation CreateLocalizationLink(
    $productModelId: Int!
    $productDescriptionId: Int!
    $cultureId: String!
    $modifiedDate: String!
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

const DELETE_LOCALIZATION_LINK = gql`
  mutation DeleteLocalizationLink(
    $productModelId: Int!
    $productDescriptionId: Int!
    $cultureId: String!
  ) {
    deleteProductModelProductDescriptionCulture(
      ProductModelID: $productModelId
      ProductDescriptionID: $productDescriptionId
      CultureID: $cultureId
    ) {
      ProductModelID
    }
  }
`;

const UPDATE_PRODUCT_DESCRIPTION = gql`
  mutation UpdateProductDescription(
    $productDescriptionId: Int!
    $description: String!
    $modifiedDate: String!
  ) {
    updateProductDescription(
      ProductDescriptionID: $productDescriptionId
      item: { Description: $description, ModifiedDate: $modifiedDate }
    ) {
      ProductDescriptionID
      Description
    }
  }
`;

export const useCreateLocalization = (cultureId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      productModelId: number;
      description: string;
    }) => {
      const modifiedDate = new Date().toISOString();

      // 1. Create the description record
      const descResult = await graphqlClient.request<{
        createProductDescription: { ProductDescriptionID: number };
      }>(CREATE_PRODUCT_DESCRIPTION, {
        description: vars.description,
        modifiedDate,
      });
      const productDescriptionId =
        descResult.createProductDescription.ProductDescriptionID;

      // 2. Link to the product model + culture
      await graphqlClient.request(CREATE_LOCALIZATION_LINK, {
        productModelId: vars.productModelId,
        productDescriptionId,
        cultureId,
        modifiedDate,
      });

      return productDescriptionId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["admin", "localizations", cultureId],
      });
      queryClient.invalidateQueries({
        queryKey: ["admin", "productDescriptions"],
      });
    },
  });
};

export const useDeleteLocalizationLink = (cultureId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      productModelId: number;
      productDescriptionId: number;
    }) => {
      await graphqlClient.request(DELETE_LOCALIZATION_LINK, {
        productModelId: vars.productModelId,
        productDescriptionId: vars.productDescriptionId,
        cultureId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["admin", "localizations", cultureId],
      });
    },
  });
};

export const useUpdateProductDescription = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      productDescriptionId: number;
      description: string;
    }) => {
      await graphqlClient.request(UPDATE_PRODUCT_DESCRIPTION, {
        productDescriptionId: vars.productDescriptionId,
        description: vars.description,
        modifiedDate: new Date().toISOString(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["admin", "productDescriptions"],
      });
    },
  });
};
